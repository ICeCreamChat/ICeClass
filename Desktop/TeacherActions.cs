using System.Text.Json;
using System.Text.Json.Serialization;

namespace ICeClass.Desktop;

internal sealed record TeacherAction(string Id, string Title, bool Confirmation, string Impact,
    Func<TeacherActionContext, Task<TeacherActionResult>> Execute);

// Identity is an opaque, current login proof. It never leaves the native process.
internal sealed record TeacherActionContext(string ClientId, string Identity);

internal sealed record TeacherActionResult(bool Success, bool Verified, string Detail, string State,
    string? Code = null, bool? UpdateAvailable = null, string? Version = null)
{
    private Action? _afterReply;
    internal Action? AfterReply { init => _afterReply = value; }
    internal void ReplyScheduled() => Interlocked.Exchange(ref _afterReply, null)?.Invoke();
    internal static TeacherActionResult Refused(string code, string detail) => new(false, false, detail, "rejected", code);
    internal static TeacherActionResult Opened(string detail) => new(true, true, detail, "opened");
}

internal sealed record TeacherActionReply(string RequestId, string ClientId, object Result)
{
    public string Type => "iceclass-teacher-action-result";
}

/// <summary>Window-local allowlist and receipts. No persistence, retries, or receipt eviction.</summary>
internal sealed class TeacherActions
{
    internal const int MaximumOperations = 256;
    internal const int MaximumMessageLength = 8192;
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private readonly string _endpoint;
    private readonly Func<Task<TeacherActionContext?>> _readContext;
    private readonly Dictionary<string, TeacherAction> _actions;
    private readonly Dictionary<string, Execution> _executions = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private int _document;
    private bool _closed;

    internal TeacherActions(string endpoint, Func<Task<TeacherActionContext?>> readContext, params TeacherAction[] actions)
    {
        _endpoint = DesktopSettings.NormalizeEndpoint(endpoint);
        _readContext = readContext;
        _actions = actions.ToDictionary(action => action.Id, StringComparer.Ordinal);
    }

    internal void InvalidateDocument(bool closed = false)
    {
        lock (_gate) { _document++; _closed |= closed; }
    }

    internal static bool IsMessage(string message)
    {
        // Oversized messages must not fall through to diagnostic logging.
        if (message.Length > MaximumMessageLength) return true;
        try
        {
            using var document = JsonDocument.Parse(message, new JsonDocumentOptions { MaxDepth = 12 });
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                Text(document.RootElement, "type") == "iceclass-teacher-action";
        }
        catch (JsonException) { return false; }
    }

    internal async Task<TeacherActionReply?> HandleAsync(string message, string source, string currentSource, bool mainFrame)
    {
        if (message.Length > MaximumMessageLength) return null;
        string requestId, clientId, method, action, operationId;
        bool validFields;
        try
        {
            using var document = JsonDocument.Parse(message, new JsonDocumentOptions { MaxDepth = 12 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Text(root, "type") != "iceclass-teacher-action") return null;
            requestId = Text(root, "requestId"); clientId = Text(root, "clientId");
            if (!Guid.TryParseExact(requestId, "D", out _) || !Guid.TryParseExact(clientId, "D", out _)) return null;
            method = Text(root, "method"); action = Text(root, "action"); operationId = Text(root, "operationId");
            validFields = root.TryGetProperty("payload", out var payload) && payload.ValueKind == JsonValueKind.Object &&
                !payload.EnumerateObject().Any();
            var allowed = method == "catalog"
                ? new[] { "type", "requestId", "clientId", "method" }
                : new[] { "type", "requestId", "clientId", "method", "action", "payload", "operationId" };
            if (root.EnumerateObject().Any(property => !allowed.Contains(property.Name)) ||
                root.EnumerateObject().Select(property => property.Name).Distinct().Count() != root.EnumerateObject().Count())
                return Reply(TeacherActionResult.Refused("invalid-request", "本机操作请求格式无效。"));
        }
        catch (JsonException) { return null; }

        TeacherActionReply Reply(object value) => new(requestId, clientId, value);
        TeacherActionReply Unavailable(string code, string detail) => method == "catalog"
            ? Reply(new { clientId, actions = Array.Empty<object>(), detail, code })
            : Reply(TeacherActionResult.Refused(code, detail));

        if (!TrustedSource(_endpoint, source, currentSource, mainFrame))
            return Unavailable("untrusted-source", "仅当前学校平台的主页面可以操作教师端。");
        int documentVersion;
        lock (_gate) { if (_closed) return Unavailable("closed", "教师端窗口已关闭。"); documentVersion = _document; }
        TeacherActionContext? context;
        try { context = await _readContext(); }
        catch (Exception) { return Unavailable("session-unavailable", "暂时无法核实登录，请确认已登录并检查学校平台连接。"); }
        lock (_gate)
        {
            if (_closed || documentVersion != _document) return Unavailable("document-changed", "页面已变化，本次本机操作未执行。");
        }
        if (context is null || string.IsNullOrEmpty(context.Identity))
            return Unavailable("sign-in-required", "请先登录当前教师工作台。");
        if (context.ClientId != clientId)
            return Unavailable("document-changed", "页面已变化，本次本机操作未执行。");
        if (method == "catalog")
            return Reply(new { clientId, actions = _actions.Values.Select(item => new {
                item.Id, item.Title, fields = Array.Empty<string>(), item.Confirmation, item.Impact }).ToArray() });
        if (method is not ("execute" or "receipt")) return Reply(TeacherActionResult.Refused("unknown-method", "不支持此本机操作请求。"));
        if (!_actions.TryGetValue(action, out var registered))
            return Reply(TeacherActionResult.Refused("unknown-action", "教师端未注册此操作。"));
        if (!validFields) return Reply(TeacherActionResult.Refused("invalid-fields", "此本机操作仅接受空对象参数。"));
        if (!ValidOperationId(operationId)) return Reply(TeacherActionResult.Refused("invalid-operation-id", "本机操作编号无效。"));

        Execution execution;
        var start = false;
        lock (_gate)
        {
            if (_closed || documentVersion != _document) return Unavailable("document-changed", "页面已变化，本次本机操作未执行。");
            if (_executions.TryGetValue(operationId, out var previous))
            {
                if (previous.Action != action || previous.ClientId != clientId || previous.Identity != context.Identity)
                    return Reply(TeacherActionResult.Refused("operation-conflict", "此操作编号已在另一请求中使用，不能重新执行。"));
                execution = previous;
            }
            else
            {
                if (method == "receipt") return Reply(TeacherActionResult.Refused("receipt-missing", "此窗口没有该操作的回执，未重新执行。"));
                if (_executions.Count >= MaximumOperations)
                    return Reply(TeacherActionResult.Refused("operation-limit", "此窗口的本机操作记录已满，请保存内容后重新打开窗口。"));
                execution = new(action, clientId, context.Identity);
                _executions.Add(operationId, execution); start = true;
            }
        }
        if (start) _ = CompleteAsync(registered, execution, context);
        return Reply(await execution.Completion.Task);
    }

    private static async Task CompleteAsync(TeacherAction action, Execution execution, TeacherActionContext context)
    {
        TeacherActionResult result;
        try { result = await action.Execute(context); }
        catch (Exception) { result = TeacherActionResult.Refused("action-failed", "本机操作未能确认完成，请检查教师端窗口。请勿自动重试。"); }
        execution.Completion.TrySetResult(result);
    }

    internal static bool TrustedSource(string endpoint, string source, string currentSource, bool mainFrame) =>
        mainFrame && DesktopSettings.SameOrigin(endpoint, source) && DesktopSettings.SameOrigin(endpoint, currentSource) &&
        new Uri(source).GetComponents(UriComponents.HttpRequestUrl, UriFormat.UriEscaped) ==
        new Uri(currentSource).GetComponents(UriComponents.HttpRequestUrl, UriFormat.UriEscaped);

    internal static bool ValidOperationId(string value) => value.Length is > 0 and <= 128 &&
        value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':');
    private static string Text(JsonElement value, string name) => value.TryGetProperty(name, out var property) &&
        property.ValueKind == JsonValueKind.String ? property.GetString()! : "";

    private sealed record Execution(string Action, string ClientId, string Identity)
    {
        internal TaskCompletionSource<TeacherActionResult> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}

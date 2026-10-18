using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

internal sealed class ReadingOfflineService : IDisposable
{
    private static ReadingOfflineService? _current;
    private static readonly object Registry = new();
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    private readonly ReceiverConfig _config;
    private readonly ReadingOutbox _outbox;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private JsonObject? _context;
    private long _anchor, _anchoredAt = Stopwatch.GetTimestamp();
    private bool _online, _revoked;
    private string _error = "";
    private readonly Dictionary<string, (string ContextId, string ClassId)> _sessions = new();

    private ReadingOfflineService(ReceiverConfig config)
    {
        _config = new ReceiverConfig { Endpoint = config.Endpoint, DeviceId = config.DeviceId, DeviceToken = config.DeviceToken, ClassId = config.ClassId, ClassName = config.ClassName };
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "ReadingData",
            Uri.EscapeDataString(config.Endpoint.TrimEnd('/').ToLowerInvariant()), Uri.EscapeDataString(config.DeviceId));
        _outbox = ReadingOutbox.Open(root);
        _anchor = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            var saved = _outbox.LoadContext();
            if (saved is not null)
            {
                var data = JsonNode.Parse(saved)!.AsObject();
                if (data["classId"]?.GetValue<string>() == config.ClassId)
                {
                    _context = data;
                    _anchor += data["serverTime"]!.GetValue<long>() - data["savedAt"]!.GetValue<long>();
                    _revoked = data["revoked"]?.GetValue<bool>() ?? false;
                }
            }
        }
        catch (Exception error) { AppLog.Error("Read offline classroom context failed", error); }
        _ = Task.Run(() => RunAsync(_lifetime.Token));
    }

    public static ReadingOfflineService For(ReceiverConfig config)
    {
        lock (Registry)
        {
            if (_current is not null && _current._config.Endpoint == config.Endpoint && _current._config.DeviceId == config.DeviceId &&
                _current._config.DeviceToken == config.DeviceToken && _current._config.ClassId == config.ClassId) return _current;
            _current?.Dispose();
            return _current = new ReadingOfflineService(config);
        }
    }
    public static void Stop() { lock (Registry) { _current?.Dispose(); _current = null; } }
    public void Dispose() => _lifetime.Cancel();
    public long Now { get { lock (_gate) return _anchor + (long)Stopwatch.GetElapsedTime(_anchoredAt).TotalMilliseconds; } }
    public JsonObject Snapshot()
    {
        lock (_gate)
        {
            var data = _context?.DeepClone().AsObject() ?? new JsonObject
            {
                ["classId"] = _config.ClassId, ["className"] = _config.ClassName,
                ["config"] = JsonNode.Parse("{\"enabled\":false,\"reminderEnabled\":false,\"threshold\":30,\"periods\":[],\"classic\":{\"duration\":15,\"targetCount\":10},\"rocket\":{\"duration\":15,\"targetCount\":10},\"carving\":{\"speed\":1},\"particle\":{\"speed\":1}}")
            };
            data["serverTime"] = Now;
            data["online"] = _online; data["revoked"] = _revoked;
            data["pendingCount"] = _outbox.Pending; data["reviewCount"] = _outbox.ReviewCount;
            data["hasRules"] = _context is not null;
            data["error"] = _error;
            return data;
        }
    }

    public void Store(JsonObject payload)
    {
        var sid = payload["sessionId"]?.GetValue<string>() ?? "";
        var mode = payload["mode"]?.GetValue<string>() ?? "";
        if (!Guid.TryParseExact(sid, "D", out _) || mode is not ("classic" or "carving" or "particle" or "rocket") ||
            payload["samples"] is not JsonArray samples || samples.Count > 90 || payload["events"] is not JsonArray events || events.Count > 100)
            throw new InvalidDataException("活动记录格式无效。");
        lock (_gate)
        {
            if (!_sessions.TryGetValue(sid, out var binding))
            {
                binding = (_context?["contextId"]?.GetValue<string>() ?? "", _config.ClassId);
                _sessions.Add(sid, binding);
            }
            payload["contextId"] = binding.ContextId; payload["classId"] = binding.ClassId;
        }
        _outbox.Store(payload);
    }

    private HttpRequestMessage Request(HttpMethod method, string path, JsonNode? body = null)
    {
        var request = new HttpRequestMessage(method, _config.Endpoint.TrimEnd('/') + "/api/reading/offline/" + path + "?deviceId=" + Uri.EscapeDataString(_config.DeviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.DeviceToken);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return request;
    }

    private async Task<JsonObject> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        using (request)
        using (var response = await Http.SendAsync(request, token))
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                lock (_gate)
                {
                    _revoked = true;
                    if (_context is not null) { _context["revoked"] = true; _outbox.SaveContext(_context.ToJsonString()); }
                }
                throw new InvalidOperationException("教室绑定已停用，记录保留在本机。");
            }
            response.EnsureSuccessStatusCode();
            return JsonNode.Parse(await response.Content.ReadAsStringAsync(token))!.AsObject();
        }
    }

    private async Task RunAsync(CancellationToken token)
    {
        var retry = 2;
        long refreshedAt = 0;
        while (!token.IsCancellationRequested)
        {
            try
            {
                if (refreshedAt == 0 || Stopwatch.GetElapsedTime(refreshedAt).TotalSeconds >= 15)
                {
                    var fresh = await SendAsync(Request(HttpMethod.Get, "context"), token);
                    if (fresh["classId"]?.GetValue<string>() != _config.ClassId)
                        throw new InvalidOperationException("班级已调整，等待教室绑定信息同步。");
                    if (!Guid.TryParse(fresh["contextId"]?.GetValue<string>(), out _) || fresh["config"] is not JsonObject)
                        throw new InvalidDataException("平台尚未支持离线统计，请升级服务器。");
                    lock (_gate)
                    {
                        fresh["savedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        _outbox.SaveContext(fresh.ToJsonString());
                        _context = fresh; _anchor = fresh["serverTime"]!.GetValue<long>(); _anchoredAt = Stopwatch.GetTimestamp();
                    }
                    refreshedAt = Stopwatch.GetTimestamp();
                }
                JsonObject context;
                lock (_gate) context = _context!.DeepClone().AsObject();
                var batches = _outbox.Peek();
                foreach (var batch in batches.Where(b => string.IsNullOrEmpty(b["contextId"]?.GetValue<string>())))
                {
                    if (batch["classId"]?.GetValue<string>() == _config.ClassId) batch["contextId"] = context["contextId"]!.DeepClone();
                }
                var count = _outbox.Pending;
                var response = await SendAsync(Request(HttpMethod.Post, "sync", new JsonObject
                {
                    ["batches"] = new JsonArray(batches.Select(b => (JsonNode)b).ToArray()),
                    ["pendingCount"] = count, ["reviewCount"] = _outbox.ReviewCount
                }), token);
                var sent = batches.Select(b => b["id"]!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
                if (response["acknowledged"] is not JsonArray ack || response["rejected"] is not JsonArray rejected)
                    throw new InvalidDataException("平台未确认收到统计，记录继续保留。");
                _outbox.Acknowledge(ack.Select(x => x!.GetValue<string>()).Where(sent.Contains));
                foreach (var item in rejected.OfType<JsonObject>())
                {
                    var id = item["id"]?.GetValue<string>() ?? "";
                    if (sent.Contains(id)) _outbox.MoveToReview(id, item["reason"]?.GetValue<string>() ?? "请管理员核实记录。");
                }
                lock (_gate) { _online = true; _revoked = false; _error = ""; }
                retry = 2;
                await Task.Delay(count > batches.Count ? Random.Shared.Next(500, 1500) : 5000, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                lock (_gate) { _online = false; _error = error.Message; }
                refreshedAt = 0;
                try { await Task.Delay(TimeSpan.FromSeconds(retry + Random.Shared.NextDouble() * 2), token); }
                catch (OperationCanceledException) { break; }
                retry = Math.Min(60, retry * 2);
            }
        }
    }
}

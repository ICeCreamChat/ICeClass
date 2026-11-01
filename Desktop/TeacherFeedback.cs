using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ICeClass.Desktop;

internal sealed record FeedbackAccount(string Session, string Csrf, string Username, string DisplayName);
internal sealed record FeedbackReport(string Description, string Contact, string Version, string System,
    string Scaling, string OccurredAt, string Page);
internal sealed record FeedbackImage(string Name, string ContentType, byte[] Bytes)
{
    internal const int MaximumBytes = 2 * 1024 * 1024;
    internal const int MaximumTotalBytes = 3 * 1024 * 1024;
    internal const int MaximumCount = 3;

    internal static FeedbackImage Create(string name, byte[] bytes)
    {
        if (bytes.Length > MaximumBytes) throw new InvalidDataException("每张截图最多 2 MB。");
        string mime;
        if (bytes.Length >= 45 && bytes.AsSpan(0, 8).SequenceEqual(new byte[] {137,80,78,71,13,10,26,10})
            && bytes.AsSpan(12, 4).SequenceEqual("IHDR"u8) && bytes.AsSpan(bytes.Length - 8, 4).SequenceEqual("IEND"u8)) mime = "image/png";
        else if (bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 && bytes[^2] == 255 && bytes[^1] == 217) mime = "image/jpeg";
        else if (bytes.Length >= 16 && Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF" && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP") mime = "image/webp";
        else throw new InvalidDataException("请选择 PNG、JPG 或 WebP 图片。");
        return new(Path.GetFileName(name), mime, bytes);
    }
}

internal static class FeedbackDiagnostics
{
    internal const int MaximumLogBytes = 1024 * 1024;
    private const int TailBytes = 256 * 1024;

    internal static string Collect(string directory, string state = "")
    {
        var text = new StringBuilder("ICeClass 教师端诊断报告\n");
        text.AppendLine($"整理时间：{DateTimeOffset.Now:O}");
        text.AppendLine("【运行环境】");
        text.AppendLine($"版本：{DesktopUpdates.CurrentVersion}");
        text.AppendLine($"系统：{RuntimeInformation.OSDescription} / {RuntimeInformation.ProcessArchitecture}");
        text.AppendLine($"运行时：.NET {Environment.Version}；系统架构 {RuntimeInformation.OSArchitecture}");
        text.AppendLine($"逻辑处理器：{Environment.ProcessorCount}；进程内存：{Environment.WorkingSet / 1024 / 1024} MB");
        text.AppendLine($"系统时区：{TimeZoneInfo.Local.Id}");
        text.AppendLine("【当前状态】");
        text.AppendLine(state.Length > 0 ? state : "本次收集未提供窗口状态。");
        text.AppendLine();
        text.AppendLine(DesktopDiagnostics.ActivityReport(directory));
        text.AppendLine();
        text.AppendLine("【错误详情】");
        try
        {
            var path = Path.Combine(directory, "desktop.log");
            if (!File.Exists(path)) text.AppendLine("未发现本机运行错误日志。");
            else
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var truncated = stream.Length > TailBytes;
                if (truncated) stream.Seek(-TailBytes, SeekOrigin.End);
                var bytes = new byte[Math.Min(stream.Length, TailBytes)];
                var length = 0;
                while (length < bytes.Length)
                {
                    var count = stream.Read(bytes, length, bytes.Length - length);
                    if (count == 0) break;
                    length += count;
                }
                var content = Encoding.UTF8.GetString(bytes, 0, length);
                if (truncated)
                {
                    var newline = content.IndexOf('\n');
                    if (newline >= 0) content = content[(newline + 1)..];
                    text.AppendLine("日志较大，附最近 256 KB；此前内容未附带。");
                }
                text.AppendLine(content);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { text.AppendLine("本机错误日志暂时无法读取。"); }
        return Redact(text.ToString());
    }

    internal static string Report(FeedbackAccount account, FeedbackReport report, string logs) => Redact(
        $"ICeClass 使用反馈 · 可直接转发本文件\n反馈人：{account.DisplayName}（{account.Username}）\n" +
        $"发生时间：{report.OccurredAt}\n客户端版本：{report.Version}\n系统：{report.System}\n" +
        $"显示缩放：{report.Scaling}\n当前页面：{Page(report.Page)}\n联系方式：{report.Contact}\n" +
        $"问题描述：{report.Description}\n\n{logs}");

    internal static string Redact(string text)
    {
        text = Regex.Replace(text, @"(?im)([""']?(?:Set-)?Cookie[""']?\s*[:=])[^\r\n]*", "$1 [已隐藏]");
        text = Regex.Replace(text, @"(?i)([""']?Authorization[""']?\s*[:=]\s*[""']?)(?:Bearer|Basic)\s+[^\s""']+", "$1[已隐藏]");
        text = Regex.Replace(text, @"(?i)([""']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?token|csrf(?:[_-]?token)?|iceclass_session|token|secret)[""']?\s*[:=]\s*)(""[^""\r\n]*""|'[^'\r\n]*'|[^\s,;&\r\n]+)", "$1[已隐藏]");
        text = Regex.Replace(text, @"(?i)(https?://)[^/\s@]+@", "$1[已隐藏]@");
        text = Regex.Replace(text, @"\bsk-[A-Za-z0-9_-]{12,}\b", "[已隐藏]");
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(profile)) text = text.Replace(profile, "%USERPROFILE%", StringComparison.OrdinalIgnoreCase);
        return text;
    }

    internal static string Page(string? address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo)) return "";
        var fragment = Regex.IsMatch(uri.Fragment, @"^#[A-Za-z0-9_/-]{0,80}$") ? uri.Fragment : "";
        var page = uri.GetLeftPart(UriPartial.Path) + fragment;
        return page.Length <= 500 ? page : page[..500];
    }
}

internal sealed class TeacherFeedbackClient : IDisposable
{
    private readonly string _endpoint;
    private readonly Func<Task<string?>> _readSession;
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly DesktopDiagnostics? _diagnostics;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal TeacherFeedbackClient(string endpoint, Func<Task<string?>> readSession, HttpClient? http = null, DesktopDiagnostics? diagnostics = null)
    {
        _endpoint = DesktopSettings.NormalizeEndpoint(endpoint);
        _readSession = readSession;
        _ownsHttp = http is null;
        _diagnostics = diagnostics;
        _http = http ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(60) };
    }

    internal async Task<FeedbackAccount> AccountAsync(CancellationToken token)
    {
        var session = await _readSession();
        if (string.IsNullOrEmpty(session)) throw new InvalidOperationException("请先登录教师工作台，再提交反馈。");
        using var request = new HttpRequestMessage(HttpMethod.Get, _endpoint + "/api/session");
        request.Headers.Add("Cookie", "iceclass_session=" + session);
        using var response = await SendRequestAsync(request, token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new InvalidOperationException("登录已过期，请重新登录后反馈。");
        response.EnsureSuccessStatusCode();
        var value = await response.Content.ReadFromJsonAsync<SessionResponse>(cancellationToken: token);
        if (value is not { Authenticated: true, User: { } user } || string.IsNullOrEmpty(user.CsrfToken))
            throw new InvalidOperationException("请先登录教师工作台，再提交反馈。");
        if (session != await _readSession()) throw new InvalidOperationException("登录已变化，请重新打开反馈。");
        return new(session, user.CsrfToken, user.Username, user.DisplayName);
    }

    internal async Task<string> SendAsync(FeedbackAccount account, FeedbackReport report, string? logs,
        IReadOnlyList<FeedbackImage> images, CancellationToken token)
    {
        if (report.Description.Length > 2000 || report.Contact.Length > 120) throw new InvalidDataException("描述最多 2000 字，联系方式最多 120 字。");
        if (string.IsNullOrWhiteSpace(report.Description) && string.IsNullOrWhiteSpace(logs) && images.Count == 0)
            throw new InvalidDataException("请填写问题描述，或附上日志、截图。");
        if (images.Count > FeedbackImage.MaximumCount || images.Sum(image => (long)image.Bytes.Length) > FeedbackImage.MaximumTotalBytes)
            throw new InvalidDataException("最多附 3 张截图，合计不超过 3 MB。");
        var current = await AccountAsync(token);
        if (current.Session != account.Session || current.Username != account.Username)
            throw new InvalidOperationException("登录账号已变化，请关闭反馈窗口后重新打开。");
        using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint + "/api/feedback");
        request.Headers.Add("Cookie", "iceclass_session=" + current.Session);
        request.Headers.Add("X-CSRF-Token", current.Csrf);
        using var form = new MultipartFormDataContent();
        form.Add(new StringContent(JsonSerializer.Serialize(report with { Page = FeedbackDiagnostics.Page(report.Page) }, Json), Encoding.UTF8, "application/json"), "report");
        if (!string.IsNullOrWhiteSpace(logs))
        {
            var bytes = Encoding.UTF8.GetBytes(FeedbackDiagnostics.Report(account, report, logs));
            if (bytes.Length > FeedbackDiagnostics.MaximumLogBytes) throw new InvalidDataException("诊断日志超出大小限制。");
            var content = new ByteArrayContent(bytes); content.Headers.ContentType = new("text/plain");
            form.Add(content, "logs", "desktop.txt");
        }
        for (var index = 0; index < images.Count; index++)
        {
            var image = FeedbackImage.Create(images[index].Name, images[index].Bytes);
            var content = new ByteArrayContent(image.Bytes); content.Headers.ContentType = new MediaTypeHeaderValue(image.ContentType);
            var extension = image.ContentType == "image/jpeg" ? "jpg" : image.ContentType == "image/webp" ? "webp" : "png";
            form.Add(content, "screenshot", $"screenshot-{index + 1}.{extension}");
        }
        request.Content = form;
        using var response = await SendRequestAsync(request, token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new InvalidOperationException("登录已过期，请回工作台登录后重试。填写内容已保留。");
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new InvalidOperationException("当前学校平台尚未启用反馈服务，请稍后再试。");
        FeedbackResponse? result;
        try { result = await response.Content.ReadFromJsonAsync<FeedbackResponse>(cancellationToken: token); }
        catch (JsonException) { throw new InvalidDataException("未收到发送确认，填写内容已保留，请稍后重试。"); }
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(result?.Error ?? "暂时无法发送，填写内容已保留，请稍后重试。");
        if (result is not { Status: "sent" } || !Guid.TryParse(result.Id, out _)) throw new InvalidDataException("未收到发送确认，填写内容已保留，请稍后重试。");
        return result.Id;
    }

    private async Task<HttpResponseMessage> SendRequestAsync(HttpRequestMessage request, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            var response = await _http.SendAsync(request, token);
            _diagnostics?.Record("request", request.Method.Method, request.RequestUri!.ToString(), "教师反馈",
                watch.Elapsed.TotalMilliseconds, (int)response.StatusCode);
            return response;
        }
        catch (Exception error)
        {
            _diagnostics?.Record("request", request.Method.Method, request.RequestUri!.ToString(), error.GetType().Name,
                watch.Elapsed.TotalMilliseconds, 0);
            throw;
        }
    }

    public void Dispose() { if (_ownsHttp) _http.Dispose(); }
    private sealed record SessionResponse(bool Authenticated, SessionUser? User);
    private sealed record SessionUser(string Username, string DisplayName, string CsrfToken);
    private sealed record FeedbackResponse(string? Id, string? Status, string? Error);
}

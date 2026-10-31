using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace ICeClass.Desktop;

internal sealed record ClassroomVoiceMessage(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("class_id")] string ClassId,
    [property: JsonPropertyName("class_name")] string ClassName,
    [property: JsonPropertyName("audio_duration_ms")] int DurationMs,
    [property: JsonPropertyName("created_at")] long CreatedAt,
    [property: JsonPropertyName("played_by_me")] bool Played);

internal sealed class ClassroomVoiceInbox : IDisposable
{
    private readonly string _endpoint;
    private readonly Func<Task<string?>> _readSession;
    private readonly HttpClient _http;
    private readonly bool _ownsClient;
    private readonly HashSet<string> _announced = [];
    private string? _session;

    internal ClassroomVoiceInbox(string endpoint, Func<Task<string?>> readSession, HttpClient? http = null)
    {
        _endpoint = DesktopSettings.NormalizeEndpoint(endpoint);
        _readSession = readSession;
        _ownsClient = http is null;
        _http = http ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(12) };
    }
    internal IReadOnlyList<ClassroomVoiceMessage> Pending { get; private set; } = [];
    internal int AccountVersion { get; private set; }
    internal event Action? Changed;

    internal async Task RefreshAsync(CancellationToken token)
    {
        var session = await _readSession();
        SetSession(session);
        if (string.IsNullOrEmpty(session)) return;
        using var request = Request("/api/classroom-voice", session);
        using var response = await _http.SendAsync(request, token);
        if (!await SessionIsCurrent(session)) return;
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        { SetSession(null); return; }
        response.EnsureSuccessStatusCode();
        var envelope = await response.Content.ReadFromJsonAsync<InboxResponse>(cancellationToken: token);
        if (envelope?.Messages is null) throw new InvalidDataException("暂时无法读取教室来音。");
        if (!await SessionIsCurrent(session)) return;
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-30).ToUnixTimeMilliseconds();
        var messages = envelope.Messages.Where(item => !string.IsNullOrWhiteSpace(item.Id)
            && !string.IsNullOrWhiteSpace(item.ClassName) && item.CreatedAt > cutoff)
            .DistinctBy(item => item.Id).ToArray();
        var active = messages.Select(item => item.Id).ToHashSet();
        _announced.IntersectWith(active);
        var unread = messages.Where(item => !item.Played).ToDictionary(item => item.Id);
        var pending = Pending.Where(item => unread.ContainsKey(item.Id)).Select(item => unread[item.Id])
            .Concat(messages.Where(item => !item.Played && !_announced.Contains(item.Id)).OrderBy(item => item.CreatedAt)).ToArray();
        _announced.UnionWith(active);
        SetPending(pending);
    }

    internal async Task<byte[]> ReadAudioAsync(ClassroomVoiceMessage message, CancellationToken token)
    {
        var session = _session;
        // Fetching audio records a server receipt, so a retained popup may need to retry after the next poll.
        if (string.IsNullOrEmpty(session) || !_announced.Contains(message.Id) || !await SessionIsCurrent(session))
            throw new InvalidOperationException("登录或留言已变化，请回工作台查看教室来音。");
        // Never accept an audio URL from the payload or export the login cookie.
        using var request = Request("/api/classroom-voice/" + Uri.EscapeDataString(message.Id) + "/audio", session);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (!await SessionIsCurrent(session)) throw new InvalidOperationException("登录已变化，请回工作台重新收听。");
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        { SetSession(null); throw new InvalidOperationException("登录已过期，请回工作台重新登录。"); }
        if (response.StatusCode == HttpStatusCode.NotFound) throw new InvalidOperationException("这条留言已过期或已清理，可以稍后查看其他来音。");
        response.EnsureSuccessStatusCode();
        const int maximum = 4 * 1024 * 1024;
        if (response.Content.Headers.ContentLength > maximum) throw new InvalidDataException("语音文件超出大小限制，请回工作台检查。");
        using var stream = await response.Content.ReadAsStreamAsync(token);
        using var result = new MemoryStream();
        var buffer = new byte[81920];
        int count;
        while ((count = await stream.ReadAsync(buffer, token)) > 0)
        {
            if (result.Length + count > maximum) throw new InvalidDataException("语音文件超出大小限制，请回工作台检查。");
            result.Write(buffer, 0, count);
        }
        if (!await SessionIsCurrent(session)) throw new InvalidOperationException("登录已变化，请回工作台重新收听。");
        return result.ToArray();
    }

    internal void Dismiss(string id) => SetPending(Pending.Where(item => item.Id != id).ToArray());
    internal void DismissAll() => SetPending([]);

    internal async Task EnsureCurrentAccountAsync(int version)
    {
        var session = _session;
        if (version != AccountVersion || string.IsNullOrEmpty(session) || !await SessionIsCurrent(session) || version != AccountVersion)
            throw new InvalidOperationException("登录已变化，请回工作台重新查看来音。");
    }

    private HttpRequestMessage Request(string path, string session)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, _endpoint + path);
        request.Headers.Add("Cookie", "iceclass_session=" + session);
        request.Headers.CacheControl = new() { NoCache = true, NoStore = true };
        return request;
    }
    private async Task<bool> SessionIsCurrent(string session)
    {
        var current = await _readSession();
        SetSession(current);
        return session == current;
    }
    private void SetSession(string? session)
    {
        if (_session == session) return;
        _session = session;
        AccountVersion++;
        _announced.Clear();
        var hadPending = Pending.Count > 0;
        SetPending([]);
        if (!hadPending) Changed?.Invoke();
    }
    private void SetPending(IReadOnlyList<ClassroomVoiceMessage> messages)
    {
        if (Pending.SequenceEqual(messages)) return;
        Pending = messages;
        Changed?.Invoke();
    }
    public void Dispose() { if (_ownsClient) _http.Dispose(); }
    private sealed record InboxResponse([property: JsonPropertyName("messages")] ClassroomVoiceMessage[] Messages);
}

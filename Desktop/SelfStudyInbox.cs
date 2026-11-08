using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace ICeClass.Desktop;

internal sealed record SelfStudyIncident(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("class_name")] string ClassName,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("handled_at")] long? HandledAt);

/// <summary>Small metadata-only inbox; continues while the workbench is in the tray.</summary>
internal sealed class SelfStudyInbox(string endpoint, Func<Task<string?>> readSession, HttpClient? client = null) : IDisposable
{
    private readonly HttpClient _http = client ?? new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(10) };
    private readonly bool _owns = client is null;
    private string? _session;
    private readonly HashSet<string> _seen = [];
    internal IReadOnlyList<SelfStudyIncident> Pending { get; private set; } = [];
    internal event Action? Changed;
    internal async Task RefreshAsync(CancellationToken token)
    {
        var session = await readSession();
        if (_session != session) { _session = session; _seen.Clear(); Pending = []; Changed?.Invoke(); }
        if (string.IsNullOrEmpty(session)) return;
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint.TrimEnd('/') + "/api/self-study/events?limit=100");
        request.Headers.Add("Cookie", "iceclass_session=" + session);
        request.Headers.CacheControl = new() { NoStore = true, NoCache = true };
        using var response = await _http.SendAsync(request, token);
        if (session != await readSession()) { _session = null; _seen.Clear(); Pending = []; Changed?.Invoke(); return; }
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        { Pending = []; _seen.Clear(); Changed?.Invoke(); return; }
        response.EnsureSuccessStatusCode();
        var envelope = await response.Content.ReadFromJsonAsync<Envelope>(cancellationToken: token);
        if (session != await readSession()) { _session = null; _seen.Clear(); Pending = []; Changed?.Invoke(); return; }
        var active = (envelope?.Events ?? []).Where(e => e.Status == "reported" && e.HandledAt is null)
            .DistinctBy(e => e.Id).ToArray();
        var ids = active.Select(e => e.Id).ToHashSet();
        var next = Pending.Where(e => ids.Contains(e.Id)).Concat(active.Where(e => !_seen.Contains(e.Id))).ToArray();
        _seen.UnionWith(ids);
        if (!Pending.SequenceEqual(next)) { Pending = next; Changed?.Invoke(); }
    }
    internal void Dismiss() { Pending = []; Changed?.Invoke(); }
    public void Dispose() { if (_owns) _http.Dispose(); }
    private sealed record Envelope(SelfStudyIncident[] Events);
}

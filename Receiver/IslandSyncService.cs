using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

internal sealed record IslandSnapshot(IslandProfile? Profile, int Revision, bool Online, bool Revoked, string Status);

internal sealed class IslandSyncService : IDisposable
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    private readonly ReceiverConfig _binding;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly object _gate = new();
    private IslandSnapshot _snapshot = new(null, 0, false, false, "正在同步教室浮岛");
    private string _detail = "";
    private readonly IslandLocalStore _store;
    public IslandLocalStore Store => _store;
    public IslandSnapshot Snapshot { get { lock (_gate) return _snapshot; } }

    public IslandSyncService(ReceiverConfig binding, string? root = null, bool start = true)
    {
        _binding = new() { Endpoint = binding.Endpoint, DeviceId = binding.DeviceId, DeviceToken = binding.DeviceToken, ClassId = binding.ClassId };
        _store = new(root ?? IslandLocalStore.RootFor(binding));
        try
        {
            var cache = _store.Read<JsonObject>("profile.json");
            if (cache is not null && cache["classId"]?.GetValue<string>() == binding.ClassId)
                _snapshot = new(IslandProfile.Parse(cache["config"]!.ToJsonString()), cache["revision"]!.GetValue<int>(), false,
                    cache["revoked"]?.GetValue<bool>() == true, "使用本机教室浮岛配置");
        }
        catch (Exception error) { AppLog.Error("Load island cache failed", error); }
        if (start) _ = Task.Run(() => Run(_lifetime.Token));
    }
    public void Report(string detail) { lock (_gate) _detail = detail; }
    private async Task<JsonObject> Send(HttpMethod method, string path, CancellationToken token, JsonNode? body = null)
    {
        using var request = new HttpRequestMessage(method, _binding.Endpoint.TrimEnd('/') + "/api/island/" + path + "?deviceId=" + Uri.EscapeDataString(_binding.DeviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _binding.DeviceToken);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await Http.SendAsync(request, token);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            lock (_gate)
            {
                _snapshot = _snapshot with { Online = false, Revoked = true, Status = "绑定失效，请重新绑定" };
                var cache = _store.Read<JsonObject>("profile.json");
                if (cache is not null) { cache["revoked"] = true; _store.Write("profile.json", cache); }
            }
        }
        response.EnsureSuccessStatusCode();
        return JsonNode.Parse(await response.Content.ReadAsStringAsync(token))!.AsObject();
    }
    private async Task Run(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var cache = await Send(HttpMethod.Get, "device", token);
                if (cache["classId"]?.GetValue<string>() != _binding.ClassId) throw new InvalidDataException("教室浮岛班级绑定不一致。");
                var p = IslandProfile.Parse(cache["config"]!.ToJsonString());
                var revision = cache["revision"]!.GetValue<int>();
                _store.Write("profile.json", cache); // Acknowledge only after the durable cache has been written.
                lock (_gate) _snapshot = new(p, revision, true, false, $"教室浮岛版本 {revision}");
                string detail;
                lock (_gate) detail = _detail;
                await Send(HttpMethod.Post, "device/ack", token, new JsonObject { ["revision"] = revision, ["detail"] = detail });
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                lock (_gate) _snapshot = _snapshot with { Online = false, Status = _snapshot.Revoked ? "绑定失效，请重新绑定" : _snapshot.Profile is null ? "教室浮岛尚未同步，联网后重试" : "离线 · 使用已保存的课表与规则" };
                AppLog.Error("Sync classroom island failed", error);
            }
            try { await Task.Delay(TimeSpan.FromSeconds(15), token); }
            catch (OperationCanceledException) { break; }
        }
    }
    public void Dispose() => _lifetime.Cancel();
}

internal sealed class IslandLocalStore(string root)
{
    private readonly object _gate = new();
    public static string RootFor(ReceiverConfig binding)
    {
        var scope = ReceiverConfig.NormalizeEndpoint(binding.Endpoint).ToLowerInvariant() + "\n" + binding.DeviceId + "\n" + binding.ClassId;
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope)))[..24];
        return Path.Combine(ReceiverConfig.IsPreview(binding) ? Path.Combine(AppContext.BaseDirectory, "IslandData") :
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "IslandData"), digest);
    }
    public T? Read<T>(string file)
    {
        lock (_gate)
        {
            var path = Path.Combine(root, file);
            if (!File.Exists(path)) return default;
            if (new FileInfo(path).Length > 4_000_000) throw new InvalidDataException("教室浮岛缓存过大。");
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path), IslandProfile.Json);
        }
    }
    public void Write<T>(string file, T value)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, file);
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(value, IslandProfile.Json));
            File.Move(path + ".tmp", path, true);
        }
    }
}

internal sealed class IslandEventLedger
{
    private readonly IslandLocalStore _store;
    private Dictionary<string, long> _events;
    public IslandEventLedger(IslandLocalStore store)
    {
        _store = store;
        // A broken ledger must stop automatic actions until it can be examined; do not replay an empty queue.
        _events = store.Read<Dictionary<string, long>>("events.json") ?? [];
    }
    public bool Claim(IslandDueEvent e, long now)
    {
        if (_events.ContainsKey(e.Key)) return false;
        _events = _events.Where(x => x.Value >= now - 14L * 86400000).TakeLast(19000).ToDictionary();
        _events[e.Key] = e.At.ToUnixTimeMilliseconds();
        _store.Write("events.json", _events);
        return true;
    }
}

internal sealed class IslandLocalSettings
{
    public IslandAppearance? Appearance { get; set; }
    public List<string> AllowedApplications { get; set; } = [];
    public List<string> RecentActions { get; set; } = [];
    public void Normalize()
    {
        Appearance?.Clamp();
        AllowedApplications = (AllowedApplications ?? []).Where(p => !string.IsNullOrWhiteSpace(p)).Distinct(StringComparer.OrdinalIgnoreCase).Take(100).ToList();
        RecentActions = (RecentActions ?? []).Where(s => !string.IsNullOrWhiteSpace(s)).TakeLast(30).ToList();
    }
}

using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using ICeClass.Updates;

namespace ICeClass.Desktop;

public sealed record DesktopRelease(string Version, string Sha256, long Size, string DownloadUrl);

internal sealed record DesktopUpdate(string Version, UpdatePlan? Plan, DesktopRelease? Legacy);
internal sealed record DesktopUpdateActivity(bool Known, bool InClass, TimeSpan ValidFor)
{
    private readonly long _received = Stopwatch.GetTimestamp();
    internal bool AllowsDownload => Known && !InClass && Stopwatch.GetElapsedTime(_received) < ValidFor;
}
internal sealed class DesktopUpdatePausedException(string message) : OperationCanceledException(message);

public static class DesktopUpdates
{
    private const long MaxBytes = 180L * 1024 * 1024;
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromMinutes(12) };
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public static string CurrentVersion => typeof(DesktopUpdates).Assembly.GetName().Version?.ToString(3) ?? "2.3.0";
    public static bool IsValid(string endpoint, DesktopRelease release)
    {
        return Version.TryParse(release.Version, out var version) && version > Version.Parse(CurrentVersion) &&
            release.Size is > 0 and <= MaxBytes && release.Sha256 is { Length: 64 } && release.Sha256.All(Uri.IsHexDigit) && !string.IsNullOrWhiteSpace(release.DownloadUrl) &&
            Uri.TryCreate(new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/"), release.DownloadUrl, out var download) &&
            DesktopSettings.SameOrigin(endpoint, download.AbsoluteUri);
    }
    public static Task<DesktopRelease?> CheckAsync(string endpoint, CancellationToken token) => CheckAsync(endpoint, token, Client);
    internal static async Task<DesktopRelease?> CheckAsync(string endpoint, CancellationToken token, HttpClient client)
    {
        var uri = new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/api/desktop/update?currentVersion=" + Uri.EscapeDataString(CurrentVersion));
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotFound) throw new InvalidOperationException("学校平台尚未提供桌面更新服务。");
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > 16384) throw new InvalidOperationException("更新信息无效。");
        await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var bounded = new MemoryStream(); var buffer = new byte[4096];
        while (true) { var count = await source.ReadAsync(buffer, timeout.Token); if (count == 0) break; if (bounded.Length + count > 16384) throw new InvalidOperationException("更新信息无效。"); bounded.Write(buffer, 0, count); }
        var manifest = JsonSerializer.Deserialize<JsonElement>(bounded.ToArray());
        if (!manifest.TryGetProperty("available", out var available) || !available.GetBoolean()) return null;
        var release = manifest.Deserialize<DesktopRelease>(JsonOptions);
        if (release is null || !IsValid(endpoint, release)) throw new InvalidOperationException("更新信息无效。");
        return release;
    }

    internal static async Task<DesktopUpdate?> CheckPlanFirstAsync(string endpoint, CancellationToken token, HttpClient? client = null)
    {
        client ??= Client;
        var origin = new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/");
        var plan = await IncrementalUpdates.FetchPlanAsync(origin,
            "/api/desktop/update/plan?currentVersion=" + Uri.EscapeDataString(CurrentVersion), CurrentVersion, client, null, token);
        if (plan is not null)
        {
            IncrementalUpdates.Validate(plan, origin, "ICeClass.Desktop.exe");
            return new(plan.Version, plan, null);
        }
        var legacy = await CheckAsync(endpoint, token, client);
        return legacy is null ? null : new(legacy.Version, null, legacy);
    }

    internal static Task<PreparedUpdate> PrepareAsync(string endpoint, DesktopUpdate update, IProgress<UpdateProgress>? progress,
        CancellationToken token, string? installDirectory = null, HttpClient? client = null)
    {
        installDirectory ??= AppContext.BaseDirectory;
        client ??= Client;
        // Shared hashing, file copies and native patch application must never start on the UI thread.
        return Task.Run(async () =>
        {
            if (update.Plan is not null)
                return await IncrementalUpdates.PrepareAsync(new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/"),
                    update.Plan, installDirectory, "ICeClass.Desktop.exe", client, null, null, progress, token);
            var release = update.Legacy ?? throw new InvalidDataException("桌面更新信息无效。");
            var path = await DownloadAsync(endpoint, release, progress, token, Path.Combine(installDirectory, ".updates"), client);
            var prepared = new PreparedUpdate(release.Version, "ICeClass.Desktop.exe",
                [new("ICeClass.Desktop.exe", path, release.Size, release.Sha256)]);
            token.ThrowIfCancellationRequested();
            UpdateInstaller.SavePending(installDirectory, prepared);
            return prepared;
        }, token);
    }

    internal static Task<PreparedUpdate?> PendingAsync(CancellationToken token, string? installDirectory = null) => Task.Run(async () =>
    {
        installDirectory ??= AppContext.BaseDirectory;
        var pending = UpdateInstaller.LoadPending(installDirectory, "ICeClass.Desktop.exe");
        if (pending is not null && Version.Parse(pending.Version) <= Version.Parse(CurrentVersion))
        {
            File.Delete(IncrementalUpdates.SafePath(installDirectory, ".updates/pending.json"));
            return null;
        }
        if (pending is not null)
            await UpdateInstaller.ValidateAsync(pending, installDirectory, "ICeClass.Desktop.exe", token);
        return pending;
    }, token);

    internal static async Task<DesktopUpdateActivity> ReadActivityAsync(string endpoint, string? session, CancellationToken token, HttpClient? client = null)
    {
        if (string.IsNullOrEmpty(session)) return new(false, true, TimeSpan.Zero);
        var watch = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(3));
        using var request = new HttpRequestMessage(HttpMethod.Get, DesktopSettings.NormalizeEndpoint(endpoint) + "/api/desktop/update/activity");
        request.Headers.Add("Cookie", "iceclass_session=" + session);
        using var response = await (client ?? Client).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.NotFound)
            return new(false, true, TimeSpan.Zero);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var body = new MemoryStream(); var buffer = new byte[1024];
        while (true)
        {
            var count = await source.ReadAsync(buffer, timeout.Token); if (count == 0) break;
            if (body.Length + count > 4096) throw new InvalidDataException("课时状态无效。");
            body.Write(buffer, 0, count);
        }
        var state = JsonSerializer.Deserialize<ActivityResponse>(body.ToArray(), JsonOptions);
        if (state is null || response.Headers.Date is not { } serverTime) return new(false, true, TimeSpan.Zero);
        var serverMs = serverTime.ToUnixTimeMilliseconds();
        if (state.ValidUntil <= serverMs || state.ValidUntil > serverMs + 16_000) return new(false, true, TimeSpan.Zero);
        // HTTP Date has second precision. Deduct that uncertainty and request time,
        // then use a monotonic clock so a changed Windows clock cannot extend a break.
        var validFor = TimeSpan.FromMilliseconds(Math.Clamp(state.ValidUntil - serverMs - 1000 - watch.Elapsed.TotalMilliseconds, 0, 15_000));
        return new(state.Known, state.InClass, validFor);
    }

    internal static async Task<T> RunGuardedAsync<T>(Func<CancellationToken, Task<T>> prepare, Func<bool> busy,
        Func<CancellationToken, Task<DesktopUpdateActivity>> readActivity, CancellationToken token)
    {
        const string unavailable = "课表状态不可用，桌面更新已暂停；请保持教师账号登录并确认授权班级已配置课表。";
        using var download = CancellationTokenSource.CreateLinkedTokenSource(token);
        var activity = await ReadSchool(download.Token);
        if (PauseReason() is { } initial) throw new DesktopUpdatePausedException(initial);
        string? paused = null;
        using var monitor = CancellationTokenSource.CreateLinkedTokenSource(download.Token);
        var local = WatchLocal();
        var school = WatchSchool();
        try { return await prepare(download.Token); }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && paused is not null)
        { throw new DesktopUpdatePausedException(paused); }
        finally { monitor.Cancel(); await Task.WhenAll(local, school); }

        string? PauseReason()
        {
            var current = Volatile.Read(ref activity);
            if (!current.Known) return unavailable;
            if (current.InClass) return "正在上课，桌面更新已暂停，课间空闲时可继续。";
            if (!current.AllowsDownload) return unavailable;
            return busy() ? "正在使用工作台功能，桌面更新已暂停，空闲时可继续。" : null;
        }
        void Pause(string reason)
        {
            Interlocked.CompareExchange(ref paused, reason, null);
            download.Cancel();
        }
        async Task<DesktopUpdateActivity> ReadSchool(CancellationToken cancellation)
        {
            try { return await readActivity(cancellation).WaitAsync(cancellation); }
            catch (Exception) when (!cancellation.IsCancellationRequested)
            { return new(false, true, TimeSpan.Zero); }
        }
        async Task WatchLocal()
        {
            try
            {
                using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
                do { if (PauseReason() is { } reason) { Pause(reason); return; } }
                while (await timer.WaitForNextTickAsync(monitor.Token));
            }
            catch (OperationCanceledException) { }
        }
        async Task WatchSchool()
        {
            try
            {
                using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
                while (await timer.WaitForNextTickAsync(monitor.Token))
                {
                    Volatile.Write(ref activity, await ReadSchool(monitor.Token));
                    if (PauseReason() is { } reason) { Pause(reason); return; }
                }
            }
            catch (OperationCanceledException) { }
        }
    }

    private sealed record ActivityResponse([property: JsonRequired] bool Known,
        [property: JsonRequired] bool InClass, [property: JsonRequired] long ValidUntil);
    public static async Task<string> DownloadAsync(string endpoint, DesktopRelease release, IProgress<UpdateProgress>? progress, CancellationToken token)
        => await DownloadAsync(endpoint, release, progress, token, Path.Combine(AppContext.BaseDirectory, ".updates"), Client);

    internal static async Task<string> DownloadAsync(string endpoint, DesktopRelease release, IProgress<UpdateProgress>? progress, CancellationToken token, string directory, HttpClient client)
    {
        if (!IsValid(endpoint, release)) throw new InvalidOperationException("更新信息无效。");
        progress?.Report(new(UpdateStage.Preparing));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "ICeClass.Desktop-" + Version.Parse(release.Version) + ".download");
        // Bytes are reused only for this exact release; the final digest is always checked.
        var metadata = JsonSerializer.Serialize(release);
        if (!File.Exists(path + ".json") || File.ReadAllText(path + ".json") != metadata)
        { if (File.Exists(path)) File.Delete(path); File.WriteAllText(path + ".json", metadata); }
        var offset = File.Exists(path) ? new FileInfo(path).Length : 0;
        if (offset > release.Size) { File.Delete(path); offset = 0; }
        if (offset == release.Size)
        { if (await Verify(path, release, token)) return path; File.Delete(path); offset = 0; }
        using var transfer = new UpdateTransferProgress(progress, release.Size);
        transfer.Report(offset);
        var uri = new Uri(new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/"), release.DownloadUrl);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (offset > 0) request.Headers.Range = new RangeHeaderValue(offset, null);
        using var connectionTimeout = CancellationTokenSource.CreateLinkedTokenSource(token); connectionTimeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connectionTimeout.Token);
        response.EnsureSuccessStatusCode();
        if (response.StatusCode == HttpStatusCode.OK) offset = 0;
        else if (response.StatusCode != HttpStatusCode.PartialContent || response.Content.Headers.ContentRange?.From != offset || response.Content.Headers.ContentRange.Length != release.Size)
            throw new InvalidOperationException("下载续传范围不正确。");
        transfer.Report(offset);
        await using var input = await response.Content.ReadAsStreamAsync(token);
        await using (var output = new FileStream(path, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 131072, true))
        {
            var buffer = new byte[131072]; long total = offset;
            while (true)
            {
                using var stalled = CancellationTokenSource.CreateLinkedTokenSource(token); stalled.CancelAfter(TimeSpan.FromSeconds(30));
                var count = await input.ReadAsync(buffer, stalled.Token); if (count == 0) break;
                total += count; if (total > release.Size) throw new InvalidOperationException("更新文件大小不正确。");
                await output.WriteAsync(buffer.AsMemory(0, count), token); transfer.Report(total);
            }
            await output.FlushAsync(token);
        }
        progress?.Report(new(UpdateStage.Verifying, release.Size, release.Size));
        if (!await Verify(path, release, token)) { File.Delete(path); throw new InvalidOperationException("更新文件未通过完整性检查，请重新下载。"); }
        return path;
    }
    private static async Task<bool> Verify(string path, DesktopRelease release, CancellationToken token)
    {
        if (new FileInfo(path).Length != release.Size) return false;
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase);
    }
    internal static void ConfirmLaunch()
    {
        var args = Environment.GetCommandLineArgs(); var index = Array.IndexOf(args, "--update-marker");
        if (index < 0 || index + 1 >= args.Length) return;
        var marker = Path.GetFullPath(args[index + 1]);
        if (marker == Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".updates", "desktop-started.ok"))) File.WriteAllText(marker, "started");
    }
}

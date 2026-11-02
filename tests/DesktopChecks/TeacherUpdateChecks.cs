using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ICeClass.Desktop;
using ICeClass.Updates;

internal static class TeacherUpdateChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        const string endpoint = "https://school.example";
        var bytes = Encoding.UTF8.GetBytes("new teacher application");
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var release = new DesktopRelease("9.9.9", hash, bytes.Length, "/api/desktop/update/download");
        var plan = new UpdatePlan { Available = true, Version = "9.9.9", Files = [new UpdateFile {
            Path = "ICeClass.Desktop.exe", Size = bytes.Length, Sha256 = hash,
            DownloadUrl = "/api/desktop/update/payload?sha256=" + hash }] };
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-TeacherUpdateChecks-" + Guid.NewGuid().ToString("N"));
        try
        {
            var legacyChecks = 0;
            using var http = new HttpClient(new Handler(request =>
            {
                Assert(request.Headers.Authorization is null && !request.Headers.Contains("Cookie"), "Public updates carry no classroom or session credentials");
                if (request.RequestUri!.AbsolutePath == "/api/desktop/update/payload")
                    Assert(SynchronizationContext.Current is null, "Preparation starts outside the UI synchronization context");
                return request.RequestUri!.AbsolutePath switch {
                    "/api/desktop/update/plan" => Json(plan),
                    "/api/desktop/update/payload" => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) },
                    _ => Legacy(),
                };
                HttpResponseMessage Legacy() { legacyChecks++; return Json(new { available = true, release.Version, release.Size, release.Sha256, release.DownloadUrl }); }
            }));
            var update = await DesktopUpdates.CheckPlanFirstAsync(endpoint, default, http);
            Assert(update?.Plan is not null && legacyChecks == 0, "A valid plan takes priority over the old executable manifest");
            Directory.CreateDirectory(directory);
            var installed = Path.Combine(directory, "ICeClass.Desktop.exe");
            File.WriteAllText(installed, "installed original");
            SynchronizationContext.SetSynchronizationContext(new SynchronizationContext());
            var preparation = DesktopUpdates.PrepareAsync(endpoint, update!, null, default, directory, http);
            SynchronizationContext.SetSynchronizationContext(null);
            var prepared = await preparation;
            var planPrepared = prepared;
            Assert(prepared.ExecutableName == "ICeClass.Desktop.exe" && prepared.Files.Count == 1, "Plan becomes a prepared teacher update");
            Assert(UpdateInstaller.LoadPending(directory, "ICeClass.Desktop.exe")?.Version == "9.9.9", "Preparation persists pending metadata");
            Assert(File.ReadAllText(installed) == "installed original", "Downloading leaves the installed program in place");
            Assert(!File.Exists(Path.Combine(directory, ".updates", "apply-incremental-update.ps1")), "Preparing never launches an installer");

            foreach (var missing in new[] { HttpStatusCode.NotFound, HttpStatusCode.OK })
            {
                using var legacy = new HttpClient(new Handler(request => request.RequestUri!.AbsolutePath switch {
                    "/api/desktop/update/plan" => missing == HttpStatusCode.NotFound ? new(missing) : Json(new { available = false }),
                    "/api/desktop/update" => Json(new { available = true, release.Version, release.Size, release.Sha256, release.DownloadUrl }),
                    "/api/desktop/update/download" => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) },
                    _ => throw new Exception("Unexpected teacher update endpoint"),
                }));
                update = await DesktopUpdates.CheckPlanFirstAsync(endpoint, default, legacy);
                Assert(update?.Legacy == release, "Missing plans retain the legacy bootstrap manifest");
                var legacyDirectory = Path.Combine(directory, missing.ToString());
                prepared = await DesktopUpdates.PrepareAsync(endpoint, update!, null, default, legacyDirectory, legacy);
                Assert(File.ReadAllBytes(prepared.Files.Single().StagedPath).SequenceEqual(bytes), "Legacy bytes become a verified prepared file");
                Assert(UpdateInstaller.LoadPending(legacyDirectory, "ICeClass.Desktop.exe")?.Version == release.Version, "Legacy downloads also persist pending updates");
            }
            using var unsafePlan = new HttpClient(new Handler(_ => Json(plan with {
                Files = [plan.Files[0] with { DownloadUrl = "https://attacker.example/payload" }] })));
            try { await DesktopUpdates.CheckPlanFirstAsync(endpoint, default, unsafePlan); throw new Exception("Unsafe plan fell back to the legacy download"); }
            catch (InvalidDataException) { checks++; }

            foreach (var staleVersion in new[] { DesktopUpdates.CurrentVersion, "0.1.0" })
            {
                UpdateInstaller.SavePending(directory, new(staleVersion, "ICeClass.Desktop.exe", prepared.Files));
                Assert(!UpdateInstaller.TryLaunchPending(directory, "ICeClass.Desktop.exe", "", DesktopUpdates.CurrentVersion),
                    "Startup passes the current version to ignore equal or older pending updates");
                Assert(!File.Exists(Path.Combine(directory, ".updates", "pending.json")), "Stale pending metadata is discarded");
                UpdateInstaller.SavePending(directory, new(staleVersion, "ICeClass.Desktop.exe", prepared.Files));
                Assert(await DesktopUpdates.PendingAsync(default, directory) is null, "The tray cannot offer an old version as ready");
                Assert(!File.Exists(Path.Combine(directory, ".updates", "pending.json")), "The ready check discards stale metadata before hashing staged files");
            }
            UpdateInstaller.SavePending(directory, planPrepared);
            Assert((await DesktopUpdates.PendingAsync(default, directory))?.Version == "9.9.9", "A newer verified update remains ready for the tray");

            var serverTime = new DateTimeOffset(2026, 11, 2, 1, 0, 0, TimeSpan.Zero);
            using var activity = new HttpClient(new Handler(request =>
            {
                Assert(request.RequestUri!.AbsolutePath == "/api/desktop/update/activity", "Session is sent only to activity authorization");
                Assert(request.Headers.GetValues("Cookie").Single() == "iceclass_session=test-session", "Activity uses the current browser session");
                var response = Json(new { known = true, inClass = false, validUntil = serverTime.AddSeconds(15).ToUnixTimeMilliseconds() });
                response.Headers.Date = serverTime;
                return response;
            }));
            var state = await DesktopUpdates.ReadActivityAsync(endpoint, "test-session", default, activity);
            Assert(state.AllowsDownload && state.ValidFor <= TimeSpan.FromSeconds(15), "A server-time break grants only a short monotonic lease");
            Assert(!(await DesktopUpdates.ReadActivityAsync(endpoint, null, default, activity)).AllowsDownload, "No session fails closed");
            foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.OK })
            {
                using var unknown = new HttpClient(new Handler(_ => status == HttpStatusCode.OK
                    ? Json(new { known = true, inClass = false, validUntil = long.MaxValue }) : new(status)));
                Assert(!(await DesktopUpdates.ReadActivityAsync(endpoint, "test-session", default, unknown)).AllowsDownload,
                    "Authentication failure and missing server time cannot grant an activity lease");
            }
            foreach (var body in new[] {
                new { known = false, inClass = false, validUntil = serverTime.AddSeconds(15).ToUnixTimeMilliseconds() },
                new { known = true, inClass = true, validUntil = serverTime.AddSeconds(15).ToUnixTimeMilliseconds() },
                new { known = true, inClass = false, validUntil = serverTime.AddSeconds(-1).ToUnixTimeMilliseconds() } })
            {
                using var denied = new HttpClient(new Handler(_ => { var response = Json(body); response.Headers.Date = serverTime; return response; }));
                Assert(!(await DesktopUpdates.ReadActivityAsync(endpoint, "test-session", default, denied)).AllowsDownload,
                    "Unknown, in-class and expired activity pauses downloads");
            }
            using (var incomplete = new HttpClient(new Handler(_ => {
                var response = Json(new { known = true, validUntil = serverTime.AddSeconds(15).ToUnixTimeMilliseconds() });
                response.Headers.Date = serverTime; return response;
            })))
            {
                try { await DesktopUpdates.RunGuardedAsync(_ => Task.FromResult(0), () => false,
                    token => DesktopUpdates.ReadActivityAsync(endpoint, "test-session", token, incomplete), default);
                    throw new Exception("Missing lesson activity cannot default to a break"); }
                catch (OperationCanceledException error)
                { Assert(error.Message.Contains("课表状态不可用"), "An incomplete school response cannot grant a download lease"); }
            }

            var busy = 0;
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var download = DesktopUpdates.RunGuardedAsync(async token => {
                started.SetResult(); await Task.Delay(Timeout.Infinite, token); return 0;
            }, () => Volatile.Read(ref busy) != 0,
                _ => Task.FromResult(new DesktopUpdateActivity(true, false, TimeSpan.FromSeconds(15))), default);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var clock = System.Diagnostics.Stopwatch.StartNew();
            Volatile.Write(ref busy, 1);
            try { await download.WaitAsync(TimeSpan.FromMilliseconds(500)); throw new Exception("Busy work did not cancel the download"); }
            catch (OperationCanceledException) { Assert(clock.Elapsed < TimeSpan.FromMilliseconds(500), "Local work cancels downloads within 500ms"); }

            var ran = false;
            try { await DesktopUpdates.RunGuardedAsync(_ => { ran = true; return Task.FromResult(0); }, () => false,
                _ => Task.FromResult(new DesktopUpdateActivity(false, false, TimeSpan.FromSeconds(15))), default);
                throw new Exception("Unknown school activity started a download"); }
            catch (OperationCanceledException error)
            {
                Assert(!ran, "Unknown school activity prevents the first payload request");
                Assert(error.Message.Contains("课表状态不可用"), "Missing schedules have explicit feedback instead of a vague pause");
            }
            foreach (var failure in new Exception[] { new HttpRequestException("offline"), new TaskCanceledException("activity timeout") })
            {
                try { await DesktopUpdates.RunGuardedAsync(_ => Task.FromResult(0), () => false,
                    _ => Task.FromException<DesktopUpdateActivity>(failure), default);
                    throw new Exception("An unavailable activity request allowed a download"); }
                catch (OperationCanceledException error)
                { Assert(error.Message.Contains("课表状态不可用"), "Failed activity requests give an explicit unavailable-schedule status"); }
            }
            try { await DesktopUpdates.RunGuardedAsync(_ => Task.FromResult(0), () => false,
                _ => Task.FromResult(new DesktopUpdateActivity(true, true, TimeSpan.FromSeconds(15))), default);
                throw new Exception("An active lesson allowed a download"); }
            catch (OperationCanceledException error)
            { Assert(error.Message.Contains("正在上课"), "Class time has a distinct pause reason"); }
            Volatile.Write(ref busy, 0);
            var polling = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var releasePoll = new TaskCompletionSource<DesktopUpdateActivity>(TaskCreationOptions.RunContinuationsAsynchronously);
            var reads = 0;
            using (var guardLifetime = new CancellationTokenSource(TimeSpan.FromSeconds(16)))
            {
                var guarded = DesktopUpdates.RunGuardedAsync(async token => { await Task.Delay(Timeout.Infinite, token); return 0; },
                    () => Volatile.Read(ref busy) != 0, _ => {
                        if (Interlocked.Increment(ref reads) == 1)
                            return Task.FromResult(new DesktopUpdateActivity(true, false, TimeSpan.FromSeconds(15)));
                        polling.TrySetResult();
                        return releasePoll.Task; // A cookie/WebView request can outlive cancellation.
                    }, guardLifetime.Token);
                try
                {
                    await polling.Task.WaitAsync(TimeSpan.FromSeconds(12));
                    clock.Restart(); Volatile.Write(ref busy, 1);
                    try { await guarded.WaitAsync(TimeSpan.FromMilliseconds(500)); throw new Exception("An activity request blocked local cancellation"); }
                    catch (OperationCanceledException)
                    { Assert(clock.Elapsed < TimeSpan.FromMilliseconds(500), "Local work cancels within 500ms even while activity polling is blocked"); }
                }
                finally
                {
                    guardLifetime.Cancel();
                    releasePoll.TrySetResult(new(false, true, TimeSpan.Zero));
                    try { await guarded; } catch (OperationCanceledException) { }
                }
            }
            try { await DesktopUpdates.RunGuardedAsync(async token => { await Task.Delay(2000, token); return 0; }, () => false,
                _ => Task.FromResult(new DesktopUpdateActivity(true, false, TimeSpan.FromMilliseconds(40))), default);
                throw new Exception("An expired lesson lease kept downloading"); }
            catch (OperationCanceledException) { checks++; }
        }
        finally { SynchronizationContext.SetSynchronizationContext(null); if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return checks;
    }

    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) {
        Content = new StringContent(JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)), Encoding.UTF8, "application/json") };
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(send(request));
    }
}

using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using ICeClass.Updates;

internal static class VoiceResourceChecks
{
    internal static async Task RunAsync(string root, Action<bool, string> check)
    {
        var bytes = new byte[400000]; Random.Shared.NextBytes(bytes);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var file = new VoiceResourceFile("VoiceResources/Asr/model.int8.onnx", bytes.Length, hash);
        var folder = Path.Combine(root, "voice-only"); Directory.CreateDirectory(folder);
        using var transport = new Transport(bytes);
        using var client = new HttpClient(transport);
        var store = new VoiceResources([file], folder);
        check(!(await store.IsReadyAsync(default)), "a same-version core reports missing voice resources");
        transport.Break = true;
        try { await store.PrepareAsync(new Uri("https://school.test/"), client, null, default); throw new Exception("expected interruption"); }
        catch (IOException) { }
        check(!File.Exists(Path.Combine(folder, file.Path)), "an interrupted resource is never made usable");
        transport.Break = false;
        await store.PrepareAsync(new Uri("https://school.test/"), client, null, default);
        check(transport.Offset > 0 && await store.IsReadyAsync(default), "a new resource preparation resumes a prior partial file and verifies it");
        check(!File.Exists(Path.Combine(folder, ".updates", "pending.json")), "voice preparation never schedules a program installation");
        var before = transport.Requests;
        await store.PrepareAsync(new Uri("https://school.test/"), client, null, default);
        check(transport.Requests == before, "verified voice resources require no additional network requests");
        check(transport.SafeRequest, "voice downloads use the school voice endpoint without credentials");
        foreach (var bad in new[] { "VoiceResources/../config.json", "ICeClass.exe", "VoiceResources/CON", "VoiceResources/Asr/model:bad" })
        {
            try { _ = new VoiceResources([file with { Path = bad }], folder); throw new Exception("unsafe voice target accepted"); }
            catch (InvalidDataException) { check(true, "voice catalog rejects " + bad); }
        }
        var wrong = new VoiceResources([file with { Sha256 = new string('a', 64) }], Path.Combine(root, "bad-voice"));
        try { await wrong.PrepareAsync(new Uri("https://school.test/"), client, null, default); throw new Exception("invalid voice hash accepted"); }
        catch (InvalidDataException) { check(!await wrong.IsReadyAsync(default), "corrupt voice downloads remain unavailable"); }

        var cache = Path.Combine(root, "legacy-asr-cache"); Directory.CreateDirectory(cache);
        await File.WriteAllBytesAsync(Path.Combine(cache, "model.int8.onnx"), bytes);
        var migratedFolder = Path.Combine(root, "migrated-voice");
        var migrated = new VoiceResources([file], migratedFolder, asrCache: cache);
        check(await migrated.IsReadyAsync(default) && File.Exists(Path.Combine(migratedFolder, file.Path)),
            "verified legacy ASR resources are materialized where both clients actually load them");
        check(transport.Requests == before + 1, "legacy cache reuse does not request a network payload");

        var inspections = 0;
        var bundled = new VoiceResources([file], Path.Combine(root, "scheduler"), _ =>
        { Interlocked.Increment(ref inspections); return new MemoryStream(bytes, false); });
        using var preparation = new VoicePreparation(bundled, () => new Uri("https://school.test/"), (_, _) => Task.FromResult(false));
        var inspected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        preparation.Changed += _ => inspected.TrySetResult();
        var baseline = inspections;
        preparation.Start(); preparation.Start();
        await inspected.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(150);
        check(inspections == baseline + 1, "reopening a window starts only one voice preparation scheduler");
        bool? automatic = null;
        var missing = new VoiceResources([file], Path.Combine(root, "activity-blocked-voice"));
        using var blocked = new VoicePreparation(missing, () => new Uri("https://school.test/"), (auto, _) =>
        { automatic = auto; return Task.FromResult(false); });
        await blocked.DownloadAsync();
        check(automatic == false && !blocked.IsDownloading && blocked.Current.Message.Contains("活动"),
            "manual preparation bypasses the schedule gate while reporting actual activity deferral");
    }

    private sealed class Transport(byte[] bytes) : HttpMessageHandler
    {
        internal bool Break, SafeRequest = true;
        internal long Offset;
        internal int Requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++; Offset = request.Headers.Range?.Ranges.First().From ?? 0;
            SafeRequest &= request.RequestUri!.Host == "school.test" && request.RequestUri.AbsolutePath.StartsWith("/api/voice/resources/")
                && request.Headers.Authorization is null && !request.Headers.Contains("Cookie");
            var response = new HttpResponseMessage(Offset > 0 ? HttpStatusCode.PartialContent : HttpStatusCode.OK)
                { Content = new StreamContent(new Interrupted(bytes[(int)Offset..], Break)) };
            response.Content.Headers.ContentLength = bytes.Length - Offset;
            if (Offset > 0) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(Offset, bytes.Length - 1, bytes.Length);
            return Task.FromResult(response);
        }
    }
    private sealed class Interrupted(byte[] bytes, bool broken) : MemoryStream(bytes, false)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (broken && Position > 0) throw new IOException("connection lost");
            return base.ReadAsync(buffer, cancellationToken);
        }
    }
}

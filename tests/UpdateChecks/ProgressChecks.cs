using System.Security.Cryptography;
using ICeClass.Updates;

internal static class ProgressChecks
{
    internal static async Task RunAsync(string root, Action<bool, string> check)
    {
        var install = Path.Combine(root, "progress");
        Directory.CreateDirectory(install);
        var bytes = new byte[1024 * 1024];
        Random.Shared.NextBytes(bytes);
        var file = new UpdateFile { Path = "ICeClass.exe", Size = bytes.Length,
            Sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), DownloadUrl = "/payload/progress" };
        var plan = new UpdatePlan { Available = true, Version = "9.5.0", Files = [file] };
        var transport = new PayloadHandler { FailAfterBytes = 262144 };
        transport.Payloads[file.DownloadUrl] = bytes;
        using var client = new HttpClient(transport);
        var values = new List<UpdateProgress>();
        try
        {
            await IncrementalUpdates.PrepareAsync(new Uri("https://school.example/"), plan, install,
                "ICeClass.exe", client, null, null, new Capture(values.Add), default);
        }
        catch (IOException) { }
        check(values.Any(value => value.Stage == UpdateStage.Downloading && value.Percentage is > 0 and < 100),
            "download progress advances before a large file finishes or its connection fails");
        check(UpdateInstaller.LoadPending(install, "ICeClass.exe") is null,
            "an interrupted download is never presented as ready to install");

        var savedBytes = new FileInfo(Directory.GetFiles(install, "*.download", SearchOption.AllDirectories).Single()).Length;
        check(values.Last(value => value.Stage == UpdateStage.Downloading).DownloadedBytes == savedBytes,
            "an interrupted transfer publishes its final saved bytes even within the UI throttle interval");
        values.Clear(); transport.FailAfterBytes = null;
        await IncrementalUpdates.PrepareAsync(new Uri("https://school.example/"), plan, install,
            "ICeClass.exe", client, null, null, new Capture(values.Add), default);
        var resumed = values.First(value => value.Stage == UpdateStage.Downloading);
        check(resumed.DownloadedBytes == savedBytes && resumed.TotalBytes == file.Size && transport.LastRange == savedBytes,
            "resuming displays previously saved bytes before receiving more data");
        check(values.Last() is { Stage: UpdateStage.Verifying, Percentage: 100 } &&
              UpdateInstaller.LoadPending(install, "ICeClass.exe")?.Version == plan.Version,
            "download completion is followed by verification before the update becomes ready");

        values.Clear(); transport.Requests.Clear();
        await IncrementalUpdates.PrepareAsync(new Uri("https://school.example/"), plan, install,
            "ICeClass.exe", client, null, null, new Capture(values.Add), default);
        check(transport.Requests.Count == 0 && values.All(value => value.Stage != UpdateStage.Downloading),
            "verified staged files are reused without showing a fictitious download");

        var voiceBytes = new byte[524288]; Random.Shared.NextBytes(voiceBytes);
        var voice = new UpdateFile { Path = "VoiceResources/Asr/changed.onnx", Size = voiceBytes.Length,
            Sha256 = Convert.ToHexString(SHA256.HashData(voiceBytes)).ToLowerInvariant(), DownloadUrl = "/payload/changed" };
        var bundledBytes = new byte[262144]; Random.Shared.NextBytes(bundledBytes);
        var bundled = new UpdateFile { Path = "VoiceResources/Asr/reused.onnx", Size = bundledBytes.Length,
            Sha256 = Convert.ToHexString(SHA256.HashData(bundledBytes)).ToLowerInvariant(), DownloadUrl = "/payload/reused" };
        transport.Payloads[voice.DownloadUrl] = voiceBytes;
        values.Clear(); transport.Requests.Clear();
        await IncrementalUpdates.PrepareAsync(new Uri("https://school.example/"), plan with { Files = [file, bundled, voice] },
            Path.Combine(root, "weighted-progress"), "ICeClass.exe", client, null,
            path => path == bundled.Path ? new MemoryStream(bundledBytes, false) : null, new Capture(values.Add), default);
        var downloading = values.Where(value => value.Stage == UpdateStage.Downloading).ToList();
        check(downloading.All(value => value.TotalBytes == file.Size + voice.Size) &&
              transport.Requests.SequenceEqual([file.DownloadUrl, voice.DownloadUrl]),
            "overall download size excludes reusable offline voice resources");
        check(downloading.First(value => value.DownloadedBytes > 0).Percentage < 50 &&
              downloading.Last().DownloadedBytes == file.Size + voice.Size && downloading.Last().Percentage == 100,
            "multiple payloads share one byte-weighted percentage rather than a file-count percentage");
    }

    internal sealed class Capture(Action<UpdateProgress> report) : IProgress<UpdateProgress>
    {
        public void Report(UpdateProgress value) => report(value);
    }
}

using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ICeClass.Updates;

try
{
    await RunChecksAsync(args);
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine("Update checks failed: " + error);
    return 1;
}

async Task RunChecksAsync(string[] arguments)
{
if (InstallerChecks.TryRunPendingProbe(arguments)) return;

var root = Path.Combine(Path.GetTempPath(), "ICeClass-UpdateChecks-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var passed = 0;
void Check(bool ok, string message) { if (!ok) throw new Exception(message); passed++; Console.WriteLine("PASS " + message); }
async Task Reject(Func<Task> action, string message)
{
    try { await action(); } catch (Exception error) when (error is InvalidDataException or HttpRequestException or IOException) { Check(true, message); return; }
    throw new Exception(message);
}
string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
var origin = new Uri("https://school.example/");
var oldApp = Encoding.UTF8.GetBytes(new string('x', 400000) + "old application");
var newApp = Encoding.UTF8.GetBytes(new string('x', 400000) + "new application");
var voice = Encoding.UTF8.GetBytes("unchanged offline voice resource");
var transport = new PayloadHandler();
using var client = new HttpClient(transport);
var install = Path.Combine(root, "install"); Directory.CreateDirectory(install);
File.WriteAllBytes(Path.Combine(install, "ICeClass.exe"), oldApp);
Directory.CreateDirectory(Path.Combine(install, "VoiceResources", "Asr"));
File.WriteAllBytes(Path.Combine(install, "VoiceResources", "Asr", "model.int8.onnx"), voice);
var appFile = new UpdateFile { Path = "ICeClass.exe", Size = newApp.Length, Sha256 = Hash(newApp), DownloadUrl = "/payload/app" };
var voiceFile = new UpdateFile { Path = "VoiceResources/Asr/model.int8.onnx", Size = voice.Length, Sha256 = Hash(voice), DownloadUrl = "/payload/voice" };
var plan = new UpdatePlan { Available = true, Version = "9.0.0", Files = [appFile, voiceFile] };
transport.Payloads["/payload/app"] = newApp; transport.Payloads["/payload/voice"] = voice;
try
{
    var prepared = await IncrementalUpdates.PrepareAsync(origin, plan, install, "ICeClass.exe", client, null, null, null, default);
    Check(transport.Requests.Count == 1 && transport.Requests[0] == "/payload/app", "unchanged voice files never download");
    Check(File.ReadAllBytes(Path.Combine(install, "ICeClass.exe")).SequenceEqual(oldApp), "preparing an update leaves the running application unchanged");
    Check(prepared.Files.Count == 1 && File.ReadAllBytes(prepared.Files[0].StagedPath).SequenceEqual(newApp), "only changed files are staged and verified");
    Check(UpdateInstaller.LoadPending(install, "ICeClass.exe")?.Version == "9.0.0", "a verified update remains pending until a future launch");

    var bundledInstall = Path.Combine(root, "bundled"); Directory.CreateDirectory(bundledInstall);
    File.WriteAllBytes(Path.Combine(bundledInstall, "ICeClass.exe"), newApp);
    transport.Requests.Clear();
    var bundled = await IncrementalUpdates.PrepareAsync(origin, plan, bundledInstall, "ICeClass.exe", client, null,
        path => path == voiceFile.Path ? new MemoryStream(voice, false) : null, null, default);
    Check(transport.Requests.Count == 0 && bundled.Files.Count == 1, "the full offline executable can supply unchanged voice resources without network");

    foreach (var (name, replacement) in new[]
    {
        ("different size", Encoding.UTF8.GetBytes("a new offline voice resource with a different model size")),
        ("same size, different hash", Enumerable.Repeat((byte)'n', voice.Length).ToArray())
    })
    {
        var changedInstall = Path.Combine(root, "changed embedded voice " + name); Directory.CreateDirectory(changedInstall);
        File.WriteAllBytes(Path.Combine(changedInstall, "ICeClass.exe"), newApp);
        var changedVoice = voiceFile with { Size = replacement.Length, Sha256 = Hash(replacement), DownloadUrl = "/payload/new-voice" };
        transport.Payloads[changedVoice.DownloadUrl] = replacement; transport.Requests.Clear();
        var changed = await IncrementalUpdates.PrepareAsync(origin, plan with { Version = "9.0.1", Files = [appFile, changedVoice] },
            changedInstall, "ICeClass.exe", client, null, path => path == voiceFile.Path ? new MemoryStream(voice, false) : null, null, default);
        Check(transport.Requests.SequenceEqual(["/payload/new-voice"]) && changed.Files.Count == 1 &&
              changed.Files[0].Path == voiceFile.Path && File.ReadAllBytes(changed.Files[0].StagedPath).SequenceEqual(replacement),
              "an older embedded voice resource downloads the new payload: " + name);
    }

    foreach (var path in new[] { "../config.json", "VoiceResources/../config.json", "C:/bad.exe", "VoiceResources/CON", "VoiceResources/file:secret", "VoiceResources/Asr./file", "VoiceResources\\Asr\\x", "config.json" })
        await Reject(() => IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile with { Path = path }] }, install, "ICeClass.exe", client, null, null, null, default), "unsafe update path rejected: " + path);
    await Reject(() => IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile, appFile] }, install, "ICeClass.exe", client, null, null, null, default), "duplicate destinations rejected before downloading");
    await Reject(() => IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile with { DownloadUrl = "https://attacker.example/file" }] }, install, "ICeClass.exe", client, null, null, null, default), "cross-origin payload rejected");
    await Reject(() => IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile with { Sha256 = new string('a', 64) }] }, install, "ICeClass.exe", client, null, null, null, default), "wrong full-file hash never becomes ready");

    var resumeInstall = Path.Combine(root, "resume"); Directory.CreateDirectory(resumeInstall);
    File.WriteAllBytes(Path.Combine(resumeInstall, "ICeClass.exe"), oldApp);
    transport.FailAfterBytes = 131072; transport.Requests.Clear();
    await Reject(() => IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile] }, resumeInstall, "ICeClass.exe", client, null, null, null, default), "interrupted download leaves a resumable partial file");
    transport.FailAfterBytes = null;
    await IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile] }, resumeInstall, "ICeClass.exe", client, null, null, null, default);
    Check(transport.LastRange is > 0, "retry requests only the remaining bytes");

    var patchSource = Path.Combine(root, "source.bin"); var patchTarget = Path.Combine(root, "target.bin"); var patchPath = Path.Combine(root, "change.delta");
    File.WriteAllBytes(patchSource, oldApp); File.WriteAllBytes(patchTarget, newApp);
    DeltaFixture.Create(patchSource, patchTarget, patchPath);
    var patch = File.ReadAllBytes(patchPath);
    Check(patch.Length < newApp.Length, "Windows produces a smaller real binary patch");
    var delta = new UpdateDelta { SourceSha256 = Hash(oldApp), Size = patch.Length, Sha256 = Hash(patch), DownloadUrl = "/payload/patch" };
    transport.Payloads["/payload/patch"] = patch; transport.Requests.Clear();
    var deltaInstall = Path.Combine(root, "delta"); Directory.CreateDirectory(deltaInstall); File.WriteAllBytes(Path.Combine(deltaInstall, "ICeClass.exe"), oldApp);
    var patched = await IncrementalUpdates.PrepareAsync(origin, plan with { Files = [appFile with { Deltas = [delta] }] }, deltaInstall, "ICeClass.exe", client, null, null, null, default);
    Check(transport.Requests.SequenceEqual(["/payload/patch"]) && File.ReadAllBytes(patched.Files[0].StagedPath).SequenceEqual(newApp), "matching source downloads only a patch and reconstructs the exact new executable");
    File.WriteAllText(Path.Combine(deltaInstall, "ICeClass.exe"), "a different installed version"); transport.Requests.Clear();
    // A different target version forces a new staging identity; it must not reuse the old prepared file.
    await IncrementalUpdates.PrepareAsync(origin, plan with { Version = "9.0.1", Files = [appFile with { Deltas = [delta] }] }, deltaInstall, "ICeClass.exe", client, null, null, null, default);
    Check(transport.Requests.SequenceEqual(["/payload/app"]), "an unmatched source uses the changed file instead of an invalid patch");
    File.WriteAllText(patched.Files[0].StagedPath, "tampered");
    await Reject(() => UpdateInstaller.ValidateAsync(patched, installDirectory: deltaInstall, executableName: "ICeClass.exe", default), "installer rechecks staged data before any replacement");
    await InstallerChecks.RunAsync(root, Check);
    Console.WriteLine($"Update checks passed: {passed}");
}
finally { Directory.Delete(root, true); }
}

sealed class PayloadHandler : HttpMessageHandler
{
    internal readonly Dictionary<string, byte[]> Payloads = [];
    internal readonly List<string> Requests = [];
    internal int? FailAfterBytes;
    internal long? LastRange;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var key = request.RequestUri!.AbsolutePath; Requests.Add(key);
        if (!Payloads.TryGetValue(key, out var data)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        LastRange = request.Headers.Range?.Ranges.First().From;
        var offset = LastRange ?? 0;
        var response = new HttpResponseMessage(offset > 0 ? HttpStatusCode.PartialContent : HttpStatusCode.OK)
        { Content = new StreamContent(new BrokenStream(data[(int)offset..], FailAfterBytes)) };
        response.Content.Headers.ContentLength = data.Length - offset;
        if (offset > 0) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, data.Length - 1, data.Length);
        return Task.FromResult(response);
    }
}
sealed class BrokenStream(byte[] bytes, int? failAfter) : MemoryStream(bytes, false)
{
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (failAfter is { } limit && Position >= limit) throw new IOException("simulated network loss");
        return base.ReadAsync(buffer, cancellationToken);
    }
}
static class DeltaFixture
{
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Input { public IntPtr Start; public UIntPtr Size; public int Editable; }
    [System.Runtime.InteropServices.DllImport("msdelta.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreateDeltaW(long type, long set, long reset, string source, string target, string? sourceOptions, string? targetOptions, Input options, IntPtr time, uint hash, string output);
    internal static void Create(string source, string target, string output)
    { if (!CreateDeltaW(1, 0, 0, source, target, null, null, default, IntPtr.Zero, 0, output)) throw new System.ComponentModel.Win32Exception(); }
}

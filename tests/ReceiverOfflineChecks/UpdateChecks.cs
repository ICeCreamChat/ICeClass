using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ICeClass.Receiver;

internal static class UpdateChecks
{
    public static async Task<int> Run()
    {
        var portProbe = new TcpListener(IPAddress.Loopback, 0); portProbe.Start();
        var port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        using var stop = new CancellationTokenSource();
        var bytes = new byte[512 * 1024]; new Random(17).NextBytes(bytes);
        var version = "99.0.1"; var mode = "interrupt"; string? observedRange = null; var downloadCount = 0;
        var sha = () => Convert.ToHexString(SHA256.HashData(bytes));
        var serving = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                HttpListenerContext context;
                try { context = await listener.GetContextAsync().WaitAsync(stop.Token); } catch { break; }
                var response = context.Response;
                try
                {
                    if (context.Request.Headers["Authorization"] != "Bearer fixture") { response.StatusCode = 401; response.Close(); continue; }
                    if (context.Request.Url!.AbsolutePath == "/api/receiver/update")
                    {
                        var manifest = JsonSerializer.SerializeToUtf8Bytes(new { available = true, version, size = bytes.Length, sha256 = sha(), downloadUrl = "/file" });
                        response.ContentLength64 = manifest.Length; response.ContentType = "application/json";
                        await response.OutputStream.WriteAsync(manifest); response.Close(); continue;
                    }
                    ++downloadCount; observedRange = context.Request.Headers["Range"];
                    var offset = observedRange is null ? 0 : int.Parse(observedRange.Split('=')[1].TrimEnd('-'));
                    if (mode == "ignore-range") offset = 0;
                    if (offset > 0)
                    {
                        response.StatusCode = 206;
                        response.Headers["Content-Range"] = $"bytes {offset}-{bytes.Length - 1}/{bytes.Length}";
                    }
                    response.ContentLength64 = bytes.Length - offset;
                    if (mode == "interrupt")
                    {
                        await response.OutputStream.WriteAsync(bytes.AsMemory(offset, 128 * 1024));
                        await response.OutputStream.FlushAsync(); await Task.Delay(100); response.Abort();
                    }
                    else
                    {
                        if (mode == "bad-range") response.Headers["Content-Range"] = $"bytes 0-{bytes.Length - 1}/{bytes.Length}";
                        var output = bytes.AsMemory(offset).ToArray();
                        if (mode == "bad-hash") output[0] ^= 0xff;
                        await response.OutputStream.WriteAsync(output); response.Close();
                    }
                }
                catch { response.Abort(); }
            }
        });
        var checks = 0;
        void Check(bool condition, string text) { if (!condition) throw new Exception(text); ++checks; Console.WriteLine("PASS " + text); }
        var config = new ReceiverConfig { Endpoint = $"http://127.0.0.1:{port}", DeviceId = "fixture", DeviceToken = "fixture" };
        var updates = new ReceiverUpdateService();
        var directory = Path.Combine(AppContext.BaseDirectory, ".updates");
        Directory.CreateDirectory(directory);
        string Partial() => Path.Combine(directory, $"ICeClass-{version}.download");
        async Task Interrupted()
        {
            try { await updates.CheckAndDownloadAsync(config, null, default); throw new Exception("Interrupted transfer completed"); }
            catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException) { }
        }
        try
        {
            // Unique fixture versions only; never install or touch a running application.
            foreach (var name in new[] { "99.0.1", "99.0.2", "99.0.3", "99.0.4" })
                foreach (var suffix in new[] { ".download", ".download.json", ".exe" }) File.Delete(Path.Combine(directory, "ICeClass-" + name + suffix));
            await Interrupted();
            Check(File.Exists(Partial()) && new FileInfo(Partial()).Length is > 0 and < 524288, "interrupted update retains downloaded bytes");
            var saved = new FileInfo(Partial()).Length;
            mode = "complete";
            var ready = await updates.CheckAndDownloadAsync(config, null, default);
            Check(observedRange == $"bytes={saved}-" && File.ReadAllBytes(ready.DownloadedPath!).SequenceEqual(bytes), "retry resumes at the saved offset and verifies the complete executable");
            var before = downloadCount;
            await updates.CheckAndDownloadAsync(config, null, default);
            Check(downloadCount == before, "a verified ready update is reused without downloading again");
            version = "99.0.2"; mode = "interrupt"; await Interrupted(); saved = new FileInfo(Partial()).Length; mode = "ignore-range";
            ready = await updates.CheckAndDownloadAsync(config, null, default);
            Check(observedRange == $"bytes={saved}-" && File.ReadAllBytes(ready.DownloadedPath!).SequenceEqual(bytes), $"a server ignoring Range restarts the file instead of appending corrupt data (saved {saved}, requested {observedRange})");
            version = "99.0.3"; mode = "interrupt"; await Interrupted(); bytes[3] ^= 0xff; mode = "complete";
            ready = await updates.CheckAndDownloadAsync(config, null, default);
            Check(observedRange is null && File.ReadAllBytes(ready.DownloadedPath!).SequenceEqual(bytes), "a changed manifest discards incompatible partial bytes");
            version = "99.0.4"; mode = "bad-hash";
            try { await updates.CheckAndDownloadAsync(config, null, default); throw new Exception("Bad hash accepted"); } catch (InvalidOperationException) { }
            Check(!File.Exists(Partial()) && !File.Exists(Path.Combine(directory, "ICeClass-99.0.4.exe")), "corrupt completed downloads are not promoted to installable updates");
            mode = "complete";
            using var cancel = new CancellationTokenSource();
            try { await updates.CheckAndDownloadAsync(config, new ImmediateProgress(_ => cancel.Cancel()), cancel.Token); } catch (OperationCanceledException) { }
            Check(File.Exists(Partial()) && new FileInfo(Partial()).Length > 0, "pausing an update for a lesson retains its partial download");
            ready = await updates.CheckAndDownloadAsync(config, null, default);
            Check(File.ReadAllBytes(ready.DownloadedPath!).SequenceEqual(bytes), "a paused update can finish on the next idle check");
            return checks;
        }
        finally
        {
            stop.Cancel(); listener.Stop(); await serving;
            foreach (var name in new[] { "99.0.1", "99.0.2", "99.0.3", "99.0.4" })
                foreach (var suffix in new[] { ".download", ".download.json", ".exe" }) File.Delete(Path.Combine(directory, "ICeClass-" + name + suffix));
        }
    }
    private sealed class ImmediateProgress(Action<int> action) : IProgress<int> { public void Report(int value) => action(value); }
}

using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using ICeClass.Desktop;

internal static class DownloadChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-DownloadChecks-" + Guid.NewGuid().ToString("N"));
        var bytes = Enumerable.Range(0, 100).Select(i => (byte)i).ToArray();
        var release = new DesktopRelease("9.9.9", Convert.ToHexString(SHA256.HashData(bytes)), bytes.Length, "/api/desktop/update/download");
        const string endpoint = "https://school.example";
        try
        {
            var call = 0;
            using var resume = new HttpClient(new Handler(request =>
            {
                if (++call == 1) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new BrokenStream(bytes[..40])) };
                Assert(request.Headers.Range?.Ranges.Single().From == 40, "Interrupted download requests remaining bytes");
                var content = new ByteArrayContent(bytes[40..]); content.Headers.ContentRange = new ContentRangeHeaderValue(40, 99, 100);
                return new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = content };
            }));
            try { await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, resume); throw new Exception("Expected interrupted stream"); }
            catch (IOException) { checks++; }
            var partial = Directory.GetFiles(directory, "*.download").Single();
            Assert(new FileInfo(partial).Length == 40, "Interrupted bytes retained for retry");
            var completed = await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, resume);
            Assert(File.ReadAllBytes(completed).SequenceEqual(bytes), "Resumed download passes integrity check");
            await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, resume);
            Assert(call == 2, "Complete verified file reused without downloading again");

            File.WriteAllBytes(completed, bytes[..20]);
            using var ignoredRange = new HttpClient(new Handler(request =>
            {
                Assert(request.Headers.Range?.Ranges.Single().From == 20, "Partial file creates Range request");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
            }));
            await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, ignoredRange);
            Assert(File.ReadAllBytes(completed).SequenceEqual(bytes), "Server ignoring Range restarts cleanly");

            File.WriteAllBytes(completed, bytes[..20]);
            using var wrongRange = new HttpClient(new Handler(_ =>
            {
                var content = new ByteArrayContent(bytes[30..]); content.Headers.ContentRange = new ContentRangeHeaderValue(30, 99, 100);
                return new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = content };
            }));
            try { await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, wrongRange); throw new Exception("Accepted wrong Range"); }
            catch (InvalidOperationException) { checks++; }
            Assert(new FileInfo(completed).Length == 20, "Invalid Range does not overwrite saved bytes");

            using var corrupt = new HttpClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[100]) }));
            try { await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, corrupt); throw new Exception("Accepted corrupt update"); }
            catch (InvalidOperationException) { checks++; }
            Assert(!File.Exists(completed), "Corrupt update discarded");

            using var redirect = new HttpClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://foreign.example/update.exe") } }));
            try { await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, redirect); throw new Exception("Accepted redirect"); }
            catch (HttpRequestException) { checks++; }

            using var oversized = new HttpClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[101]) }));
            try { await DesktopUpdates.DownloadAsync(endpoint, release, null, default, directory, oversized); throw new Exception("Accepted oversized update"); }
            catch (InvalidOperationException) { checks++; }
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return checks;
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(handle(request));
    }

    private sealed class BrokenStream(byte[] firstChunk) : MemoryStream(firstChunk)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (Position == Length) throw new IOException("Simulated connection loss");
            return base.ReadAsync(buffer, token);
        }
    }
}

using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using ICeClass.Updates;

internal static class VoicePreparationChecks
{
    internal static async Task RunAsync(string root, Action<bool, string> check)
    {
        var bytes = new byte[400000]; Random.Shared.NextBytes(bytes);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var file = new VoiceResourceFile("VoiceResources/Asr/model.int8.onnx", bytes.Length, hash);
        var folder = Path.Combine(root, "voice-scheduler-transfer");
        using var server = new SlowServer(bytes);
        var resources = new VoiceResources([file], folder);
        var activity = false;
        using var preparation = new VoicePreparation(resources, () => server.Origin, (_, _) => Task.FromResult(!Volatile.Read(ref activity)));
        static async Task Until(Func<bool> ready)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (!ready()) await Task.Delay(20, deadline.Token);
        }
        var first = preparation.DownloadAsync();
        await Until(() => preparation.Current.Progress?.DownloadedBytes > 0);
        await preparation.DownloadAsync(); await first.WaitAsync(TimeSpan.FromSeconds(5));
        check(!preparation.IsDownloading && !preparation.Current.Ready && preparation.Current.Message.Contains("已暂停"),
            "the manual pause button stops an actual HTTP transfer without claiming readiness");
        check(new FileInfo(Path.Combine(folder, ".updates/voice-resources/" + hash + ".download")).Length > 0,
            "manual pause preserves verified transfer staging for the next request");
        var resumed = preparation.DownloadAsync();
        await Until(() => server.Requests >= 2 && preparation.Current.Progress?.DownloadedBytes > 0);
        Volatile.Write(ref activity, true);
        await resumed.WaitAsync(TimeSpan.FromSeconds(5));
        check(!preparation.IsDownloading && preparation.Current.Message.Contains("空闲"),
            "an activity beginning during a manual transfer cancels it promptly");
        var requests = server.Requests;
        await preparation.DownloadAsync();
        check(server.Requests == requests && preparation.Current.Message.Contains("活动"),
            "continuing during a real activity waits without another HTTP request");
        Volatile.Write(ref activity, false); server.Complete();
        await preparation.DownloadAsync().WaitAsync(TimeSpan.FromSeconds(5));
        check(preparation.Current.Ready && resources.Ready && server.Resumed &&
              (await File.ReadAllBytesAsync(Path.Combine(folder, file.Path))).SequenceEqual(bytes),
            "continuing after activity resumes the partial payload and publishes only the exact verified model");
        check(!File.Exists(Path.Combine(folder, ".updates/pending.json")), "manual resource completion never creates a program update");
        Volatile.Write(ref activity, true);
        await preparation.DownloadAsync();
        check(preparation.Current.Ready && !preparation.IsDownloading,
            "requesting an already-ready model keeps the ready state during another activity");
    }

    private sealed class SlowServer : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly CancellationTokenSource _lifetime = new();
        private readonly TaskCompletionSource _complete = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Uri Origin { get; }
        internal int Requests;
        internal bool Resumed;
        internal SlowServer(byte[] bytes)
        {
            using var port = new TcpListener(IPAddress.Loopback, 0); port.Start();
            Origin = new Uri("http://127.0.0.1:" + ((IPEndPoint)port.LocalEndpoint).Port + "/"); port.Stop();
            _listener.Prefixes.Add(Origin.AbsoluteUri); _listener.Start();
            _ = Task.Run(async () =>
            {
                try { while (!_lifetime.IsCancellationRequested) _ = Send(await _listener.GetContextAsync().WaitAsync(_lifetime.Token), bytes); }
                catch (Exception error) when (error is HttpListenerException or OperationCanceledException or ObjectDisposedException) { }
            });
        }
        private async Task Send(HttpListenerContext request, byte[] bytes)
        {
            try
            {
                var offset = request.Request.Headers["Range"] is { } range ? int.Parse(range[6..].TrimEnd('-')) : 0;
                Resumed |= offset > 0; Interlocked.Increment(ref Requests);
                request.Response.StatusCode = offset > 0 ? 206 : 200;
                if (offset > 0) request.Response.Headers["Content-Range"] = $"bytes {offset}-{bytes.Length - 1}/{bytes.Length}";
                request.Response.ContentLength64 = bytes.Length - offset;
                var first = Math.Min(65536, bytes.Length - offset);
                await request.Response.OutputStream.WriteAsync(bytes.AsMemory(offset, first), _lifetime.Token);
                await request.Response.OutputStream.FlushAsync(_lifetime.Token);
                await _complete.Task.WaitAsync(_lifetime.Token);
                await request.Response.OutputStream.WriteAsync(bytes.AsMemory(offset + first), _lifetime.Token);
            }
            catch (Exception error) when (error is HttpListenerException or IOException or OperationCanceledException or ObjectDisposedException) { }
            finally { request.Response.Close(); }
        }
        internal void Complete() => _complete.TrySetResult();
        public void Dispose() { _lifetime.Cancel(); _listener.Close(); }
    }
}

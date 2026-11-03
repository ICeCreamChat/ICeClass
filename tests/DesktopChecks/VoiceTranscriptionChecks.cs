using System.Net;
using System.Security.Cryptography;
using ICeClass.Desktop;
using ICeClass.Updates;
using NAudio.Wave;

internal static class VoiceTranscriptionChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-VoiceModelChecks-" + Guid.NewGuid().ToString("N"));
        byte[] bytes = [11, 22, 33, 44];
        var file = new VoiceResourceFile("VoiceResources/Asr/model.int8.onnx", bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)));
        var store = new VoiceResources([file], directory);
        var calls = 0;
        var responseBytes = bytes;
        using var http = new HttpClient(new Handler(request =>
        {
            calls++;
            Assert(request.RequestUri!.Scheme == "https" && request.RequestUri.Host == "school.test", "Model download uses the school platform");
            Assert(!request.Headers.Contains("Cookie") && request.Headers.Authorization is null, "Model requests never send a school session or recording");
            Assert(request.RequestUri.AbsolutePath.StartsWith("/api/voice/resources/"), "Model source is content-addressed voice data");
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(responseBytes) };
        }));
        try
        {
            await store.PrepareAsync(new Uri("https://school.test/"), http, null, default);
            var path = Path.Combine(directory, file.Path);
            Assert(File.Exists(path) && File.ReadAllBytes(path).SequenceEqual(bytes), "The first explicit download installs a verified model");
            var before = calls;
            await store.PrepareAsync(new Uri("https://school.test/"), http, null, default);
            Assert(calls == before, "An existing classroom model is reused without a download");
            File.WriteAllBytes(path, [1, 2, 3, 4]);
            await store.PrepareAsync(new Uri("https://school.test/"), http, null, default);
            Assert(calls == before + 1 && File.ReadAllBytes(path).SequenceEqual(bytes), "An explicit download repairs a corrupt model");
            File.Delete(path);
            responseBytes = [1, 2, 3, 4];
            try { await store.PrepareAsync(new Uri("https://school.test/"), http, null, default); throw new Exception("Installed an invalid model"); }
            catch (InvalidDataException) { checks++; }
            Assert(!File.Exists(path) && !Directory.EnumerateFiles(directory, "*.download", SearchOption.AllDirectories).Any(), "A failed hash leaves no usable or partial model");
            responseBytes = new byte[bytes.Length + 1];
            try { await store.PrepareAsync(new Uri("https://school.test/"), http, null, default); throw new Exception("Installed an oversized model"); }
            catch (InvalidDataException) { checks++; }
            using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
            try { await store.PrepareAsync(new Uri("https://school.test/"), http, null, cancellation.Token); throw new Exception("Ignored cancellation"); }
            catch (OperationCanceledException) { checks++; }
            Assert(!Directory.EnumerateFiles(directory, "*.download", SearchOption.AllDirectories).Any(), "Cancellation does not publish an unverified model");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        byte[] Wave(int rate, int channels, double seconds)
        {
            using var stream = new MemoryStream();
            using (var writer = new WaveFileWriter(stream, new WaveFormat(rate, 16, channels)))
            {
                var pcm = new byte[(int)(rate * channels * 2 * seconds)];
                for (var i = 0; i < pcm.Length; i += 2) { pcm[i] = 0; pcm[i + 1] = 32; }
                writer.Write(pcm, 0, pcm.Length);
            }
            return stream.ToArray();
        }
        Assert(ClassroomVoiceTranscriber.ReadSamples(Wave(16000, 1, 1)).Length == 16000, "A complete utterance is decoded at the existing Banban sample rate");
        Assert(Math.Abs(ClassroomVoiceTranscriber.ReadSamples(Wave(22050, 1, 1)).Length - 16000) <= 1, "Classroom WAV audio is resampled before recognition");
        foreach (var invalid in new[] { Wave(16000, 2, 1), Wave(16000, 1, .2), Wave(16000, 1, 30.1) })
        {
            try { ClassroomVoiceTranscriber.ReadSamples(invalid); throw new Exception("Recognized invalid classroom audio"); }
            catch (InvalidDataException) { checks++; }
        }
        return checks;
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(send(request));
    }
}

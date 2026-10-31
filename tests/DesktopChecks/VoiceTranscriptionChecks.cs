using System.Net;
using System.Security.Cryptography;
using ICeClass.Desktop;
using NAudio.Wave;

internal static class VoiceTranscriptionChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-VoiceModelChecks-" + Guid.NewGuid().ToString("N"));
        byte[] bytes = [11, 22, 33, 44];
        var file = new VoiceModelFile("model.int8.onnx", bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)));
        var calls = 0;
        var responseBytes = bytes;
        using var http = new HttpClient(new Handler(request =>
        {
            calls++;
            Assert(request.RequestUri!.Scheme == "https" && request.RequestUri.Host == "huggingface.co", "Model download uses the pinned public source");
            Assert(!request.Headers.Contains("Cookie") && request.Headers.Authorization is null, "Model requests never send a school session or recording");
            Assert(request.RequestUri.AbsolutePath.Contains("2365baeacb507f821a0c8120fcee3d484dba7a07"), "Model source is pinned to the classroom ASR revision");
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(responseBytes) };
        }));
        try
        {
            await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, default);
            var path = Path.Combine(directory, file.Name);
            Assert(File.Exists(path) && File.ReadAllBytes(path).SequenceEqual(bytes), "The first explicit download installs a verified model");
            var before = calls;
            await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, default);
            Assert(calls == before, "An existing classroom model is reused without a download");
            File.WriteAllBytes(path, [1, 2, 3, 4]);
            await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, default);
            Assert(calls == before + 1 && File.ReadAllBytes(path).SequenceEqual(bytes), "An explicit download repairs a corrupt model");
            File.Delete(path);
            responseBytes = [1, 2, 3, 4];
            try { await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, default); throw new Exception("Installed an invalid model"); }
            catch (InvalidDataException) { checks++; }
            Assert(!File.Exists(path) && !Directory.EnumerateFiles(directory).Any(), "A failed hash leaves no usable or partial model");
            responseBytes = new byte[bytes.Length + 1];
            try { await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, default); throw new Exception("Installed an oversized model"); }
            catch (InvalidDataException) { checks++; }
            using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
            try { await ClassroomVoiceTranscriber.EnsureModelsAsync(directory, [file], http, null, cancellation.Token); throw new Exception("Ignored cancellation"); }
            catch (OperationCanceledException) { checks++; }
            Assert(!Directory.EnumerateFiles(directory).Any(), "Canceling a download leaves no partial files");
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

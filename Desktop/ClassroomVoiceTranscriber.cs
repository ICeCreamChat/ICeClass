using System.Security.Cryptography;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace ICeClass.Desktop;

internal sealed record VoiceModelFile(string Name, long Size, string Sha256);

internal static class ClassroomVoiceTranscriber
{
    private const string Source = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/";
    // This client only downloads public models. School cookies and audio never pass through it.
    private static readonly HttpClient ModelClient = new(new HttpClientHandler { UseCookies = false })
        { Timeout = TimeSpan.FromMinutes(10) };
    private static readonly VoiceModelFile[] Files = ReadManifest();
    internal static string ModelDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ICeClass", "Voice", "sensevoice-small-int8-2365baea");

    internal static async Task<bool> ModelsReadyAsync(CancellationToken token)
    {
        foreach (var file in Files)
            if (!await VerifyAsync(Path.Combine(ModelDirectory, file.Name), file, token).ConfigureAwait(false)) return false;
        return true;
    }

    internal static Task EnsureModelsAsync(IProgress<int>? progress, CancellationToken token) =>
        EnsureModelsAsync(ModelDirectory, Files, ModelClient, progress, token);

    internal static async Task EnsureModelsAsync(string directory, IReadOnlyList<VoiceModelFile> files,
        HttpClient client, IProgress<int>? progress, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Directory.CreateDirectory(directory);
        long completed = 0;
        var total = files.Sum(file => file.Size);
        foreach (var file in files)
        {
            if (Path.GetFileName(file.Name) != file.Name || file.Size <= 0) throw new InvalidDataException("识别模型信息不正确。");
            var path = Path.Combine(directory, file.Name);
            if (await VerifyAsync(path, file, token).ConfigureAwait(false))
            { completed += file.Size; progress?.Report((int)(completed * 100 / total)); continue; }
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".download";
            try
            {
                using var response = await client.GetAsync(Source + Uri.EscapeDataString(file.Name), HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength is long length && length != file.Size)
                    throw new InvalidDataException("识别模型大小不正确，请重试下载。");
                await using var input = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
                await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 131072, true))
                {
                    var buffer = new byte[131072]; long written = 0; var previous = -1;
                    while (true)
                    {
                        using var stalled = CancellationTokenSource.CreateLinkedTokenSource(token);
                        stalled.CancelAfter(TimeSpan.FromSeconds(30));
                        var count = await input.ReadAsync(buffer, stalled.Token).ConfigureAwait(false);
                        if (count == 0) break;
                        written += count;
                        if (written > file.Size) throw new InvalidDataException("识别模型大小不正确，请重试下载。");
                        await output.WriteAsync(buffer.AsMemory(0, count), token).ConfigureAwait(false);
                        var percent = (int)((completed + written) * 100 / total);
                        if (percent != previous) { progress?.Report(percent); previous = percent; }
                    }
                }
                if (!await VerifyAsync(temporary, file, token).ConfigureAwait(false))
                    throw new InvalidDataException("识别模型未通过完整性检查，请重新下载。");
                token.ThrowIfCancellationRequested();
                File.Move(temporary, path, true);
                completed += file.Size;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    internal static Task<string> TranscribeAsync(byte[] audio, CancellationToken token, string? modelDirectory = null) => Task.Run(() =>
    {
        token.ThrowIfCancellationRequested();
        var samples = ReadSamples(audio);
        if (!samples.Any(sample => Math.Abs(sample) > .001f)) return "";
        using var recognizer = new SenseVoiceRecognizer(modelDirectory ?? ModelDirectory);
        token.ThrowIfCancellationRequested();
        var text = recognizer.Recognize(samples);
        // Native inference runs off the UI thread and is allowed to finish before releasing its model.
        token.ThrowIfCancellationRequested();
        return text;
    }, token);

    internal static float[] ReadSamples(byte[] audio)
    {
        if (audio.Length > 4 * 1024 * 1024) throw new InvalidDataException("语音文件超出大小限制。");
        using var reader = new WaveFileReader(new MemoryStream(audio, writable: false));
        if (reader.TotalTime.TotalSeconds is < .5 or > 30 || reader.WaveFormat.Channels != 1
            || reader.WaveFormat.Encoding != WaveFormatEncoding.Pcm || reader.WaveFormat.BitsPerSample != 16
            || reader.WaveFormat.SampleRate is < 8000 or > 48000)
            throw new InvalidDataException("录音格式不正确，请使用 0.5 至 30 秒的单声道 WAV 录音。");
        ISampleProvider source = reader.ToSampleProvider();
        if (source.WaveFormat.SampleRate != 16000) source = new WdlResamplingSampleProvider(source, 16000);
        var samples = new List<float>(); var buffer = new float[4096]; int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            if (samples.Count + count > 30 * 16000) throw new InvalidDataException("语音不能超过 30 秒。");
            samples.AddRange(buffer.AsSpan(0, count).ToArray());
        }
        return samples.ToArray();
    }

    private static async Task<bool> VerifyAsync(string path, VoiceModelFile file, CancellationToken token)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != file.Size) return false;
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token).ConfigureAwait(false))
            .Equals(file.Sha256, StringComparison.OrdinalIgnoreCase);
    }

    private static VoiceModelFile[] ReadManifest()
    {
        using var stream = typeof(ClassroomVoiceTranscriber).Assembly.GetManifestResourceStream("ICeClass.Voice.Asr.manifest.json")
            ?? throw new FileNotFoundException("缺少语音识别模型清单。");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.GetProperty("files").Deserialize<VoiceModelFile[]>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }
}

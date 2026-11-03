using System.Security.Cryptography;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace ICeClass.Desktop;

internal sealed record VoiceModelFile(string Name, long Size, string Sha256);

internal static class ClassroomVoiceTranscriber
{
    internal static readonly ICeClass.Updates.VoiceResources Resources =
        ICeClass.Updates.VoiceResources.ForClient(typeof(ClassroomVoiceTranscriber).Assembly, teacher: true);
    private static readonly VoiceModelFile[] Files = ReadManifest();
    private static readonly string LegacyDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ICeClass", "Voice", "sensevoice-small-int8-2365baea");
    private static string _modelDirectory = LegacyDirectory;
    internal static string ModelDirectory => _modelDirectory;

    internal static async Task<bool> ModelsReadyAsync(CancellationToken token)
    {
        foreach (var directory in new[] { Path.Combine(AppContext.BaseDirectory, "VoiceResources", "Asr"), LegacyDirectory })
        {
            var ready = true;
            foreach (var file in Files)
                if (!await VerifyAsync(Path.Combine(directory, file.Name), file, token).ConfigureAwait(false)) { ready = false; break; }
            if (ready) { _modelDirectory = directory; return true; }
        }
        return false;
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

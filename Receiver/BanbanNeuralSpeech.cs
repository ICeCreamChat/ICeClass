using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using SherpaOnnx;

namespace ICeClass.Receiver;

internal static class BanbanNeuralVoicePack
{
    private static readonly object Gate = new();
    private static string? _extracted;
    internal static string Extract()
    {
        lock (Gate)
        {
            if (_extracted is not null) return _extracted;
            var assembly = typeof(BanbanNeuralVoicePack).Assembly;
            const string prefix = "ICeClass.Voice.Tts.";
            using var manifest = assembly.GetManifestResourceStream(prefix + "manifest.json")
                ?? throw new FileNotFoundException("缺少班班自然语音。");
            using var document = JsonDocument.Parse(manifest);
            var root = document.RootElement;
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Voice", root.GetProperty("version").GetString()!);
            Directory.CreateDirectory(folder);
            var files = root.GetProperty("files").EnumerateArray().ToArray();
            string Target(string name)
            {
                var target = Path.GetFullPath(Path.Combine(folder, name));
                if (!target.StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("自然语音模型路径无效。");
                return target;
            }
            bool Matches(string path, string hash)
            {
                if (!File.Exists(path)) return false;
                using var stream = File.OpenRead(path);
                return Convert.ToHexString(SHA256.HashData(stream)).Equals(hash, StringComparison.OrdinalIgnoreCase);
            }
            if (files.All(f => Matches(Target(f.GetProperty("name").GetString()!), f.GetProperty("sha256").GetString()!)))
                return _extracted = folder;
            var temporary = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".zip");
            try
            {
                using (var output = File.Create(temporary))
                    foreach (var part in root.GetProperty("parts").EnumerateArray())
                    {
                        using var input = assembly.GetManifestResourceStream(prefix + part.GetProperty("name").GetString())
                            ?? throw new FileNotFoundException("自然语音模型不完整。");
                        input.CopyTo(output);
                    }
                if (!Matches(temporary, root.GetProperty("archiveSha256").GetString()!)) throw new InvalidDataException("自然语音模型校验失败。");
                using var archive = ZipFile.OpenRead(temporary);
                foreach (var file in files)
                {
                    var name = file.GetProperty("name").GetString()!;
                    var target = Target(name);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    var entry = archive.GetEntry(name) ?? throw new InvalidDataException("自然语音模型缺少文件。");
                    var stage = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try
                    {
                        entry.ExtractToFile(stage);
                        if (!Matches(stage, file.GetProperty("sha256").GetString()!)) throw new InvalidDataException("自然语音模型文件校验失败。");
                        File.Move(stage, target, true);
                    }
                    finally { if (File.Exists(stage)) File.Delete(stage); }
                }
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return _extracted = folder;
        }
    }
}

/// <summary>Offline Chinese neural voice, sharing the already bundled ONNX runtime.</summary>
internal sealed class BanbanNeuralSynthesizer : IDisposable
{
    internal const float DefaultSpeed = 1.03f;
    private static readonly object SharedGate = new();
    private static BanbanNeuralSynthesizer? _shared;
    private static int _sharedUsers;
    private readonly object _gate = new();
    private readonly OfflineTts _model;
    private readonly int _speaker;
    private float[]? _welcome;
    internal int SampleRate => _model.SampleRate;
    internal static BanbanNeuralSynthesizer AcquireShared()
    {
        lock (SharedGate)
        {
            _shared ??= new BanbanNeuralSynthesizer();
            _sharedUsers++;
            return _shared;
        }
    }
    internal static void ReleaseShared(BanbanNeuralSynthesizer voice)
    {
        lock (SharedGate)
        {
            if (!ReferenceEquals(_shared, voice) || --_sharedUsers != 0) return;
            _shared = null;
            voice.Dispose();
        }
    }
    internal BanbanNeuralSynthesizer(string? folder = null, int? threads = null, bool debug = false)
    {
        folder ??= BanbanNeuralVoicePack.Extract();
        var config = new OfflineTtsConfig();
        _speaker = 0;
        config.Model.Vits.Model = Path.Combine(folder, "model.onnx");
        config.Model.Vits.Tokens = Path.Combine(folder, "tokens.txt");
        config.Model.Vits.Lexicon = Path.Combine(folder, "lexicon.txt");
        config.Model.NumThreads = threads ?? Math.Clamp(Environment.ProcessorCount / 2, 1, 2);
        config.Model.Provider = "cpu";
        config.Model.Debug = debug ? 1 : 0;
        config.MaxNumSentences = 3;
        config.SilenceScale = 1;
        config.RuleFsts = string.Join(",", new[] { "date-zh.fst", "number-zh.fst", "phone-zh.fst", "date.fst", "number.fst", "phone.fst", "new_heteronym.fst" }.Select(n => Path.Combine(folder, n)).Where(File.Exists));
        _model = new OfflineTts(config);
        if (_model.SampleRate < 16000 || _model.NumSpeakers <= _speaker) { _model.Dispose(); throw new InvalidDataException("班班自然语音模型无法加载。"); }
    }
    internal float[] Generate(string text, Func<bool>? valid = null, float speed = DefaultSpeed)
    {
        if (!float.IsFinite(speed) || speed <= 0) throw new ArgumentOutOfRangeException(nameof(speed));
        // Notifications, timetable reminders and conversations share one model.
        // Serialize inference; waiting callers check cancellation before generating.
        lock (_gate) return GenerateCore(text, valid, speed);
    }
    private float[] GenerateCore(string text, Func<bool>? valid, float speed)
    {
        if (valid?.Invoke() == false) return [];
        if (text == "我在，请说。" && speed == DefaultSpeed && _welcome is not null) return _welcome;
        // The wrapper's convenience method defaults to aggressive silence
        // shortening, which also clips quiet Chinese consonants and short words.
        var generation = new OfflineTtsGenerationConfig { Speed = speed, Sid = _speaker, SilenceScale = 1 };
        var audio = _model.GenerateWithConfig(text, generation, (_, _, _, _) => valid?.Invoke() == false ? 0 : 1);
        try
        {
            if (valid?.Invoke() == false) return [];
            var samples = audio.Samples;
            var peak = 0f; double energy = 0;
            foreach (var sample in samples)
            {
                if (!float.IsFinite(sample)) throw new InvalidDataException("自然语音包含无效采样。");
                peak = Math.Max(peak, Math.Abs(sample)); energy += sample * sample;
            }
            if (samples.Length == 0 || peak < .0001f) throw new InvalidDataException("自然语音没有生成有效声音。");
            // Keep quiet fricatives and short replies audible without changing
            // the Windows volume or clipping louder parts of a sentence.
            var gain = (float)Math.Min(15, Math.Min(.92 / peak, .09 / Math.Sqrt(energy / samples.Length)));
            for (var i = 0; i < samples.Length; i++) samples[i] *= gain;
            if (text == "我在，请说。" && speed == DefaultSpeed) _welcome = samples;
            return samples;
        }
        finally { audio.Dispose(); }
    }
    public void Dispose() { lock (_gate) _model.Dispose(); }
}

/// <summary>Bounded text/audio queues; stopping invalidates synthesis and playback together.</summary>
internal sealed class BanbanSpeechPlayer : IDisposable
{
    private sealed record TextPart(long Generation, string Text, bool End, float Speed, float Volume, NotificationCue Cue);
    private sealed record AudioPart(long Generation, float[] Samples, int Rate, string Text, bool End, float Volume, NotificationCue Cue);
    private readonly BlockingCollection<TextPart> _text = new(48);
    private readonly BlockingCollection<AudioPart> _audio = new(3);
    private readonly object _gate = new();
    private readonly Thread _synthesis, _playback;
    private readonly Action<long> _completed;
    private readonly Action<long, string> _playing;
    private readonly Action<Exception> _failed;
    private WasapiOut? _output;
    private long _generation;
    private long _mouthGeneration;
    private double _mouthOpening;
    private int _disposed;
    internal long Generation => Volatile.Read(ref _generation);
    private int _ready;
    internal bool Ready => Volatile.Read(ref _ready) != 0;
    internal double MouthOpening => Volatile.Read(ref _mouthGeneration) == Generation ? Volatile.Read(ref _mouthOpening) : 0;

    internal BanbanSpeechPlayer(Action<long> completed, Action<long, string> playing, Action<Exception> failed)
    {
        _completed = completed; _playing = playing; _failed = failed;
        _synthesis = new Thread(Synthesize) { IsBackground = true, Name = "ICeClass.BanbanNeuralSpeech" };
        _playback = new Thread(Play) { IsBackground = true, Name = "ICeClass.BanbanVoicePlayback" };
        _synthesis.Start(); _playback.Start();
    }
    internal void Enqueue(string text, bool end, float speed = BanbanNeuralSynthesizer.DefaultSpeed, float volume = 1,
        NotificationCue cue = NotificationCue.None)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        try
        {
            if (!_text.TryAdd(new(Generation, text, end, speed, Math.Clamp(volume, 0, 1), cue))) { Stop(); _failed(new IOException("语音播报队列已满，文字结果已保留。")); }
        }
        catch (InvalidOperationException) { }
    }
    internal void Stop()
    {
        Interlocked.Increment(ref _generation);
        Volatile.Write(ref _mouthOpening, 0);
        while (_text.TryTake(out _)) { }
        while (_audio.TryTake(out _)) { }
        lock (_gate)
        {
            try { _output?.Stop(); }
            catch (System.Runtime.InteropServices.COMException) { }
        }
    }
    private bool Valid(long generation) => Volatile.Read(ref _disposed) == 0 && generation == Generation;
    private void Synthesize()
    {
        BanbanNeuralSynthesizer? synth = null;
        try
        {
            synth = BanbanNeuralSynthesizer.AcquireShared();
            synth.Generate("我在，请说。", () => Volatile.Read(ref _disposed) == 0);
            Volatile.Write(ref _ready, 1);
            foreach (var item in _text.GetConsumingEnumerable())
            {
                if (!Valid(item.Generation)) continue;
                var samples = string.IsNullOrWhiteSpace(item.Text) ? [] : synth.Generate(item.Text, () => Valid(item.Generation), item.Speed);
                var output = new AudioPart(item.Generation, samples, synth.SampleRate, item.Text, item.End, item.Volume, item.Cue);
                while (Valid(item.Generation) && !_audio.TryAdd(output, 50)) { }
            }
        }
        catch (Exception error) { if (Volatile.Read(ref _disposed) == 0) _failed(error); }
        finally
        {
            Volatile.Write(ref _ready, 0);
            if (synth is not null) BanbanNeuralSynthesizer.ReleaseShared(synth);
            _audio.CompleteAdding();
        }
    }
    private void Play()
    {
        try
        {
            foreach (var item in _audio.GetConsumingEnumerable())
            {
                if (!Valid(item.Generation)) continue;
                if (item.Samples.Length > 0)
                {
                    var bytes = new byte[item.Samples.Length * sizeof(float)];
                    Buffer.BlockCopy(item.Samples, 0, bytes, 0, bytes.Length);
                    using var memory = new MemoryStream(bytes, false);
                    using var source = new RawSourceWaveStream(memory, WaveFormat.CreateIeeeFloatWaveFormat(item.Rate, 1));
                    var prepared = NotificationChime.Prepend(source.ToSampleProvider(), item.Cue);
                    var volume = new VolumeSampleProvider(prepared) { Volume = item.Volume };
                    var envelope = new BanbanSpeechEnvelope(item.Samples, item.Rate, item.Volume);
                    var speechOffset = prepared is NotificationChime chime ? chime.SpeechOffsetSeconds : 0;
                    using var devices = new MMDeviceEnumerator();
                    using var device = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
                    using var output = new WasapiOut(device, AudioClientShareMode.Shared, false, 40);
                    using var ended = new ManualResetEventSlim();
                    Exception? playbackError = null;
                    output.PlaybackStopped += (_, e) => { playbackError = e.Exception; ended.Set(); };
                    output.Init(volume);
                    try
                    {
                        lock (_gate)
                        {
                            if (!Valid(item.Generation)) continue;
                            _output = output; Volatile.Write(ref _mouthGeneration, item.Generation);
                            _playing(item.Generation, item.Text); output.Play();
                        }
                        while (!ended.Wait(20) && Valid(item.Generation))
                        {
                            // Reader position includes buffered audio that has not sounded
                            // yet. WASAPI reports played bytes in its negotiated format,
                            // which may differ from the mono synthesis sample rate.
                            var seconds = (double)output.GetPosition() / output.OutputWaveFormat.AverageBytesPerSecond;
                            Volatile.Write(ref _mouthOpening, output.PlaybackState == PlaybackState.Playing
                                ? envelope.OpeningAt(seconds - speechOffset) : 0);
                        }
                        if (playbackError is not null && Valid(item.Generation)) throw new IOException("音频输出中断。", playbackError);
                    }
                    finally
                    {
                        lock (_gate)
                        {
                            Volatile.Write(ref _mouthOpening, 0);
                            if (ReferenceEquals(_output, output)) _output = null;
                            output.Stop();
                        }
                    }
                }
                if (item.End && Valid(item.Generation)) _completed(item.Generation);
            }
        }
        catch (Exception error) { if (Volatile.Read(ref _disposed) == 0) _failed(error); }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        Stop(); _text.CompleteAdding();
        _synthesis.Join(TimeSpan.FromSeconds(3)); _playback.Join(TimeSpan.FromSeconds(3));
        if (!_synthesis.IsAlive && !_playback.IsAlive) { _text.Dispose(); _audio.Dispose(); }
    }
}

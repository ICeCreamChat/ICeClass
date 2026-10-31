using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using SherpaOnnx;

namespace ICeClass.Receiver;

/// <summary>Local keyword spotting. Models are shipped with the application; audio stays in memory.</summary>
internal sealed class BanbanWakeDetector : IDisposable
{
    private readonly KeywordSpotter _spotter;
    private OnlineStream _stream;
    internal const string Keywords = "n ǐ h ǎo b ān b ān :1.5 #0.25 @你好班班\nb ān b ān n ǐ h ǎo :1.5 #0.25 @班班你好\nb ān b ān t íng y ī x ià :2 #0.15 @班班停一下\nb ān b ān t íng y í x ià :2 #0.15 @班班停一下\nb ān b ān t íng zh ǐ b ō b ào :2 #0.15 @班班停止播报\nb ān b ān q ǔ x iāo c āo z uò :1.5 #0.25 @班班取消操作\nz ài j iàn b ān b ān :1.5 #0.25 @再见班班\n";

    internal BanbanWakeDetector()
    {
        var folder = BanbanVoiceModels.Extract("ICeClass.Voice.", "wenetspeech-kws-20240101");
        BanbanVoiceModels.WriteText(Path.Combine(folder, "banban-keywords.txt"), Keywords);
        var config = new KeywordSpotterConfig();
        config.FeatConfig.SampleRate = 16000;
        config.FeatConfig.FeatureDim = 80;
        config.ModelConfig.Transducer.Encoder = Path.Combine(folder, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        config.ModelConfig.Transducer.Decoder = Path.Combine(folder, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        config.ModelConfig.Transducer.Joiner = Path.Combine(folder, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        config.ModelConfig.Tokens = Path.Combine(folder, "tokens.txt");
        config.ModelConfig.Provider = "cpu";
        config.ModelConfig.NumThreads = 1;
        config.KeywordsFile = Path.Combine(folder, "banban-keywords.txt");
        config.KeywordsScore = 1.5f;
        config.KeywordsThreshold = .25f;
        _spotter = new KeywordSpotter(config);
        try { _stream = _spotter.CreateStream(); }
        catch { _spotter.Dispose(); throw; }
    }

    internal string? Accept(float[] samples)
    {
        _stream.AcceptWaveform(16000, samples);
        string? detected = null;
        while (_spotter.IsReady(_stream))
        {
            _spotter.Decode(_stream);
            var result = _spotter.GetResult(_stream);
            if (string.IsNullOrEmpty(result.Keyword)) continue;
            detected ??= result.Keyword;
            _spotter.Reset(_stream);
        }
        return detected;
    }

    internal void Reset() { var fresh = _spotter.CreateStream(); _stream.Dispose(); _stream = fresh; }
    public void Dispose() { _stream.Dispose(); _spotter.Dispose(); }
}

internal static class BanbanVoiceModels
{
    internal static string Extract(string resourcePrefix, string version)
    {
        var assembly = typeof(BanbanWakeDetector).Assembly;
        using var manifest = assembly.GetManifestResourceStream(resourcePrefix + "manifest.json")
            ?? throw new FileNotFoundException("缺少班班语音模型清单。");
        using var document = JsonDocument.Parse(manifest);
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Voice", version);
        Directory.CreateDirectory(folder);
        foreach (var item in document.RootElement.GetProperty("files").EnumerateArray())
        {
            var name = item.GetProperty("name").GetString()!;
            if (string.IsNullOrEmpty(name) || Path.GetFileName(name) != name) throw new InvalidDataException("语音模型文件名无效。");
            var path = Path.Combine(folder, name);
            var expected = item.GetProperty("sha256").GetString()!;
            if (File.Exists(path))
            {
                using var existing = File.OpenRead(path);
                if (Convert.ToHexString(SHA256.HashData(existing)).Equals(expected, StringComparison.OrdinalIgnoreCase)) continue;
            }
            using var source = assembly.GetManifestResourceStream(resourcePrefix + name)
                ?? throw new FileNotFoundException("缺少班班语音模型：" + name);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var destination = File.Create(temporary)) source.CopyTo(destination);
                using (var written = File.OpenRead(temporary))
                    if (!Convert.ToHexString(SHA256.HashData(written)).Equals(expected, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("班班语音模型校验失败：" + name);
                File.Move(temporary, path, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        return folder;
    }

    internal static void WriteText(string path, string text)
    {
        if (!File.Exists(path) || File.ReadAllText(path) != text)
        {
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { File.WriteAllText(temporary, text, new UTF8Encoding(false)); File.Move(temporary, path, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    internal static void RetireSpeechModels()
    {
        var root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Voice"));
        foreach (var version in new[] { "zipformer-bilingual-zh-en-c402e0f4", "zipformer-small-bilingual-zh-en-20230216",
            "zipformer-small-ctc-zh-20250401", "kokoro-zh-v1_1-int8-20261025" })
        {
            var path = Path.GetFullPath(Path.Combine(root, version));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
            try { if (Directory.Exists(path) && !HasLink(path)) Directory.Delete(path, recursive: true); }
            catch (IOException) { } // Another still-running version may hold a model file open.
            catch (UnauthorizedAccessException) { }
        }
        static bool HasLink(string directory)
        {
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return true;
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) return true;
                if ((attributes & FileAttributes.Directory) != 0 && HasLink(entry)) return true;
            }
            return false;
        }
    }
}

internal sealed record BanbanSpeechResult(string Text, bool Final, bool Unrecognized = false, bool DuringPlayback = false, bool OtherSpeaker = false);
// Opt-in, text/level-only diagnostics. Never contains microphone samples.
internal sealed record BanbanAudioObservation(string Kind, bool ControlsOnly, int Generation,
    string Text = "", bool Final = false, float Peak = 0, float Clipped = 0, int Frames = 0, double DelayMs = 0);

internal sealed class BanbanVoiceActivity : IDisposable
{
    private readonly VoiceActivityDetector _vad;
    internal BanbanVoiceActivity()
    {
        var folder = BanbanVoiceModels.Extract("ICeClass.Voice.Vad.", "silero-vad-v5-20261025");
        var config = new VadModelConfig();
        config.SileroVad.Model = Path.Combine(folder, "silero_vad_v5.onnx");
        config.SileroVad.Threshold = .5f;
        config.SileroVad.MinSpeechDuration = .18f;
        config.SileroVad.MinSilenceDuration = .3f;
        config.SileroVad.MaxSpeechDuration = 35;
        _vad = new VoiceActivityDetector(config, 36);
    }
    internal bool Accept(float[] samples)
    {
        _vad.AcceptWaveform(samples);
        while (!_vad.IsEmpty()) _vad.Pop();
        return _vad.IsSpeechDetected();
    }
    internal void Reset() => _vad.Reset();
    public void Dispose() => _vad.Dispose();
}

/// <summary>One microphone feeds keyword spotting and bounded, asynchronous utterance recognition.</summary>
internal sealed class BanbanLocalAudio : IDisposable
{
    private sealed record ListeningWindow(bool Enabled, bool ControlsOnly, DateTime NotBefore, int Generation, int ContinueFrom = -1);
    private sealed record AudioFrame(float[] Samples, ListeningWindow Window, DateTime CapturedAt, bool EchoCancelled);
    private readonly WaveInEvent _capture;
    private readonly BanbanEchoMicrophone _echo;
    private readonly BanbanWakeDetector _detector;
    private readonly BanbanSpeechDecoder _decoder;
    private readonly BanbanSpeechSegmenter _segmenter;
    private readonly BanbanSpeakerFocus _speakerFocus;
    private readonly BlockingCollection<AudioFrame> _frames = new(30);
    private readonly Thread _worker;
    private readonly Action<string> _keyword;
    private readonly Action<BanbanSpeechResult, int> _result;
    private readonly Action<int> _level;
    private readonly Action<Exception> _failed;
    private readonly Action<BanbanAudioObservation>? _observe;
    private readonly Action<int, BanbanSpeechResult>? _bargeIn;
    private readonly object _listeningLock = new();
    private ListeningWindow _listening = new(false, false, DateTime.MinValue, 0);
    private bool _focusNextUtterance;
    private long _lastLevel;
    private int _stopped, _faulted;
    private bool _started, _disposed;
    private string _playbackText = "";
    private readonly string _captureId, _renderId;
    internal string Microphone { get; }
    internal bool EchoCancellation => _echo.Ready;
    internal bool NaturalInterruption => _echo.Ready;

    internal BanbanLocalAudio(Action<string> keyword, Action<BanbanSpeechResult, int> result, Action<int> level, Action<Exception> failed,
        Action<BanbanAudioObservation>? observe = null, Action<int, BanbanSpeechResult>? bargeIn = null)
    {
        _keyword = keyword; _result = result; _level = level; _failed = failed; _observe = observe; _bargeIn = bargeIn;
        using var devices = new MMDeviceEnumerator();
        using var device = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
        using var render = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
        _captureId = device.ID; _renderId = render.ID;
        Microphone = device.FriendlyName;
        var index = Enumerable.Range(0, WaveIn.DeviceCount).FirstOrDefault(i =>
            Microphone.StartsWith(WaveIn.GetCapabilities(i).ProductName, StringComparison.OrdinalIgnoreCase), -1);
        if (index < 0) throw new InvalidOperationException("当前默认麦克风无法打开，请在 Windows 声音设置中选择可用输入。");
        _detector = new BanbanWakeDetector();
        try { _segmenter = new BanbanSpeechSegmenter(); }
        catch { _detector.Dispose(); throw; }
        BanbanSpeechRecognizer recognizer;
        try { recognizer = new BanbanSpeechRecognizer(); }
        catch { _segmenter.Dispose(); _detector.Dispose(); throw; }
        try { _speakerFocus = new BanbanSpeakerFocus(); }
        catch { recognizer.Dispose(); _segmenter.Dispose(); _detector.Dispose(); throw; }
        _decoder = new BanbanSpeechDecoder(samples => _speakerFocus.Matches(samples)
            ? recognizer.Recognize(samples) : new("", true, OtherSpeaker: true), IsCurrent, Recognized, Fail,
            () => { recognizer.Dispose(); _speakerFocus.Dispose(); });
        _capture = new WaveInEvent { DeviceNumber = index, WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50 };
        _capture.DataAvailable += Capture;
        _capture.RecordingStopped += (_, e) =>
        {
            // Some drivers end capture without an exception after an audio
            // interruption. Our own Stop marks _stopped before stopping capture.
            // Treat any other stop as a lost input so the voice service retries.
            Fail(e.Exception ?? new IOException("麦克风录音意外停止，正在重新连接。"));
        };
        _echo = new BanbanEchoMicrophone((pcm, count) => {
            var window = Volatile.Read(ref _listening);
            Capture(pcm, count, window, echoCancelled: true);
        }, error => _observe?.Invoke(new("echo-unavailable", false, 0, error.Message)));
        _worker = new Thread(Decode) { IsBackground = true, Name = "ICeClass.BanbanAudio" };
    }

    internal void SetPlaybackText(string text) => Volatile.Write(ref _playbackText, BanbanVoiceService.Normalize(text));
    internal bool AudioDevicesChanged()
    {
        try
        {
            using var devices = new MMDeviceEnumerator();
            using var microphone = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
            using var speaker = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
            var changed = microphone.ID != _captureId || speaker.ID != _renderId;
            if (changed) _observe?.Invoke(new("audio-devices-changed", false, 0,
                $"microphoneChanged={microphone.ID != _captureId}; speakerChanged={speaker.ID != _renderId}; input={microphone.FriendlyName}; output={speaker.FriendlyName}"));
            return changed;
        }
        catch (System.Runtime.InteropServices.COMException error)
        {
            _observe?.Invoke(new("audio-devices-unavailable", false, 0, error.Message));
            return true;
        }
    }
    internal void SetConversation(bool enabled, DateTime notBefore, bool controlsOnly = false, bool preserveUtterance = false)
    {
        lock (_listeningLock)
        {
            var current = _listening;
            if (current.Enabled == enabled && (!enabled || current.NotBefore == notBefore && current.ControlsOnly == controlsOnly)) return;
            if (current.Enabled && !enabled) { _speakerFocus.Clear(); _focusNextUtterance = false; }
            Volatile.Write(ref _listening, new(enabled, controlsOnly, notBefore, current.Generation + 1,
                preserveUtterance && current.ControlsOnly && enabled && !controlsOnly ? current.Generation : -1));
        }
    }
    internal bool IsCurrent(int generation) => Volatile.Read(ref _listening) is { Enabled: true } window
        && (window.Generation == generation || window.ContinueFrom == generation);
    internal void FocusNextUtterance()
    {
        lock (_listeningLock)
        {
            // A click has no spoken wake to identify its speaker. Establish the
            // conversation from its first complete utterance instead.
            _speakerFocus.Clear(); _focusNextUtterance = true;
        }
    }
    internal void DiscardUtterance()
    {
        lock (_listeningLock)
        {
            var current = _listening;
            Volatile.Write(ref _listening, current with { Generation = current.Generation + 1, ContinueFrom = -1 });
        }
    }

    internal void Start()
    {
        try
        {
            _decoder.Start();
            _worker.Start(); _started = true;
            _capture.StartRecording(); _echo.Start();
        }
        catch { Stop(); throw; }
    }

    private void Capture(object? sender, WaveInEventArgs e)
    {
        var window = Volatile.Read(ref _listening);
        if (_echo.Ready) return;
        Capture(e.Buffer, e.BytesRecorded, window, echoCancelled: false);
    }
    private void Capture(byte[] pcm, int count, ListeningWindow window, bool echoCancelled)
    {
        if (Volatile.Read(ref _stopped) != 0) return;
        var samples = new float[count / 2];
        var peak = 0f;
        for (var i = 0; i < samples.Length; i++)
        {
            var raw = BitConverter.ToInt16(pcm, i * 2) / 32768f;
            peak = Math.Max(peak, Math.Abs(raw));
            samples[i] = raw;
        }
        try
        {
            if (!_frames.TryAdd(new(samples, window, DateTime.UtcNow, echoCancelled))) { Fail(new IOException("语音处理跟不上麦克风输入，请重新开启语音。")); return; }
        }
        catch (InvalidOperationException) { return; }
        var now = Environment.TickCount64;
        if (now - _lastLevel < 150) return;
        _lastLevel = now; _level((int)Math.Min(100, peak * 300));
    }
    private void Decode()
    {
        try
        {
            ListeningWindow? decoding = null;
            bool? echoSource = null;
            var wakeFrames = new Queue<float[]>(); var wakeSamples = 0;
            var diagnosticAt = Environment.TickCount64;
            var diagnosticFrames = 0; var diagnosticPeak = 0f; var diagnosticClipped = 0; var diagnosticSamples = 0;
            foreach (var frame in _frames.GetConsumingEnumerable())
            {
                if (Volatile.Read(ref _stopped) != 0) break;
                var window = Volatile.Read(ref _listening);
                if (!ReferenceEquals(frame.Window, window) && frame.Window.Generation != window.ContinueFrom) continue;
                var sourceChanged = echoSource != frame.EchoCancelled;
                if (!ReferenceEquals(decoding, window) || sourceChanged)
                {
                    if (sourceChanged || decoding is null || window.ContinueFrom != decoding.Generation)
                    { _segmenter.Reset(); _detector.Reset(); wakeFrames.Clear(); wakeSamples = 0; }
                    if (sourceChanged) _observe?.Invoke(new("capture-source", window.ControlsOnly, window.Generation,
                        frame.EchoCancelled ? "echo-cancelled" : "microphone"));
                    echoSource = frame.EchoCancelled;
                    decoding = window;
                    _observe?.Invoke(new(window.Enabled ? "listening" : "standby", window.ControlsOnly, window.Generation));
                }
                wakeFrames.Enqueue(frame.Samples); wakeSamples += frame.Samples.Length;
                while (wakeSamples > 32000 && wakeFrames.Count > 1) wakeSamples -= wakeFrames.Dequeue().Length;
                var keyword = _detector.Accept(frame.Samples);
                if (keyword is not null)
                {
                    var samples = wakeFrames.SelectMany(samples => samples).ToArray();
                    var wake = BanbanVoiceService.WakeRemainder(keyword) is not null;
                    if (wake ? _speakerFocus.Focus(samples) : _speakerFocus.Matches(samples))
                    {
                        if (wake) { lock (_listeningLock) _focusNextUtterance = false; }
                        _observe?.Invoke(new("keyword", frame.Window.ControlsOnly, frame.Window.Generation, keyword)); _keyword(keyword);
                    }
                    else _observe?.Invoke(new("speaker-rejected", frame.Window.ControlsOnly, frame.Window.Generation));
                }
                if (!window.Enabled || frame.CapturedAt < window.NotBefore) continue;
                if (_observe is not null)
                {
                    diagnosticFrames++; diagnosticSamples += frame.Samples.Length;
                    foreach (var sample in frame.Samples) { diagnosticPeak = Math.Max(diagnosticPeak, Math.Abs(sample)); if (Math.Abs(sample) >= .999f) diagnosticClipped++; }
                    if (Environment.TickCount64 - diagnosticAt >= 1000)
                    {
                        _observe(new("frames", window.ControlsOnly, window.Generation, Peak: diagnosticPeak,
                            Clipped: (float)diagnosticClipped / Math.Max(1, diagnosticSamples), Frames: diagnosticFrames,
                            DelayMs: (DateTime.UtcNow - frame.CapturedAt).TotalMilliseconds));
                        diagnosticAt = Environment.TickCount64; diagnosticFrames = diagnosticClipped = diagnosticSamples = 0; diagnosticPeak = 0;
                    }
                }
                var audio = _segmenter.Accept(frame.Samples, preview: window.ControlsOnly && NaturalInterruption,
                    duringPlayback: frame.Window.ControlsOnly);
                if (audio is not null)
                {
                    if (audio.TooLong)
                    {
                        _observe?.Invoke(new("utterance-too-long", window.ControlsOnly, window.Generation));
                        if (!window.ControlsOnly)
                        {
                            if (_speakerFocus.Matches(wakeFrames.SelectMany(samples => samples).ToArray()))
                                _result(new("", true, Unrecognized: true), window.Generation);
                            else _observe?.Invoke(new("speaker-rejected", false, window.Generation, Final: true));
                        }
                    }
                    else
                    {
                        if (audio.Final && !audio.DuringPlayback && !window.ControlsOnly)
                        {
                            lock (_listeningLock)
                            {
                                if (_focusNextUtterance && ReferenceEquals(window, _listening)
                                    && _speakerFocus.Focus(audio.Samples))
                                    _focusNextUtterance = false;
                            }
                        }
                        if (!_decoder.Enqueue(audio, window.Generation, window.ControlsOnly))
                            Fail(new IOException("本机语音识别暂时繁忙，请稍后重新说一遍。"));
                    }
                }
            }
        }
        catch (Exception error) { Fail(error); }
        finally { _segmenter.Dispose(); _detector.Dispose(); }
    }

    private void Recognized(BanbanSpeechJob job, BanbanSpeechResult result, double delayMs)
    {
        if (Volatile.Read(ref _stopped) != 0 || !IsCurrent(job.Generation)) return;
        if (result.OtherSpeaker)
        {
            _observe?.Invoke(new("speaker-rejected", job.ControlsOnly, job.Generation, Final: result.Final, DelayMs: delayMs));
            return;
        }
        _observe?.Invoke(new("recognition", job.ControlsOnly, job.Generation,
            result.Text, result.Final, DelayMs: delayMs));
        // Inference can finish after playback. Keep the capture provenance so
        // delayed echo or consent cannot cross into the newly listening turn.
        if (result.DuringPlayback)
        {
            var control = BanbanVoiceService.SpeechControl(result.Text);
            // A preview may be only the opening of “退下吧是什么意思”.
            // Pausing playback may happen early; leaving waits for the full utterance.
            if (control is not null && (result.Final || BanbanVoiceService.Intent(control) != "leave"))
            {
                _observe?.Invoke(new("control", true, job.Generation, control));
                _result(new(control, true, DuringPlayback: true), job.Generation);
            }
            else if (NaturalInterruption && CanBargeIn(result.Text, Volatile.Read(ref _playbackText)))
            {
                _observe?.Invoke(new("barge-in", true, job.Generation, result.Text));
                _bargeIn?.Invoke(job.Generation, result);
            }
        }
        else if (result.Final) _result(result, job.Generation);
    }
    internal static bool CanBargeIn(string text, string playback)
    {
        if (BanbanVoiceService.HasUnrecognizedSpeech(text)) return false;
        var value = BanbanVoiceService.Normalize(text);
        return value.Length >= 3 && value is not ("确认执行" or "确认这项操作")
            && !playback.Contains(value, StringComparison.Ordinal);
    }
    private void Fail(Exception error) { if (Volatile.Read(ref _stopped) == 0 && Interlocked.Exchange(ref _faulted, 1) == 0) _failed(error); }
    internal void Stop()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        _echo.Dispose(); _capture.StopRecording(); _capture.Dispose();
        _frames.CompleteAdding();
        if (_started) _worker.Join(TimeSpan.FromSeconds(3));
        else { _segmenter.Dispose(); _detector.Dispose(); }
        _decoder.Dispose();
    }
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true; Stop();
        if (!_worker.IsAlive) _frames.Dispose();
    }
}

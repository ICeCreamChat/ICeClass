using System.Collections.Concurrent;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace ICeClass.Receiver;

/// <summary>VAD only on a bounded worker; no audio files or cloud streaming.</summary>
internal sealed class SelfStudyAudio : IDisposable
{
    private readonly WaveInEvent _capture;
    private readonly BlockingCollection<(float[] Samples, long EndedAt)> _frames = new(20);
    private readonly Thread _worker;
    private readonly Action<BanbanSpeechAudio> _segment;
    private readonly Action _speech;
    private readonly Action _failed;
    private readonly Action _discontinuity;
    private readonly Action<SelfStudySound>? _sound;
    private readonly Func<bool> _analyze;
    private readonly string _sensitivity;
    private int _disposed, _overflow;
    private long _captureOrigin, _capturedSamples;
    internal SelfStudyAudio(Action<BanbanSpeechAudio> segment, Action speech, Action failed, Action discontinuity,
        Action<SelfStudySound>? sound = null, Func<bool>? analyze = null, string sensitivity = "balanced")
    {
        _segment = segment; _speech = speech; _failed = failed; _discontinuity = discontinuity;
        _sound = sound; _analyze = analyze ?? (() => true); _sensitivity = sensitivity;
        using var devices = new MMDeviceEnumerator();
        using var microphone = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
        var deviceNumber = -1;
        for (var i = 0; i < WaveIn.DeviceCount; i++)
            if (microphone.FriendlyName.StartsWith(WaveIn.GetCapabilities(i).ProductName, StringComparison.OrdinalIgnoreCase))
            { deviceNumber = i; break; }
        _capture = new WaveInEvent { DeviceNumber = deviceNumber, WaveFormat = new WaveFormat(16000, 16, 1),
            BufferMilliseconds = 50, NumberOfBuffers = 3 };
        _capture.DataAvailable += (_, e) =>
        {
            if (Volatile.Read(ref _disposed) != 0) return;
            var samples = new float[e.BytesRecorded / 2];
            for (var i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToInt16(e.Buffer, i * 2) / 32768f;
            if (_captureOrigin == 0) _captureOrigin = Environment.TickCount64 - samples.Length / 16;
            _capturedSamples += samples.Length;
            try { if (!_frames.TryAdd((samples, _captureOrigin + _capturedSamples / 16))) Interlocked.Exchange(ref _overflow, 1); }
            catch (InvalidOperationException) { }
        };
        _capture.RecordingStopped += (_, e) => { if (e.Exception is not null && Volatile.Read(ref _disposed) == 0) _failed(); };
        _worker = new Thread(Run) { IsBackground = true, Name = "ICeClass.SelfStudyVAD" };
    }
    internal void Start()
    {
        _worker.Start();
        try { _capture.StartRecording(); }
        catch { Dispose(); throw; }
    }
    private void Run()
    {
        BanbanVoiceActivity? activity = null;
        BanbanSpeechSegmenter? segmenter = null;
        try
        {
            var gate = new SelfStudyNoiseGate(_sensitivity);
            long lastLevel = 0;
            var analyzing = false;
            var speechSinceLevel = false;
            foreach (var frame in _frames.GetConsumingEnumerable())
            {
                if (Volatile.Read(ref _disposed) != 0) break;
                // Missing frames invalidate a segment; never concatenate across an overload.
                if (Interlocked.Exchange(ref _overflow, 0) != 0)
                {
                    while (_frames.TryTake(out _)) { }
                    segmenter?.Reset(); activity?.Reset(); gate.Reset(); speechSinceLevel = false;
                    _discontinuity(); _sound?.Invoke(new(0, false)); continue;
                }
                var enabled = _analyze();
                if (enabled != analyzing)
                {
                    segmenter?.Reset(); activity?.Reset(); gate.Reset(); speechSinceLevel = false; analyzing = enabled;
                }
                var speech = false;
                if (enabled)
                {
                    activity ??= new BanbanVoiceActivity();
                    segmenter ??= new BanbanSpeechSegmenter(8 * 16000, continuous: true,
                        detectSpeech: samples => gate.Accept(samples, activity.Accept(samples)));
                    var segment = segmenter.Accept(frame.Samples);
                    speech = segmenter.SpeechDetected;
                    speechSinceLevel |= speech;
                    if (speech) _speech();
                    if (segment is { Final: true }) _segment(segment with { EndedAtTicks = frame.EndedAt });
                }
                if (frame.EndedAt - lastLevel >= 100)
                {
                    lastLevel = frame.EndedAt;
                    // The meter publishes half as often as audio arrives. Keep
                    // speech from either frame instead of sampling only the last.
                    _sound?.Invoke(new(SelfStudySoundMeter.Measure(frame.Samples), speechSinceLevel));
                    speechSinceLevel = false;
                }
            }
        }
        catch { if (Volatile.Read(ref _disposed) == 0) _failed(); }
        finally { segmenter?.Dispose(); activity?.Dispose(); _frames.Dispose(); }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _capture.StopRecording(); _capture.Dispose();
        try { _frames.CompleteAdding(); } catch (ObjectDisposedException) { }
        // Never block the dispatcher while the native VAD is finishing.
    }
}

/// <summary>Relative energy filter, calibrated only on VAD-negative background. No speaker inference.</summary>
internal sealed class SelfStudyNoiseGate
{
    private readonly double _enter, _exit;
    private double _background;
    private bool _initialized, _active;
    internal SelfStudyNoiseGate(string sensitivity = "balanced") => (_enter, _exit) = sensitivity switch
    {
        "low" => (1.9, 1.5), "high" => (1.25, 1.1), _ => (1.5, 1.2)
    };
    internal bool Accept(float[] samples, bool speech)
    {
        if (samples.Length == 0) return false;
        var rms = Math.Sqrt(samples.Sum(s => (double)s * s) / samples.Length);
        if (!double.IsFinite(rms)) return false;
        if (!speech)
        {
            var weight = 1 - Math.Exp(-samples.Length / 16000d / 2);
            _background = _initialized ? _background + weight * (rms - _background) : rms;
            _initialized = true; _active = false; return false;
        }
        _active = rms > Math.Max(.001, _background * (_active ? _exit : _enter));
        return _active;
    }
    internal void Reset() { _background = 0; _initialized = _active = false; }
}

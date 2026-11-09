using System.Collections.Concurrent;
using System.Runtime.CompilerServices;

namespace ICeClass.Receiver;

/// <summary>One complete utterance per decode. The microphone and keyword thread never waits for inference.</summary>
internal sealed class BanbanSpeechRecognizer : IDisposable
{
    internal const string EngineName = "sherpa-onnx SenseVoiceSmall INT8 (local utterance recognition)";
    private readonly SenseVoiceRecognizer _recognizer;

    internal BanbanSpeechRecognizer(string? modelFolder = null, string language = "auto", bool useInverseTextNormalization = true)
    {
        var folder = modelFolder ?? BanbanVoiceModels.Extract("ICeClass.Voice.Asr.", "sensevoice-small-int8-2365baea");
        _recognizer = new SenseVoiceRecognizer(folder, language, useInverseTextNormalization);
        if (modelFolder is null) BanbanVoiceModels.RetireSpeechModels();
    }

    internal BanbanSpeechResult Recognize(float[] samples)
    {
        if (samples.Length == 0) return new("", true);
        if (samples.Length > BanbanSpeechSegmenter.MaximumSamples) return new("", true, Unrecognized: true);
        return new(_recognizer.Recognize(samples), true);
    }

    public void Dispose() => _recognizer.Dispose();
}

internal sealed record BanbanSpeechAudio(float[] Samples, bool Final, bool TooLong = false, bool DuringPlayback = false,
    int SpeechSamples = 0, int CapturedSamples = 0, long EndedAtTicks = 0);
internal sealed record BanbanSpeechJob(BanbanSpeechAudio Audio, int Generation, bool ControlsOnly);

/// <summary>Serial inference, bounded backlog, and cancellation checks both before and after decoding.</summary>
internal sealed class BanbanSpeechDecoder : IDisposable
{
    private readonly BlockingCollection<BanbanSpeechJob> _jobs = new(2);
    private readonly Func<float[], BanbanSpeechResult> _recognize;
    private readonly Func<int, bool> _current;
    private readonly Action<BanbanSpeechJob, BanbanSpeechResult, double> _complete;
    private readonly Action<Exception> _failed;
    private readonly Action _release;
    private readonly Thread _thread;
    private int _stopped;
    private bool _started;

    internal BanbanSpeechDecoder(Func<float[], BanbanSpeechResult> recognize, Func<int, bool> current,
        Action<BanbanSpeechJob, BanbanSpeechResult, double> complete, Action<Exception> failed, Action release)
    {
        _recognize = recognize; _current = current; _complete = complete; _failed = failed; _release = release;
        _thread = new Thread(Run) { IsBackground = true, Name = "ICeClass.BanbanASR" };
    }
    internal void Start() { _thread.Start(); _started = true; }
    internal bool Enqueue(BanbanSpeechAudio audio, int generation, bool controlsOnly)
    {
        if (Volatile.Read(ref _stopped) != 0) return false;
        try { return _jobs.TryAdd(new(audio, generation, controlsOnly)); }
        catch (InvalidOperationException) { return false; }
    }
    private void Run()
    {
        try
        {
            // The consuming iterator retains its last Current while waiting.
            // TryTake clears the previous PCM reference before blocking again.
            while (_jobs.TryTake(out var job, Timeout.Infinite))
            {
                if (Volatile.Read(ref _stopped) != 0) break;
                Decode(job);
            }
        }
        catch (Exception error) { if (Volatile.Read(ref _stopped) == 0) _failed(error); }
        finally { _release(); }
    }
    // Keep per-utterance native-call arguments off the idle worker's stack.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private void Decode(BanbanSpeechJob job)
    {
        if (!_current(job.Generation)) return;
        var start = Environment.TickCount64;
        var result = _recognize(job.Audio.Samples) with {
            Final = job.Audio.Final, DuringPlayback = job.ControlsOnly || job.Audio.DuringPlayback
        };
        if (Volatile.Read(ref _stopped) == 0 && _current(job.Generation))
            _complete(job, result, Environment.TickCount64 - start);
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        _jobs.CompleteAdding();
        if (_started) { if (_thread.Join(TimeSpan.FromSeconds(3))) _jobs.Dispose(); }
        else { _release(); _jobs.Dispose(); }
    }
}

/// <summary>Bounded in-memory speech with pre-roll, natural pauses and a single final result.</summary>
internal sealed class BanbanSpeechSegmenter : IDisposable
{
    internal const int MaximumSamples = 30 * 16000;
    // Silero can declare speech about 450 ms after a quiet first consonant.
    private const int PreRollSamples = 12800;
    // Include Silero's own hangover and code-switch onset delay: a shorter
    // cutoff splits quiet English words away from the surrounding instruction.
    private const int TrailingSilenceSamples = 16000;
    private const int PreviewSpeechSamples = 11200;
    private BanbanVoiceActivity? _activity;
    private readonly Func<float[], bool>? _detectSpeech;
    private readonly int _maximumSamples;
    private readonly bool _continuous;
    private readonly Queue<(float[] Samples, bool DuringPlayback)> _preRoll = new();
    private readonly List<float> _samples = new(64000);
    private int _preRollCount, _silence, _speech;
    private bool _active, _previewed, _discarding, _duringPlayback;
    internal bool SpeechDetected { get; private set; }

    internal BanbanSpeechSegmenter(int maximumSamples = MaximumSamples, bool continuous = false,
        Func<float[], bool>? detectSpeech = null)
    {
        if (maximumSamples < 16000 || maximumSamples > MaximumSamples) throw new ArgumentOutOfRangeException(nameof(maximumSamples));
        _maximumSamples = maximumSamples; _continuous = continuous; _detectSpeech = detectSpeech;
        if (detectSpeech is null) _activity = new();
    }

    internal BanbanSpeechAudio? Accept(float[] samples, bool preview = false, bool duringPlayback = false)
    {
        SpeechDetected = _detectSpeech?.Invoke(samples) ?? (_activity ??= new()).Accept(samples);
        _silence = SpeechDetected ? 0 : Math.Min(TrailingSilenceSamples, _silence + samples.Length);
        if (_discarding)
        {
            if (_silence >= TrailingSilenceSamples) Reset();
            return null;
        }
        if (!_active)
        {
            _preRoll.Enqueue((samples, duringPlayback || preview)); _preRollCount += samples.Length;
            while (_preRollCount > PreRollSamples && _preRoll.Count > 1) _preRollCount -= _preRoll.Dequeue().Samples.Length;
            if (!SpeechDetected) return null;
            foreach (var frame in _preRoll) { _samples.AddRange(frame.Samples); _duringPlayback |= frame.DuringPlayback; }
            _preRoll.Clear(); _preRollCount = 0; _active = true;
        }
        else _samples.AddRange(samples);
        _duringPlayback |= duringPlayback || preview;
        if (SpeechDetected) _speech += samples.Length;

        // Never turn the beginning of an overlong arrangement into an executable task.
        if (_samples.Count >= _maximumSamples)
        {
            if (_continuous)
            {
                var chunk = new BanbanSpeechAudio(_samples.ToArray(), true, DuringPlayback: _duringPlayback,
                    SpeechSamples: _speech, CapturedSamples: _samples.Count);
                // Keep the VAD's state across bounded chunks of uninterrupted speech.
                _samples.Clear(); _preRoll.Clear(); _preRollCount = _silence = _speech = 0;
                _active = _previewed = _duringPlayback = false;
                return chunk;
            }
            _samples.Clear(); _discarding = true;
            return new([], true, TooLong: true, DuringPlayback: _duringPlayback);
        }
        if (_silence >= TrailingSilenceSamples)
        {
            // Keep the decoder's previous tail context without waiting for
            // another quarter-second of real microphone silence.
            var complete = new float[Math.Min(MaximumSamples, _samples.Count + 4000)];
            _samples.CopyTo(complete);
            var result = new BanbanSpeechAudio(complete, true, DuringPlayback: _duringPlayback,
                SpeechSamples: _speech, CapturedSamples: _samples.Count);
            Reset(); return result;
        }
        // At most one preview during playback, used only for interruption.
        // Ordinary requests always wait for the complete utterance.
        if (preview && !_previewed && _speech >= PreviewSpeechSamples)
        {
            _previewed = true;
            return new(_samples.ToArray(), false, DuringPlayback: _duringPlayback,
                SpeechSamples: _speech, CapturedSamples: _samples.Count);
        }
        return null;
    }

    internal void Reset()
    {
        _activity?.Reset(); _preRoll.Clear(); _samples.Clear();
        _preRollCount = _silence = _speech = 0; _active = _previewed = _discarding = _duringPlayback = SpeechDetected = false;
    }

    public void Dispose() => _activity?.Dispose();
}

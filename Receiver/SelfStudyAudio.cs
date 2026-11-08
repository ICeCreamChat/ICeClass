using System.Collections.Concurrent;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace ICeClass.Receiver;

/// <summary>VAD only on a bounded worker; no audio files or cloud streaming.</summary>
internal sealed class SelfStudyAudio : IDisposable
{
    private readonly WaveInEvent _capture;
    private readonly BlockingCollection<float[]> _frames = new(20);
    private readonly Thread _worker;
    private readonly Action<BanbanSpeechAudio> _segment;
    private readonly Action _speech;
    private readonly Action _failed;
    private int _disposed, _overflow;
    internal SelfStudyAudio(Action<BanbanSpeechAudio> segment, Action speech, Action failed)
    {
        _segment = segment; _speech = speech; _failed = failed;
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
            try { if (!_frames.TryAdd(samples)) Interlocked.Exchange(ref _overflow, 1); }
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
        try
        {
            using var segmenter = new BanbanSpeechSegmenter();
            foreach (var samples in _frames.GetConsumingEnumerable())
            {
                if (Volatile.Read(ref _disposed) != 0) break;
                // Missing frames invalidate a segment; never concatenate across an overload.
                if (Interlocked.Exchange(ref _overflow, 0) != 0) segmenter.Reset();
                var segment = segmenter.Accept(samples);
                if (segmenter.SpeechDetected) _speech();
                if (segment is { Final: true }) _segment(segment);
            }
        }
        catch { if (Volatile.Read(ref _disposed) == 0) _failed(); }
        finally { _frames.Dispose(); }
    }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _capture.StopRecording(); _capture.Dispose();
        try { _frames.CompleteAdding(); } catch (ObjectDisposedException) { }
        // Never block the dispatcher while the native VAD is finishing.
    }
}

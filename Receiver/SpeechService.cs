namespace ICeClass.Receiver;

/// <summary>Notification and timetable speech use Banban's existing offline voice.</summary>
public sealed class SpeechService : IDisposable
{
    private readonly object _sync = new();
    private BanbanSpeechPlayer? _player;
    private int _failed;
    private bool _disposed;

    public void SpeakLatest(string text, int speed, double volume)
        => SpeakLatest(text, speed, volume, NotificationCue.None);

    internal void SpeakLatest(string text, int speed, double volume, NotificationCue cue)
    {
        lock (_sync)
        {
            if (_disposed) return;
            _player?.Stop();
            if (string.IsNullOrWhiteSpace(text) || !double.IsFinite(volume) || volume <= 0) return;
            if (Volatile.Read(ref _failed) != 0) { _player?.Dispose(); _player = null; }
            if (_player is null)
            {
                Volatile.Write(ref _failed, 0);
                _player = new BanbanSpeechPlayer(_ => { }, (_, _) => { }, error =>
                {
                    Volatile.Write(ref _failed, 1);
                    AppLog.Error("Notification neural speech failed", error);
                });
            }
            var rate = BanbanNeuralSynthesizer.DefaultSpeed * (float)Math.Pow(2, Math.Clamp(speed, -10, 10) / 10.0);
            _player.Enqueue(BanbanVoiceService.SpeechText(text), true, rate, (float)Math.Clamp(volume, 0, 1), cue);
        }
    }

    public void Stop()
    {
        lock (_sync) { if (!_disposed) _player?.Stop(); }
    }

    public void Dispose()
    {
        BanbanSpeechPlayer? player;
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            player = _player; _player = null;
        }
        player?.Dispose();
    }
}

using System.Diagnostics;

namespace ICeClass.Receiver;

internal sealed class QueuedShout(ShoutData data, Action<ShoutCloseReason> closed, Action suspended, long expiresAt, long order)
{
    public ShoutData Data { get; } = data;
    public Action<ShoutCloseReason> Closed { get; } = closed;
    public Action Suspended { get; } = suspended;
    public long ExpiresAt { get; } = expiresAt;
    public long Order { get; } = order;
    public int Priority => Data.IsPreview ? -1 : Rank(Data.AlertLevel);
    public double Remaining { get; private set; } = Math.Clamp(data.DisplayDurationSec, 5, 60);
    public long Started { get; private set; }
    public TaskCompletionSource Shown { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public static int Rank(string level) => level == "urgent" ? 2 : level == "warning" ? 1 : 0;
    public void Pause() => Remaining = Math.Max(0, Remaining - Stopwatch.GetElapsedTime(Started).TotalSeconds);
    public ShoutData Resume()
    {
        Started = Stopwatch.GetTimestamp();
        return new() { SenderName = Data.SenderName, Text = Data.Text, AlertLevel = Data.AlertLevel, ContentType = Data.ContentType,
            DisplayDurationSec = Math.Max(1, (int)Math.Ceiling(Remaining)), TtsSpeed = Data.TtsSpeed, TtsVolume = Data.TtsVolume,
            AudioUrl = Data.AudioUrl, AudioDurationMs = Data.AudioDurationMs, IsPreview = Data.IsPreview };
    }
}

namespace ICeClass.Receiver;

internal enum ShoutCloseReason { Acknowledged, Dismissed, TimedOut, Cancelled, Expired }

// Invoked on the UI thread. Completion means the notification surface is visible;
// playback and delivery acknowledgements stay with the existing receiver.
internal interface IShoutPresenter
{
    Task QueueAsync(ShoutData data, Action<ShoutCloseReason> closed, Action suspended, long expiresAt = 0);
    bool IsCurrent(ShoutData data);
    void Clear();
}

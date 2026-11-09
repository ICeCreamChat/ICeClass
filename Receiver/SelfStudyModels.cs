using System.Text.Json;

namespace ICeClass.Receiver;

internal sealed record SelfStudyConfig
{
    public bool Enabled { get; init; }
    public bool Authorized { get; init; }
    public bool AiEnabled { get; init; }
    public bool PhotoEnabled { get; init; } = true;
    public int DailyCalls { get; init; } = 4;
    public int DailyTokens { get; init; } = 2400;
    public string Sensitivity { get; init; } = "balanced";
    public int VoiceTriggerMs { get; init; } = 600;
    public int ObservationSeconds { get; init; } = 10;
    public int ReminderWaitSeconds { get; init; } = 90;
    public int ConfirmationsAfterReminder { get; init; } = 1;
    internal bool CanReview(SelfStudyUsage usage) => Enabled && Authorized && AiEnabled &&
        usage.Calls < DailyCalls && usage.Tokens + 1456 <= DailyTokens;
}
internal sealed record SelfStudyUsage
{
    public int Calls { get; init; }
    public int Tokens { get; init; }
}
internal sealed record SelfStudyPeriod
{
    public string Key { get; init; } = "";
    public string Title { get; init; } = "";
    public long StartAt { get; init; }
    public long EndAt { get; init; }
}
internal sealed record SelfStudySnapshot
{
    public string ClassId { get; init; } = "";
    public SelfStudyConfig Config { get; init; } = new();
    public int Revision { get; init; }
    public long ServerTime { get; init; }
    public List<SelfStudyPeriod> Schedule { get; init; } = [];
    public SelfStudyUsage Usage { get; init; } = new();
    public bool AiReady { get; init; }
    internal SelfStudyPeriod? Session(long now) => Config.Enabled && Config.Authorized
        ? Schedule.FirstOrDefault(p => p.StartAt <= now && now < p.EndAt) : null;
}
internal sealed record SelfStudyClip(long StartAt, long EndAt, float[] Samples, int SpeechMs);
internal sealed record SelfStudyUtterance(long StartAt, long EndAt, int SpeechMs, string Text);
internal sealed record SelfStudyCandidate(long StartAt, long EndAt, SelfStudyClip[] Clips,
    int SpeechMs, int LongestMs, double Level)
{
    internal int Segments => Clips.Length;
    internal SelfStudyCandidate AtServerTime(long serverTime, long clock)
    {
        var offset = serverTime - clock;
        return this with { StartAt = StartAt + offset, EndAt = EndAt + offset,
            Clips = Clips.Select(c => c with { StartAt = c.StartAt + offset, EndAt = c.EndAt + offset }).ToArray() };
    }
}

/// <summary>Consumed, non-overlapping clips. Only VAD-positive samples count as speech.</summary>
internal sealed class SelfStudyCandidateBuffer
{
    private readonly Queue<SelfStudyClip> _clips = new();
    internal int Count => _clips.Count;
    internal void Clear() => _clips.Clear();
    internal void Add(BanbanSpeechAudio audio, long at)
    {
        Expire(at);
        if (!audio.Final || audio.TooLong || audio.DuringPlayback || audio.SpeechSamples < 4800 ||
            audio.CapturedSamples < audio.SpeechSamples || audio.CapturedSamples > 8 * 16000 + 800 ||
            audio.Samples.Length < audio.CapturedSamples || audio.Samples.Length > 9 * 16000) return;
        var start = at - audio.CapturedSamples / 16;
        // A discontinuity cannot reuse the prior window's evidence.
        if (_clips.Count > 0 && start < _clips.Last().EndAt) Clear();
        var energy = audio.Samples.Sum(s => (double)s * s);
        if (!double.IsFinite(energy) || energy <= 0) return;
        _clips.Enqueue(new(start, at, audio.Samples, audio.SpeechSamples / 16));
        // Six individually bounded clips already cap PCM at 54 seconds. A second,
        // shorter PCM cap drops quieter speech before its effective duration accumulates.
        while (_clips.Count > 6) _clips.Dequeue();
    }
    internal SelfStudyCandidate? Take(long at, int observationSeconds = 10)
    {
        Expire(at);
        if (_clips.Count < 3) return null;
        var clips = _clips.ToArray();
        // After a cooldown the queue may be full. Use the newest consecutive clips
        // that meet the same evidence requirements, rather than decoding stale extras.
        var first = clips.Length - 3;
        while (first > 0 && (clips.Skip(first).Sum(c => c.SpeechMs) < 6000 ||
            clips[^1].EndAt - clips[first].StartAt < observationSeconds * 1000)) first--;
        clips = clips[first..];
        var start = clips[0].StartAt;
        var speech = clips.Sum(c => c.SpeechMs);
        var duration = clips[^1].EndAt - start;
        if (duration < observationSeconds * 1000 || speech < 6000 || speech > duration) return null;
        var rms = Math.Sqrt(clips.Sum(c => c.Samples.Sum(s => (double)s * s)) / clips.Sum(c => c.Samples.Length));
        _clips.Clear();
        return new(start, clips[^1].EndAt, clips, speech, clips.Max(c => c.SpeechMs),
            Math.Clamp(rms * 100, 0, 100));
    }
    private void Expire(long at) { while (_clips.TryPeek(out var c) && at - c.StartAt > 60000) _clips.Dequeue(); }
}

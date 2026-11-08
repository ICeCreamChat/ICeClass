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
internal sealed record SelfStudyCandidate(long StartAt, long EndAt, float[] Samples,
    int Segments, int SpeechMs, int LongestMs, double Level);

/// <summary>A small, consumed window. Long speech is treated as possible teaching.</summary>
internal sealed class SelfStudyCandidateBuffer
{
    private readonly Queue<(float[] Samples, long At)> _clips = new();
    private long _holdUntil;
    internal int Count => _clips.Count;
    internal void Clear() { _clips.Clear(); _holdUntil = 0; }
    internal void Add(float[] samples, long at)
    {
        Expire(at);
        if (samples.Length >= 12 * 16000)
        {
            _clips.Clear(); _holdUntil = at + 90000; return;
        }
        if (at < _holdUntil || samples.Length < 16000 || samples.Length > 8 * 16000) return;
        _clips.Enqueue((samples, at));
        while (_clips.Count > 6 || _clips.Sum(c => c.Samples.Length) > 24 * 16000) _clips.Dequeue();
    }
    internal SelfStudyCandidate? Take(long at)
    {
        Expire(at);
        if (at < _holdUntil || _clips.Count < 3) return null;
        var clips = _clips.ToArray();
        var start = clips[0].At - clips[0].Samples.Length / 16;
        var speech = clips.Sum(c => c.Samples.Length) / 16;
        if (at - start < 10000 || speech < 6000 || speech > at - start) return null;
        var samples = clips.SelectMany(c => c.Samples).ToArray();
        var rms = Math.Sqrt(samples.Sum(s => (double)s * s) / samples.Length);
        _clips.Clear();
        return new(start, at, samples, clips.Length, speech, clips.Max(c => c.Samples.Length) / 16,
            Math.Clamp(rms * 100, 0, 100));
    }
    private void Expire(long at) { while (_clips.TryPeek(out var c) && at - c.At > 60000) _clips.Dequeue(); }
}

namespace ICeClass.Receiver;

internal sealed record IslandDemoStage(string Title, double At);
internal sealed record IslandDemoScene(IslandProfile Profile, DateTimeOffset Now, ClassroomIslandView View, int Stage);

// A separate, monotonic sample clock feeds the production presenter. No classroom
// configuration, reminder ledger, server clock or notification state is changed.
internal sealed class IslandDemoPlayback
{
    public const double Duration = 72;
    public static IReadOnlyList<IslandDemoStage> Stages { get; } = [
        new("课表", 0), new("即将上课", 2), new("倒计时", 5),
        new("课前提示", 12), new("上课", 62), new("恢复课表", 67),
    ];
    private readonly TimeProvider _clock;
    private readonly DateTimeOffset _begin;
    private readonly IslandProfile _profile;
    private double _position;
    private long _started;
    private bool _playing;
    public double Position => Math.Clamp(_position + (_playing ? _clock.GetElapsedTime(_started).TotalSeconds : 0), 0, Duration);
    public bool Complete => Position >= Duration;
    public bool Playing => _playing && !Complete;

    public IslandDemoPlayback(DateOnly date, TimeProvider? clock = null)
    {
        _clock = clock ?? TimeProvider.System;
        _begin = new(date.ToDateTime(new TimeOnly(10, 38, 58)), TimeSpan.FromHours(8));
        var weekday = date.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)date.DayOfWeek;
        var monday = date.AddDays(-(weekday - 1));
        _profile = new() { WeekAnchor = monday.ToString("yyyy-MM-dd"),
            Reminders = new() { PrepareMinutes = 1, DisplaySeconds = 5, Sound = false, Speech = false } };
        foreach (var (id, subject, start, end) in new[] {
            ("chinese", "语文", 480, 520), ("math", "数学", 530, 575),
            ("art", "美术", 585, 630), ("history", "历史", 640, 680),
            ("music", "音乐", 690, 730), ("physics", "物理", 840, 880),
        })
        {
            _profile.Slots.Add(new() { Id = id, Label = subject, Start = start, End = end });
            _profile.Lessons.Add(new() { SlotId = id, Weekday = weekday, Subject = subject });
        }
    }

    public void Play()
    {
        if (Playing) return;
        if (Complete) _position = 0;
        _started = _clock.GetTimestamp(); _playing = true;
    }
    public void Pause() { _position = Position; _playing = false; }
    public void Restart() { _position = 0; _playing = false; Play(); }
    public void Seek(double seconds)
    {
        _position = Math.Clamp(double.IsFinite(seconds) ? seconds : 0, 0, Duration);
        _started = _clock.GetTimestamp();
    }

    public IslandDemoScene Scene()
    {
        var at = Position;
        var now = _begin.AddSeconds(at);
        ClassroomIslandNotice? notice = at switch {
            >= 2 and < 5 => new("准备上课", "请回到座位，做好上课准备。", "info", "教室提醒", 1, 1 - (at - 2) / 3, at - 2),
            >= 62 and < 67 => new("上课啦", "历史课开始，请保持安静。", "info", "教室提醒", 2, 1 - (at - 62) / 5, at - 62),
            _ => null,
        };
        var remaining = Math.Max(0, (int)Math.Ceiling(62 - at));
        var view = new ClassroomIslandView("演示班", now.ToString("HH:mm:ss"), now.ToString("MM月dd日"),
            at < 62 ? "课间休息" : "历史课上课中", at < 62 ? "下节 历史" : "历史 · 上课中",
            at < 62 ? $"10:40-11:20 · 距上课 {remaining} 秒" : "10:40-11:20 · 下节 音乐",
            false, true, "本机演示 · 示例课表", notice, "本机演示不启动早读，可退出演示后打开。");
        var frame = IslandRibbonPresentation.Build(_profile, now, view);
        var stage = at < 2 ? 0 : at < 5 ? 1 : at >= 67 ? 5 : at >= 62 ? 4 : frame.Key == "prepare:message" ? 3 : 2;
        return new(_profile, now, view, stage);
    }
}

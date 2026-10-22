using System.Globalization;
using System.Text.Json;

namespace ICeClass.Receiver;

internal sealed class IslandProfile
{
    public int SchemaVersion { get; set; } = 1;
    public bool Enabled { get; set; } = true;
    public string WeekAnchor { get; set; } = "2026-09-07";
    public List<IslandSlot> Slots { get; set; } = [];
    public List<IslandLesson> Lessons { get; set; } = [];
    public List<IslandOverride> Overrides { get; set; } = [];
    public IslandReminders Reminders { get; set; } = new();
    public IslandAppearance Appearance { get; set; } = new();
    public List<IslandComponent> Components { get; set; } = [];
    public int RotationSeconds { get; set; } = 8;
    public List<IslandAutomation> Automation { get; set; } = [];
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static IslandProfile Parse(string json)
    {
        var p = JsonSerializer.Deserialize<IslandProfile>(json, Json) ?? throw new InvalidDataException("教室岛配置为空。");
        if (p.SchemaVersion != 1 || p.Slots is null || p.Lessons is null || p.Overrides is null ||
            p.Reminders is null || p.Appearance is null || p.Components is null || p.Automation is null ||
            p.Slots.Count > 32 || p.Lessons.Count > 448 || p.Overrides.Count > 500 || p.Components.Count > 16 || p.Automation.Count > 40 ||
            !DateOnly.TryParseExact(p.WeekAnchor, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var anchor) || anchor.DayOfWeek != DayOfWeek.Monday ||
            p.Slots.Any(s => s is null || !ValidText(s.Id, 60, false) || !ValidText(s.Label, 30, false) || s.Start < 0 || s.End > 1440 || s.Start >= s.End) ||
            p.Slots.Select(s => s.Id).Distinct().Count() != p.Slots.Count ||
            p.Lessons.Any(l => l is null || l.Weekday is < 1 or > 7 || l.Week is not ("all" or "odd" or "even") || !p.Slots.Any(s => s.Id == l.SlotId) ||
                !ValidText(l.Subject, 40, false) || !ValidText(l.Teacher, 40) || !ValidText(l.Location, 60)) ||
            p.Overrides.Any(o => o is null || !DateOnly.TryParseExact(o.Date, "yyyy-MM-dd", out _) || !p.Slots.Any(s => s.Id == o.SlotId) ||
                !ValidText(o.Subject, 40, o.Cancelled) || !ValidText(o.Teacher, 40) || !ValidText(o.Location, 60)) ||
            p.Components.Any(c => c is null || !ValidText(c.Id, 60, false) || !ValidText(c.Title, 40) || !ValidText(c.Text, 240) || c.Date is null ||
                c.Type is not ("date" or "text" or "countdown") || c.Type == "countdown" && !DateOnly.TryParseExact(c.Date, "yyyy-MM-dd", out _)) ||
            p.Automation.Any(r => r is null || !ValidText(r.Id, 60, false) || !ValidText(r.Name, 60, false) || !ValidText(r.Value, 500, r.Action == "reading") ||
                r.Weekdays is null || r.Weekdays.Length is < 1 or > 7 || r.Weekdays.Any(d => d is < 1 or > 7) || r.Trigger is not ("time" or "prepare" or "start" or "end") ||
                r.Action is not ("reminder" or "website" or "app" or "reading") || r.Minute is < 0 or > 1439))
            throw new InvalidDataException("教室岛配置格式无效，保留上次配置。");
        var lessonKeys = p.Lessons.SelectMany(l => (l.Week == "all" ? new[] { "odd", "even" } : new[] { l.Week }).Select(w => (l.SlotId, l.Weekday, w))).ToList();
        if (lessonKeys.Distinct().Count() != lessonKeys.Count || p.Overrides.Select(o => (o.Date, o.SlotId)).Distinct().Count() != p.Overrides.Count ||
            p.Components.Select(c => c.Id).Distinct().Count() != p.Components.Count || p.Automation.Select(r => r.Id).Distinct().Count() != p.Automation.Count)
            throw new InvalidDataException("教室岛配置包含重复课程、调课、组件或规则。");
        p.Slots = p.Slots.OrderBy(s => s.Start).ToList();
        if (p.Slots.Zip(p.Slots.Skip(1)).Any(pair => pair.First.End > pair.Second.Start)) throw new InvalidDataException("作息时段重叠。");
        p.RotationSeconds = Math.Clamp(p.RotationSeconds, 3, 120);
        p.Reminders.PrepareMinutes = Math.Clamp(p.Reminders.PrepareMinutes, 1, 30);
        p.Reminders.DisplaySeconds = Math.Clamp(p.Reminders.DisplaySeconds, 3, 60);
        p.Reminders.Volume = Math.Clamp(p.Reminders.Volume, 0, 100);
        p.Appearance.Clamp();
        return p;
    }
    private static bool ValidText(string? value, int limit, bool empty = true) => value is not null && value.Length <= limit &&
        !value.Any(c => c < 32) && (empty || !string.IsNullOrWhiteSpace(value));
}

internal sealed class IslandSlot
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public int Start { get; set; }
    public int End { get; set; }
}
internal class IslandLesson
{
    public string SlotId { get; set; } = "";
    public int Weekday { get; set; }
    public string Week { get; set; } = "all";
    public string Subject { get; set; } = "";
    public string Teacher { get; set; } = "";
    public string Location { get; set; } = "";
}
internal sealed class IslandOverride : IslandLesson
{
    public string Date { get; set; } = "";
    public bool Cancelled { get; set; }
}
internal sealed class IslandReminders
{
    public bool Enabled { get; set; } = true;
    public bool Prepare { get; set; } = true;
    public bool Start { get; set; } = true;
    public bool End { get; set; } = true;
    public int PrepareMinutes { get; set; } = 2;
    public bool Sound { get; set; }
    public bool Speech { get; set; }
    public int Volume { get; set; } = 65;
    public int DisplaySeconds { get; set; } = 8;
}
internal sealed class IslandAppearance
{
    public string Position { get; set; } = "top-center";
    public int Width { get; set; } = 560;
    public int Opacity { get; set; } = 100;
    public string Theme { get; set; } = "light";
    public bool ClickThrough { get; set; }
    public bool HideFullscreen { get; set; } = true;
    public bool HideDuringLessons { get; set; }
    public int OffsetX { get; set; }
    public int OffsetY { get; set; }
    public void Clamp()
    {
        Width = Math.Clamp(Width, 380, 1000); Opacity = Math.Clamp(Opacity, 30, 100);
        OffsetX = Math.Clamp(OffsetX, -2000, 2000); OffsetY = Math.Clamp(OffsetY, -2000, 2000);
        if (Position is not ("top-center" or "top-left" or "top-right" or "bottom-center")) Position = "top-center";
        if (Theme is not ("dark" or "light" or "system")) Theme = "light";
    }
}
internal sealed class IslandComponent
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "text";
    public bool Enabled { get; set; } = true;
    public string Title { get; set; } = "";
    public string Text { get; set; } = "";
    public string Date { get; set; } = "";
}
internal sealed class IslandAutomation
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Trigger { get; set; } = "time";
    public int Minute { get; set; } = 480;
    public int[] Weekdays { get; set; } = [1, 2, 3, 4, 5];
    public string Action { get; set; } = "reminder";
    public string Value { get; set; } = "";
}

internal sealed record IslandResolvedLesson(DateOnly Date, IslandSlot Slot, IslandLesson Lesson, bool Temporary)
{
    public DateTimeOffset At(int minute) => new(Date.ToDateTime(TimeOnly.MinValue).AddMinutes(minute), TimeSpan.FromHours(8));
    public string Summary => $"{Slot.Start / 60:00}:{Slot.Start % 60:00}—{Slot.End / 60:00}:{Slot.End % 60:00}  {Lesson.Subject}" +
        (string.IsNullOrWhiteSpace(Lesson.Teacher) ? "" : $" · {Lesson.Teacher}") + (string.IsNullOrWhiteSpace(Lesson.Location) ? "" : $" · {Lesson.Location}") + (Temporary ? " · 调课" : "");
}
internal sealed record IslandDueEvent(string Key, DateTimeOffset At, string Title, string Text, IslandAutomation? Automation = null);

internal static class IslandSchedule
{
    public static List<IslandResolvedLesson> On(IslandProfile p, DateOnly day)
    {
        var week = (int)Math.Floor((day.DayNumber - DateOnly.ParseExact(p.WeekAnchor, "yyyy-MM-dd").DayNumber) / 7.0);
        var parity = week % 2 == 0 ? "odd" : "even";
        var weekday = day.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)day.DayOfWeek;
        var result = new List<IslandResolvedLesson>();
        foreach (var s in p.Slots)
        {
            var change = p.Overrides.FirstOrDefault(o => o.Date == day.ToString("yyyy-MM-dd") && o.SlotId == s.Id);
            var lesson = change ?? p.Lessons.FirstOrDefault(l => l.SlotId == s.Id && l.Weekday == weekday && (l.Week == "all" || l.Week == parity));
            if (lesson is null || change?.Cancelled == true) continue;
            result.Add(new(day, s, lesson, change is not null));
        }
        return result.OrderBy(x => x.Slot.Start).ToList();
    }

    public static string Status(IslandProfile p, DateTimeOffset now)
    {
        now = now.ToOffset(TimeSpan.FromHours(8));
        var lessons = On(p, DateOnly.FromDateTime(now.DateTime));
        var current = lessons.FirstOrDefault(l => l.At(l.Slot.Start) <= now && now < l.At(l.Slot.End));
        static string Remaining(TimeSpan t) => t.TotalMinutes < 1 ? $"{Math.Max(1, (int)Math.Ceiling(t.TotalSeconds))} 秒" : $"{(int)Math.Ceiling(t.TotalMinutes)} 分钟";
        if (current is not null) return $"{current.Lesson.Subject} · 距下课 {Remaining(current.At(current.Slot.End) - now)}";
        var next = lessons.FirstOrDefault(l => l.At(l.Slot.Start) > now);
        if (next is not null) return $"下节 {next.Lesson.Subject} · 距上课 {Remaining(next.At(next.Slot.Start) - now)}";
        next = Next(p, now);
        return next is not null ? $"下节 {next.Lesson.Subject} · {next.Date:M月d日} {next.Slot.Start / 60:00}:{next.Slot.Start % 60:00}" : lessons.Count > 0 ? "今日课程已结束" : "今天没有课程";
    }

    public static IslandResolvedLesson? Next(IslandProfile p, DateTimeOffset now)
    {
        var day = DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime);
        for (var i = 0; i <= 7; i++)
        {
            var next = On(p, day.AddDays(i)).FirstOrDefault(l => l.At(l.Slot.Start) > now);
            if (next is not null) return next;
        }
        return null;
    }

    public static List<IslandDueEvent> Due(IslandProfile p, DateTimeOffset previous, DateTimeOffset now)
    {
        if (!p.Enabled || now < previous) return [];
        // Skip stale wake-from-sleep events. No catch-up launch of old applications.
        if ((now - previous).TotalSeconds > 30) previous = now.AddSeconds(-2);
        var day = DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime);
        var events = new List<IslandDueEvent>();
        for (var offset = -1; offset <= 1; offset++)
        {
            var on = day.AddDays(offset);
            var weekday = on.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)on.DayOfWeek;
            foreach (var lesson in On(p, on))
            {
                foreach (var kind in new[] { "prepare", "start", "end" })
                {
                    var at = lesson.At(kind == "end" ? lesson.Slot.End : lesson.Slot.Start - (kind == "prepare" ? p.Reminders.PrepareMinutes : 0));
                    if (at <= previous || at > now) continue;
                    var title = kind == "prepare" ? "准备上课" : kind == "start" ? "上课啦" : "下课啦";
                    var detail = kind == "prepare" ? $"{lesson.Lesson.Subject}将在 {p.Reminders.PrepareMinutes} 分钟后开始，请做好准备。" : kind == "start" ? $"现在开始{lesson.Lesson.Subject}，请专心上课。" : $"{lesson.Lesson.Subject}已结束，请适当休息。";
                    var key = $"{on:yyyy-MM-dd}:{kind}:{lesson.Slot.Id}";
                    var enabled = kind == "prepare" ? p.Reminders.Prepare : kind == "start" ? p.Reminders.Start : p.Reminders.End;
                    if (p.Reminders.Enabled && enabled) events.Add(new(key, at, title, detail));
                    foreach (var rule in p.Automation.Where(r => r.Enabled && r.Trigger == kind && r.Weekdays.Contains(weekday)))
                        events.Add(new(key + ":rule:" + rule.Id, at, rule.Name, rule.Value, rule));
                }
            }
            foreach (var rule in p.Automation.Where(r => r.Enabled && r.Trigger == "time" && r.Weekdays.Contains(weekday)))
            {
                var at = new DateTimeOffset(on.ToDateTime(TimeOnly.MinValue).AddMinutes(rule.Minute), TimeSpan.FromHours(8));
                if (at > previous && at <= now) events.Add(new($"{on:yyyy-MM-dd}:time:{rule.Minute}:rule:{rule.Id}", at, rule.Name, rule.Value, rule));
            }
        }
        return events.OrderBy(e => e.At).ToList();
    }

    public static string ComponentText(IslandComponent c, DateTimeOffset now)
    {
        var local = now.ToOffset(TimeSpan.FromHours(8));
        return c.Type switch
        {
            "date" => local.ToString("M月d日 dddd", CultureInfo.GetCultureInfo("zh-CN")),
            "countdown" => Countdown(c, DateOnly.FromDateTime(local.DateTime)),
            _ => string.IsNullOrWhiteSpace(c.Title) ? c.Text : $"{c.Title} · {c.Text}",
        };
    }
    private static string Countdown(IslandComponent c, DateOnly today)
    {
        var days = DateOnly.ParseExact(c.Date, "yyyy-MM-dd").DayNumber - today.DayNumber;
        return days > 0 ? $"距{c.Title} {days} 天" : days == 0 ? $"{c.Title}就在今天" : $"{c.Title}已过 {-days} 天";
    }
}

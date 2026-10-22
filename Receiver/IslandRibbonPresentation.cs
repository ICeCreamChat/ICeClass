using System.Globalization;

namespace ICeClass.Receiver;

internal sealed record IslandRibbonItem(string Id, string Subject, string Time, bool Current, bool Past, double Progress = 0, bool SeparatorBefore = false);
internal sealed record IslandRibbonShout(string Sender, string Text, string Level, string ContentType, double AgeSeconds, long Sequence);
internal sealed record IslandRibbonFrame(string Key, string Date, IReadOnlyList<IslandRibbonItem> Items,
    string Text = "", string Detail = "", double Progress = 0, bool Accent = false, string Color = "#14FFFA", double ProgressPerSecond = 0, string Announcement = "", IslandRibbonShout? Shout = null)
{
    public string AccessibleText => string.Join("，", new[] { Date, Text, Detail, Announcement,
        string.Join("，", Items.Select(i => i.Subject + " " + i.Time)) }.Where(s => s.Length > 0));
}

// One presentation contract for the thin ribbon. It consumes the existing resolved
// timetable and accepted notices, and never dispatches an action or changes a profile.
internal static class IslandRibbonPresentation
{
    public static IslandRibbonFrame Build(IslandProfile? profile, DateTimeOffset now, ClassroomIslandView view, string component = "")
    {
        now = now.ToOffset(TimeSpan.FromHours(8));
        var day = DateOnly.FromDateTime(now.DateTime);
        var date = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)now.DayOfWeek] + now.ToString(" MM/dd");
        var lessons = profile is null ? [] : IslandSchedule.On(profile, day);
        var current = lessons.FirstOrDefault(l => l.At(l.Slot.Start) <= now && now < l.At(l.Slot.End));
        var next = lessons.FirstOrDefault(l => l.At(l.Slot.Start) > now);
        var items = lessons.Select((l,index) => new IslandRibbonItem(l.Slot.Id, l.Lesson.Subject,
            Time(l.Slot.Start) + "-" + Time(l.Slot.End), l == current, l.At(l.Slot.End) <= now,
            l == current ? Math.Clamp((now - l.At(l.Slot.Start)).TotalSeconds / ((l.Slot.End - l.Slot.Start) * 60), 0, 1) : 0,
            index>0 && l.Slot.Start-lessons[index-1].Slot.End>=40)).ToList();
        if (current is null && next is not null)
        {
            var previous = lessons.LastOrDefault(l => l.At(l.Slot.End) <= now);
            var start = previous?.Slot.End ?? Math.Max(0, next.Slot.Start - (profile?.Reminders.PrepareMinutes ?? 2));
            var progress = Math.Clamp((now - next.At(start)).TotalSeconds / Math.Max(1, (next.Slot.Start - start) * 60), 0, 1);
            if(previous is not null || now>=next.At(start))
                items.Insert(items.FindIndex(i => i.Id == next.Slot.Id), new("break", previous is null ? "课前准备" : "课间休息",
                    Time(start) + "-" + Time(next.Slot.Start), true, false, progress));
        }
        next ??= profile is not null ? IslandSchedule.Next(profile,now) : null;
        var remaining = next is null ? 0 : (next.At(next.Slot.Start) - now).TotalSeconds;
        var preparing = profile?.Reminders is { Enabled: true, Prepare: true } reminders && remaining > 0 && remaining <= reminders.PrepareMinutes * 60;
        if (view.Notice is { } notice)
        {
            if (notice.Category == "班级通知")
            {
                var label = notice.Level switch { "urgent" => "紧急喊话", "warning" => "重要喊话", _ => "班级喊话" };
                if (notice.ContentType == "audio") label = "语音 · " + label;
                var color = notice.Level == "urgent" ? "#FF9B91" : notice.Level == "warning" ? "#FFD178" : "#14FFFA";
                var cue = notice.AgeSeconds < IslandShoutText.CueSecondsFor(notice.Level);
                return new("shout:" + notice.Sequence + (cue ? ":cue" : ":message"), date, items,
                    cue ? "班班传话" : notice.Text, notice.Sender + " · " + label, notice.Progress, Accent: cue, Color: color,
                    ProgressPerSecond: notice.DurationSeconds > 0 ? 1.0 / notice.DurationSeconds : 0, Announcement: notice.Sender + "，" + notice.Text,
                    Shout: new(notice.Sender, notice.Text, notice.Level, notice.ContentType, notice.AgeSeconds, notice.Sequence));
            }
            // The preparation countdown continues until the lesson, after its short
            // attention cue. Ordinary class notices retain their full display time.
            var prepareNotice = preparing && notice.Category == "教室提醒" && notice.Sender == "准备上课";
            if (!prepareNotice || notice.AgeSeconds < 3)
            {
                var title = notice.Sender switch { "准备上课" => "即将上课", "上课啦" => "上课", "下课啦" => "下课", _ => notice.Sender };
                var color = notice.Level == "urgent" ? "#FF9B91" : notice.Level == "warning" ? "#FFD178" : "#14FFFA";
                var system = notice.Category == "教室提醒" && notice.Sender is "准备上课" or "上课啦" or "下课啦";
                var accent = system || notice.AgeSeconds < 3;
                return new("notice:" + notice.Sequence + (accent ? ":cue" : ":message"), date, items,
                    accent ? title : notice.Text, accent ? notice.Text : "", notice.Progress, accent, color,
                    notice.AgeSeconds>0 ? (1-notice.Progress)/notice.AgeSeconds : 0);
            }
        }
        if (preparing && next is not null)
        {
            var seconds = Math.Max(1, (int)Math.Ceiling(remaining));
            var alternate = (int)(profile!.Reminders.PrepareMinutes * 60 - remaining) / 10 % 2 == 1;
            return alternate
                ? new("prepare:message", date, items, "准备上课，请回到座位并保持安静，做好上课准备。", Progress: remaining / (profile.Reminders.PrepareMinutes * 60),ProgressPerSecond:1.0/(profile.Reminders.PrepareMinutes*60))
                : new("prepare:countdown", date, items, $"距上课还有 {seconds} 秒", $"下节课是：{next.Lesson.Subject} {Time(next.Slot.Start)}-{Time(next.Slot.End)}",
                    remaining / (profile.Reminders.PrepareMinutes * 60),ProgressPerSecond:1.0/(profile.Reminders.PrepareMinutes*60));
        }
        if (items.Count == 0) return new("idle", date, items, component.Length > 0 ? component : view.Status);
        if (component.Length > 0 && now.ToUnixTimeSeconds() / Math.Max(3, profile!.RotationSeconds) % 4 == 3)
            return new("component:" + component, date, items, component);
        return new("timetable", date, items);
    }

    internal static string Time(int minute) => $"{minute / 60:00}:{minute % 60:00}";
    internal static string ShortSubject(string value) => value.Length > 0 ? StringInfo.GetNextTextElement(value) : "";
}

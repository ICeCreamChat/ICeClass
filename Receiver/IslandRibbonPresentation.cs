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
        var displayed = lessons.Select(l => (l.Slot, l.Lesson.Subject)).ToList();
        // Labels for unassigned study periods belong only to the ribbon.
        // IslandSchedule keeps actual courses for hiding, reminders and actions.
        if (profile is not null && lessons.Count > 0)
        {
            var studyIds = profile.DutyRotations.Where(d => d.Key is "midday" or "evening").SelectMany(d => d.Value.SlotIds).ToHashSet();
            var occupied = lessons.Select(l => l.Slot.Id).ToHashSet();
            var cancelled = profile.Overrides.Where(o => o.Date == day.ToString("yyyy-MM-dd") && o.Cancelled).Select(o => o.SlotId).ToHashSet();
            displayed.AddRange(profile.Slots.Where(s => !occupied.Contains(s.Id) && !cancelled.Contains(s.Id) &&
                (studyIds.Contains(s.Id) || s.Id.StartsWith("evening-study-") || s.Label.Contains("午间静校") || s.Label.Contains("晚自习") || s.Label.Contains("晚自修")))
                .Select(s => (s, s.Label)));
        }
        displayed = displayed.OrderBy(l => l.Slot.Start).ToList();
        var middayIds = profile?.DutyRotations.GetValueOrDefault("midday")?.SlotIds ?? [];
        bool Midday(IslandSlot slot) => middayIds.Contains(slot.Id) || slot.Label.Contains("午间静校");
        bool Isolated(IslandSlot slot) => Midday(slot) || slot.Id == "morning-reading" || slot.Label.Contains("晨读") || slot.Label.Contains("早读");
        var minute = now.TimeOfDay.TotalMinutes;
        var items = displayed.Select((l,index) => new IslandRibbonItem(l.Slot.Id, l.Subject,
            Time(l.Slot.Start) + "-" + Time(l.Slot.End), l.Slot.Start <= minute && minute < l.Slot.End, l.Slot.End <= minute,
            Math.Clamp((minute-l.Slot.Start) / (l.Slot.End-l.Slot.Start), 0, 1),
            index>0 && (l.Slot.Start-displayed[index-1].Slot.End>=40 || Isolated(displayed[index-1].Slot) || Midday(l.Slot)))).ToList();
        var nextDisplay = displayed.FindIndex(l => l.Slot.Start > minute);
        if (!items.Any(i => i.Current) && nextDisplay >= 0)
        {
            var previous = displayed.FindLastIndex(l => l.Slot.End <= minute);
            var nextSlot = displayed[nextDisplay].Slot;
            var start = previous >= 0 ? displayed[previous].Slot.End : Math.Max(0, nextSlot.Start - (profile?.Reminders.PrepareMinutes ?? 2));
            var progress = Math.Clamp((minute-start) / Math.Max(1, nextSlot.Start-start), 0, 1);
            if(previous >= 0 || minute >= start)
            {
                var separatorBefore = previous >= 0 && Isolated(displayed[previous].Slot);
                if (separatorBefore) items[nextDisplay] = items[nextDisplay] with { SeparatorBefore = Midday(nextSlot) };
                items.Insert(nextDisplay, new("break", previous < 0 ? "课前准备" : "课间休息",
                    Time(start) + "-" + Time(nextSlot.Start), true, false, progress, separatorBefore));
            }
        }
        var next = lessons.FirstOrDefault(l => l.At(l.Slot.Start) > now);
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

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

internal sealed record ClassroomIslandNotice(string Sender, string Text, string Level, string Category = "班级通知", long Sequence = 0,
    double Progress = 1, double AgeSeconds = 0, string ContentType = "text", int DurationSeconds = 0);
internal sealed record ClassroomIslandView(string ClassName, string Clock, string Date, string Status,
    string ReadingTitle, string ReadingDetail, bool CanOpenReading, bool Connected, string ConnectionText,
    ClassroomIslandNotice? Notice, string? ReadingUnavailableReason = null);

// Presentation only: use the existing local rule cache and accepted notifications.
// The island never starts a reading session or acknowledges a notification by itself.
internal sealed class ClassroomIslandState(TimeProvider? timeProvider = null)
{
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private ReceiverConfig? _binding;
    private string _scope = "";
    private ClassroomIslandNotice? _notice;
    private long _receivedAt;
    private TimeSpan _noticeDuration;
    private long _noticeSequence;

    public void SetBinding(ReceiverConfig binding)
    {
        var scope = ReceiverConfig.NormalizeEndpoint(binding.Endpoint) + "\n" + binding.DeviceId + "\n" + binding.ClassId;
        if (_scope != scope) DismissNotice();
        _scope = scope;
        _binding = binding;
    }

    public void Receive(ShoutData data)
    {
        _notice = new ClassroomIslandNotice(string.IsNullOrWhiteSpace(data.SenderName) ? "班级通知" : data.SenderName,
            data.ContentType == "audio" ? "收到一条语音通知，请留意教室播放。" : data.Text, data.AlertLevel, Sequence: ++_noticeSequence,
            ContentType: data.ContentType, DurationSeconds: Math.Clamp(data.DisplayDurationSec, 1, 60));
        _receivedAt = _clock.GetTimestamp();
        _noticeDuration = TimeSpan.FromSeconds(Math.Clamp(data.DisplayDurationSec, 1, 60));
    }

    public void DismissNotice() => _notice = null;

    public void LocalNotice(string title, string text, int seconds)
    {
        _notice = new(title, text, "info", "教室提醒", ++_noticeSequence);
        _receivedAt = _clock.GetTimestamp();
        _noticeDuration = TimeSpan.FromSeconds(Math.Clamp(seconds, 3, 60));
    }

    public ClassroomIslandView Present(JsonObject? snapshot, long serverTime, ReceiverConnectionState connection, bool readingOpen)
    {
        if (_notice is not null && _clock.GetElapsedTime(_receivedAt) >= _noticeDuration) DismissNotice();
        var local = DateTimeOffset.FromUnixTimeMilliseconds(serverTime).ToOffset(TimeSpan.FromHours(8));
        var weekday = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)local.DayOfWeek];
        var className = string.IsNullOrWhiteSpace(_binding?.ClassName) ? "本班教室" : _binding.ClassName;
        var title = "正在同步早读设置";
        var detail = connection.Connected ? "同步完成后显示本班早读时段。" : "网络恢复后同步设置，仍可打开本机早读活动。";
        var matches = snapshot?["classId"]?.GetValue<string>() == _binding?.ClassId;
        var revoked = matches && snapshot?["revoked"]?.GetValue<bool>() == true;
        if (revoked)
        {
            title = "教室需要重新绑定";
            detail = "请打开教室首页，进入绑定设置。";
        }
        else if (matches && snapshot?["hasRules"]?.GetValue<bool>() == true && snapshot["config"] is JsonObject rules)
        {
            var schedule = JsonSerializer.Deserialize<ReadingSchedule>(rules.ToJsonString(), JsonOptions)!;
            // The reminder switch controls popups, not whether a scoring period is active.
            schedule = new ReadingSchedule { Enabled = schedule.Enabled, ReminderEnabled = true,
                Periods = schedule.Periods, ClassId = _binding!.ClassId, ClassName = className };
            var current = schedule.CurrentWindow(serverTime);
            if (current is not null)
            {
                var end = local.Date.AddMinutes(current.End);
                var remaining = Math.Max(1, (int)Math.Ceiling((end - local.DateTime).TotalMinutes));
                title = "早读时段";
                detail = $"{current.TimeLabel} · 距结束 {remaining} 分钟，本时段朗读计入班级记录。";
            }
            else if (!schedule.Enabled)
            {
                title = "早读计分未启用";
                detail = "可打开早读活动自由练习。";
            }
            else
            {
                title = "早读待开始";
                detail = NextPeriod(schedule, local) ?? "本班暂未设置早读时段，可打开活动自由练习。";
            }
            if (snapshot["online"]?.GetValue<bool>() != true) detail += " 当前使用本机设置。";
        }
        var status = readingOpen && !revoked ? "早读已打开" : title;
        if (_notice is not null) status = $"{_notice.Sender} · {_notice.Text}";
        var notice = _notice is null ? null : _notice with { Progress = Math.Clamp(1 - _clock.GetElapsedTime(_receivedAt).TotalSeconds / _noticeDuration.TotalSeconds, 0, 1), AgeSeconds = _clock.GetElapsedTime(_receivedAt).TotalSeconds };
        return new(className, local.ToString("HH:mm", CultureInfo.InvariantCulture),
            $"{local:MM月dd日} {weekday}", status, title, detail, !revoked,
            connection.Connected && !revoked, revoked ? "绑定已失效" : connection.Text, notice);
    }

    private static string? NextPeriod(ReadingSchedule schedule, DateTimeOffset local)
    {
        var minute = local.Hour * 60 + local.Minute;
        for (var offset = 0; offset <= 7; offset++)
        {
            var day = local.AddDays(offset);
            var weekday = day.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)day.DayOfWeek;
            var next = schedule.Periods.Where(p => p.Weekdays.Contains(weekday) && p.Start >= 0 && p.End <= 1440 &&
                p.Start < p.End && (offset > 0 || p.Start > minute)).OrderBy(p => p.Start).FirstOrDefault();
            if (next is null) continue;
            var label = offset == 0 ? "今天" : offset == 1 ? "明天" : day.ToString("M月d日", CultureInfo.InvariantCulture);
            return $"下次早读：{label} {next.Start / 60:00}:{next.Start % 60:00}，也可提前打开活动。";
        }
        return null;
    }
}

internal sealed record ClassroomIslandPreferences(bool Enabled = true, bool Dimmed = false);

internal sealed class ClassroomIslandPreferencesStore(string path)
{
    internal static string PathFor(ReceiverConfig config) => Path.Combine(ReceiverConfig.IsPreview(config)
        ? AppContext.BaseDirectory
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver"),
        "island-settings.json");

    public ClassroomIslandPreferences Load()
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<ClassroomIslandPreferences>(File.ReadAllText(path)) ?? new() : new(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        { AppLog.Error("Read classroom island preferences failed", error); return new(); }
    }

    public void Save(ClassroomIslandPreferences preferences)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(preferences));
            File.Move(path + ".tmp", path, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { AppLog.Error("Save classroom island preferences failed", error); }
    }
}

using System.Globalization;

namespace ICeClass.Receiver;

internal sealed record ReadingPeriod(int[] Weekdays, int Start, int End);
internal sealed record ReadingWindow(string Day, int Start, int End, string ClassId, string ClassName)
{
    private static string Clock(int minute) => minute == 1440 ? "24:00" : $"{minute / 60:00}:{minute % 60:00}";
    public string TimeLabel => $"{Clock(Start)}–{Clock(End)}";
}

internal sealed class ReadingSchedule
{
    public bool Enabled { get; init; }
    public bool ReminderEnabled { get; init; } = true;
    public ReadingPeriod[] Periods { get; init; } = [];
    public long ServerTime { get; init; }
    public string ClassId { get; init; } = "";
    public string ClassName { get; init; } = "";

    // The server clock and a fixed UTC+8 offset avoid depending on the whiteboard's time zone.
    public ReadingWindow? CurrentWindow(long serverTime)
    {
        if (!Enabled || !ReminderEnabled || string.IsNullOrWhiteSpace(ClassId)) return null;
        var local = DateTimeOffset.FromUnixTimeMilliseconds(serverTime).ToOffset(TimeSpan.FromHours(8));
        var weekday = local.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)local.DayOfWeek;
        var minute = local.Hour * 60 + local.Minute;
        var periods = Periods.Where(p => p.Weekdays.Contains(weekday) && p.Start >= 0 && p.Start < p.End && p.End <= 1440).OrderBy(p => p.Start);
        int start = -1, end = -1;
        foreach (var period in periods)
        {
            if (start >= 0 && period.Start > end)
            {
                if (minute >= start && minute < end) break;
                start = -1;
            }
            if (start < 0) { start = period.Start; end = period.End; }
            else end = Math.Max(end, period.End);
        }
        return start >= 0 && minute >= start && minute < end
            ? new ReadingWindow(local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), start, end, ClassId, ClassName) : null;
    }
}

internal sealed record ReadingReminderEntry(string Scope, string Day, int Start, int End);

internal sealed class ReadingReminderHistory
{
    private readonly string _path;
    private List<ReadingReminderEntry> _entries = [];

    public ReadingReminderHistory(string path)
    {
        _path = path;
        try { if (File.Exists(path)) _entries = System.Text.Json.JsonSerializer.Deserialize<List<ReadingReminderEntry>>(File.ReadAllText(path)) ?? []; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException) { }
    }

    public bool WasShown(string scope, ReadingWindow window) => _entries.Any(e => e.Scope == scope && e.Day == window.Day && e.Start < window.End && window.Start < e.End);

    public void Remember(string scope, ReadingWindow window)
    {
        if (WasShown(scope, window)) return;
        _entries.Add(new(scope, window.Day, window.Start, window.End));
        var cutoff = DateOnly.ParseExact(window.Day, "yyyy-MM-dd", CultureInfo.InvariantCulture).AddDays(-14).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        _entries.RemoveAll(e => string.CompareOrdinal(e.Day, cutoff) < 0);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path + ".tmp", System.Text.Json.JsonSerializer.Serialize(_entries));
            File.Move(_path + ".tmp", _path, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { AppLog.Error("Save reading reminder history failed", error); }
    }
}

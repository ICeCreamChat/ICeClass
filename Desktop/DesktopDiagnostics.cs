using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace ICeClass.Desktop;

internal sealed record DiagnosticEntry(DateTimeOffset At, string Area, string Event,
    string Page, string Detail, double? Milliseconds, int? Status);

/// <summary>Bounded, local activity journal. Disk work never runs on the UI thread.</summary>
internal sealed class DesktopDiagnostics : IDisposable
{
    internal const int MaximumFileBytes = 4 * 1024 * 1024;
    internal const int AttachmentBytes = 512 * 1024;
    private const string FileName = "desktop-activity.jsonl";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly Channel<Work> _pending = Channel.CreateBounded<Work>(new BoundedChannelOptions(256)
    { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly string _path;
    private readonly TimeProvider _clock;
    private readonly Task _writer;
    private string _storageError = "";
    private int _dropped;
    internal event Action<string>? ErrorRecorded;
    internal event Action? AuthenticationChanged;
    internal string StorageStatus => (Volatile.Read(ref _storageError) is { Length: > 0 } failure ? failure : "正常") +
        (Volatile.Read(ref _dropped) > 0 ? $"；繁忙时跳过 {_dropped} 条记录" : "");

    internal DesktopDiagnostics(string directory, TimeProvider? clock = null)
    {
        _path = Path.Combine(directory, FileName); _clock = clock ?? TimeProvider.System;
        _writer = Task.Run(WriteAsync);
    }

    internal void Record(string area, string action, string page = "", string detail = "", double? milliseconds = null, int? status = null)
    {
        var entry = new DiagnosticEntry(_clock.GetUtcNow(), Clean(area, 40), Clean(action, 100),
            FeedbackDiagnostics.Page(page), Clean(detail, 1200), milliseconds is >= 0 and <= 3600000 ? Math.Round(milliseconds.Value, 1) : null,
            status is >= 0 and <= 599 ? status : null);
        if (!_pending.Writer.TryWrite(new(entry, null))) Interlocked.Increment(ref _dropped);
        if (area == "request" && status is >= 200 and < 400 && Uri.TryCreate(page, UriKind.Absolute, out var address) &&
            address.AbsolutePath is "/api/auth/login" or "/api/auth/logout" or "/api/auth/password")
            AuthenticationChanged?.Invoke();
        if (area == "javascript" || area == "request" && (status == 0 || status >= 400) ||
            area == "navigation" && action == "加载失败" || area == "runtime" && action == "页面进程中断")
            ErrorRecorded?.Invoke(JsonSerializer.Serialize(entry, Json));
    }

    internal void RecordBrowser(string json, string endpoint)
    {
        if (json.Length > 4096) return;
        try
        {
            var value = JsonSerializer.Deserialize<BrowserEvent>(json, Json);
            if (value is not { Type: "iceclass-diagnostic" } ||
                value.Kind is not ("action" or "request" or "javascript" or "connection" or "performance")) return;
            if (!DesktopSettings.SameOrigin(endpoint, value.Url)) return;
            Record(value.Kind, value.Name ?? "", value.Url, value.Detail ?? "", value.Duration, value.Status);
        }
        catch (JsonException) { }
    }

    internal async Task FlushAsync(CancellationToken token)
    {
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await _pending.Writer.WriteAsync(new(null, ready), token);
        await ready.Task.WaitAsync(token);
    }

    private async Task WriteAsync()
    {
        var retainedAt = DateTimeOffset.MinValue;
        await foreach (var work in _pending.Reader.ReadAllAsync())
        {
            if (work.Ready is not null) { work.Ready.TrySetResult(); continue; }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var now = _clock.GetUtcNow();
                var line = JsonSerializer.Serialize(work.Entry, Json) + "\n";
                var file = new FileInfo(_path);
                var full = file.Exists && file.Length + Encoding.UTF8.GetByteCount(line) > MaximumFileBytes;
                if (now - retainedAt >= TimeSpan.FromHours(1) || full)
                { Retain(now, full ? MaximumFileBytes / 2 : MaximumFileBytes); retainedAt = now; }
                await File.AppendAllTextAsync(_path, line, new UTF8Encoding(false));
                Volatile.Write(ref _storageError, "");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { Volatile.Write(ref _storageError, "诊断记录写入失败：" + error.GetType().Name); }
        }
    }

    private void Retain(DateTimeOffset now, int maximum)
    {
        if (!File.Exists(_path)) return;
        var entries = ReadEntries(_path, now, MaximumFileBytes);
        var lines = new List<string>(); var bytes = 0;
        foreach (var entry in entries.AsEnumerable().Reverse())
        {
            var line = JsonSerializer.Serialize(entry, Json); var size = Encoding.UTF8.GetByteCount(line) + 1;
            if (bytes + size > maximum) break;
            lines.Add(line); bytes += size;
        }
        lines.Reverse();
        var temporary = _path + ".tmp";
        File.WriteAllLines(temporary, lines, new UTF8Encoding(false));
        File.Move(temporary, _path, overwrite: true);
    }

    internal static string ActivityReport(string directory, DateTimeOffset? at = null)
    {
        var now = at ?? DateTimeOffset.UtcNow;
        var text = new StringBuilder("【最近 24 小时】\n");
        text.AppendLine($"时间范围：{now.AddHours(-24):O} 至 {now:O}");
        text.AppendLine("仅记录操作名称、页面、请求状态和耗时；不记录输入内容或请求正文。重复成功查询会合并。");
        text.AppendLine("本机记录上限 4 MB，附件取最近 512 KB；繁忙时较早记录可能被裁剪。");
        try
        {
            var path = Path.Combine(directory, FileName);
            var entries = File.Exists(path) ? ReadEntries(path, now, AttachmentBytes) : [];
            if (entries.Count == 0)
            { text.AppendLine("尚无可用操作记录；新版本运行后开始记录，不能还原升级前的操作。"); return text.ToString(); }
            text.AppendLine($"已收录：{entries.Count} 条；最早 {entries[0].At:O}，最新 {entries[^1].At:O}");
            text.AppendLine($"请求失败：{entries.Count(e => e.Area == "request" && (e.Status == 0 || e.Status >= 400))}；慢请求（≥1秒）：{entries.Count(e => e.Area == "request" && e.Milliseconds >= 1000)}；脚本错误：{entries.Count(e => e.Area == "javascript")}");
            text.AppendLine("操作时间线：");
            foreach (var entry in entries)
            {
                text.Append($"[{entry.At:O}] {entry.Area} / {entry.Event}");
                if (entry.Page.Length > 0) text.Append(" | " + entry.Page);
                if (entry.Status is not null) text.Append(" | HTTP " + entry.Status);
                if (entry.Milliseconds is not null) text.Append(" | " + entry.Milliseconds.Value.ToString("0.#", CultureInfo.InvariantCulture) + " ms");
                if (entry.Detail.Length > 0) text.Append(" | " + entry.Detail);
                text.AppendLine();
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { text.AppendLine("操作记录暂时无法读取：" + error.GetType().Name); }
        return text.ToString();
    }

    private static List<DiagnosticEntry> ReadEntries(string path, DateTimeOffset now, int limit)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var partial = stream.Length > limit;
        if (partial) stream.Seek(-limit, SeekOrigin.End);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        if (partial) reader.ReadLine();
        var entries = new List<DiagnosticEntry>();
        while (reader.ReadLine() is { } line)
        {
            try
            {
                if (JsonSerializer.Deserialize<DiagnosticEntry>(line, Json) is { Area: not null, Event: not null, Page: not null, Detail: not null } entry &&
                    entry.At >= now.AddHours(-24) && entry.At <= now)
                    entries.Add(entry);
            }
            catch (JsonException) { }
        }
        return entries;
    }

    private static string Clean(string text, int maximum)
    {
        var value = FeedbackDiagnostics.Redact(text).Replace('\r', ' ').Replace('\n', ' ');
        value = Regex.Replace(value, @"https?://[^\s|]+", match => FeedbackDiagnostics.Page(match.Value));
        return value.Length > maximum ? value[..maximum] : value;
    }

    public void Dispose()
    {
        _pending.Writer.TryComplete();
        try { _writer.Wait(TimeSpan.FromSeconds(1)); } catch (AggregateException) { }
    }
    private sealed record Work(DiagnosticEntry? Entry, TaskCompletionSource? Ready);
    private sealed record BrowserEvent(string? Type, string? Kind, string? Name, string Url, string? Detail, double? Duration, int? Status);
}

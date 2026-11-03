using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace ICeClass.Diagnostics;

internal static class SupportDiagnostics
{
    internal const int MaximumReportBytes = 1024 * 1024;

    internal static string Redact(string text)
    {
        text = Regex.Replace(text, @"(?im)([""']?(?:Set-)?Cookie[""']?\s*[:=])[^\r\n]*", "$1 [已隐藏]");
        text = Regex.Replace(text, @"(?i)([""']?Authorization[""']?\s*[:=]\s*[""']?)(?:Bearer|Basic)\s+[^\s""']+", "$1[已隐藏]");
        text = Regex.Replace(text, @"(?i)([""']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?token|csrf(?:[_-]?token)?|iceclass_session|token|secret)[""']?\s*[:=]\s*)(""[^""\r\n]*""|'[^'\r\n]*'|[^\s,;&\r\n]+)", "$1[已隐藏]");
        text = Regex.Replace(text, @"(?i)(https?://)[^/\s@]+@", "$1[已隐藏]@");
        text = Regex.Replace(text, @"\bsk-[A-Za-z0-9_-]{12,}\b", "[已隐藏]");
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(profile)) text = text.Replace(profile, "%USERPROFILE%", StringComparison.OrdinalIgnoreCase);
        return text;
    }

    internal static string ReadLogTail(string path, int maximumBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maximumBytes);
        if (!File.Exists(path)) return "尚无可用日志。";
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var truncated = stream.Length > maximumBytes;
        if (truncated) stream.Seek(-maximumBytes, SeekOrigin.End);
        var bytes = new byte[Math.Min(stream.Length, maximumBytes)];
        var length = 0;
        while (length < bytes.Length)
        {
            var count = stream.Read(bytes, length, bytes.Length - length);
            if (count == 0) break;
            length += count;
        }
        var content = Encoding.UTF8.GetString(bytes, 0, length);
        if (truncated)
        {
            var newline = content.IndexOf('\n');
            content = newline >= 0 ? content[(newline + 1)..] : "";
        }
        return Redact((truncated ? $"日志较大，仅附最近 {maximumBytes / 1024} KB。\n" : "") + content);
    }

    internal static async Task WriteArchiveAsync(Stream destination, string report, string releaseNotes, CancellationToken token)
    {
        report = Redact(report);
        if (Encoding.UTF8.GetByteCount(report) > MaximumReportBytes)
            throw new InvalidDataException("诊断日志超过 1 MB，请刷新后重试。");
        token.ThrowIfCancellationRequested();
        using var archive = new ZipArchive(destination, ZipArchiveMode.Create, leaveOpen: true, Encoding.UTF8);
        foreach (var (name, content) in new[] { ("诊断报告.txt", report), ("更新记录.txt", releaseNotes) })
        {
            await using var stream = archive.CreateEntry(name, CompressionLevel.Optimal).Open();
            await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            await writer.WriteAsync(content.AsMemory(), token);
        }
    }

    internal static async Task SaveArchiveAsync(string path, string report, string releaseNotes, CancellationToken token)
    {
        path = Path.GetFullPath(path);
        var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        token.ThrowIfCancellationRequested();
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                81920, FileOptions.Asynchronous))
            {
                await WriteArchiveAsync(stream, report, releaseNotes, token);
                await stream.FlushAsync(token);
            }
            token.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

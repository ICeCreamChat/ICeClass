using System.Text;
using ICeClass.Diagnostics;

namespace ICeClass.Receiver;

internal static class AppLog
{
    private const long MaxBytes = 1_000_000;
    private static readonly object Sync = new();
    private static readonly string LogDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ICeClass",
        "logs");
    private static readonly string LogPath = Path.Combine(LogDirectory, "receiver.log");
    private static string _storageStatus = "正常";
    internal static string StorageStatus => Volatile.Read(ref _storageStatus);
    internal static event Action<string>? ErrorRecorded;

    public static void Info(string message) => Write("INFO", message);

    public static void Error(string message, Exception? exception = null)
    {
        var detail = exception is null ? message : $"{message}: {exception}";
        Write("ERROR", detail);
        ErrorRecorded?.Invoke(SupportDiagnostics.Redact(detail));
    }

    private static void Write(string level, string message)
    {
        try
        {
            lock (Sync)
            {
                Directory.CreateDirectory(LogDirectory);
                RotateIfNeeded();
                var safeMessage = SupportDiagnostics.Redact(message).Replace('\r', ' ').Replace('\n', ' ');
                File.AppendAllText(LogPath, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} [{level}] {safeMessage}{Environment.NewLine}", Encoding.UTF8);
                Volatile.Write(ref _storageStatus, "正常");
            }
        }
        catch (Exception error)
        {
            Volatile.Write(ref _storageStatus, "写入失败：" + error.GetType().Name);
            // Logging must never prevent the receiver from showing a message.
        }
    }

    internal static string ReadRecent()
    {
        lock (Sync)
        {
            var text = new StringBuilder();
            foreach (var (path, size) in new[] { (LogPath + ".1", 128 * 1024), (LogPath, 256 * 1024) })
            {
                if (path.EndsWith(".1", StringComparison.Ordinal) && !File.Exists(path)) continue;
                try { text.AppendLine(SupportDiagnostics.ReadLogTail(path, size)); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { text.AppendLine("本机日志暂时无法读取：" + error.GetType().Name); }
            }
            return text.ToString();
        }
    }

    private static void RotateIfNeeded()
    {
        if (!File.Exists(LogPath) || new FileInfo(LogPath).Length < MaxBytes) return;
        var previous = LogPath + ".1";
        File.Move(LogPath, previous, true);
    }
}

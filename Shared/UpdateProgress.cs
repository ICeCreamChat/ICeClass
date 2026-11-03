using System.Diagnostics;
using System.Globalization;

namespace ICeClass.Updates;

public enum UpdateStage { Checking, Preparing, Downloading, Verifying }

public sealed record UpdateProgress(UpdateStage Stage, long DownloadedBytes = 0, long TotalBytes = 0)
{
    public int Percentage => TotalBytes > 0 ? (int)Math.Clamp(DownloadedBytes * 100 / TotalBytes, 0, 100) : 0;
    public bool IsIndeterminate => Stage != UpdateStage.Downloading || TotalBytes <= 0;
    public string Message => Stage switch
    {
        UpdateStage.Checking => "正在检查更新…",
        UpdateStage.Preparing => "正在检查并复用本机资源…",
        UpdateStage.Downloading => $"正在下载更新 {Percentage}%",
        _ => "正在校验更新…"
    };
    public string Detail => TotalBytes > 0
        ? $"已下载 {Megabytes(DownloadedBytes)} / {Megabytes(TotalBytes)} MB" : "";
    private static string Megabytes(long bytes) => (bytes / 1048576d).ToString("0.0", CultureInfo.CurrentCulture);
}

internal sealed class UpdateTransferProgress(IProgress<UpdateProgress>? progress, long totalBytes) : IDisposable
{
    private long _lastBytes = -1, _latestBytes = -1, _lastReported;

    internal void Report(long downloadedBytes, bool force = false)
    {
        if (progress is null) return;
        _latestBytes = downloadedBytes = Math.Clamp(downloadedBytes, 0, totalBytes);
        if (downloadedBytes == _lastBytes) return;
        var now = Stopwatch.GetTimestamp();
        // Keep the first received bytes and completion immediate, without flooding the UI on fast links.
        if (!force && downloadedBytes > _lastBytes && _lastBytes > 0 && downloadedBytes < totalBytes &&
            _lastBytes * 100 / totalBytes > 0 &&
            Stopwatch.GetElapsedTime(_lastReported, now) < TimeSpan.FromMilliseconds(200)) return;
        _lastBytes = downloadedBytes; _lastReported = now;
        progress.Report(new(UpdateStage.Downloading, downloadedBytes, totalBytes));
    }

    // A pause or network failure can occur before the next throttled UI refresh.
    public void Dispose() { if (_latestBytes >= 0) Report(_latestBytes, force: true); }
}

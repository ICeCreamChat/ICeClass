namespace ICeClass.Updates;

internal sealed record VoicePreparationState(string Message, bool Busy = false, bool Ready = false, UpdateProgress? Progress = null);

/// <summary>One cancellable resource transfer, shared by the automatic scheduler and the manual button.</summary>
internal sealed class VoicePreparation(VoiceResources resources, Func<Uri> origin,
    Func<bool, CancellationToken, Task<bool>> allowed) : IDisposable
{
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _active;
    private bool _attempting, _manualRequested, _pausedByUser;
    private DateTimeOffset _retryAfter;
    private UpdateProgress? _lastProgress;
    private Task? _runner;
    internal VoicePreparationState Current { get; private set; } = new("正在检查语音资源…");
    internal bool IsDownloading => _active is not null;
    internal event Action<VoicePreparationState>? Changed;
    internal event Action<Exception>? Failed;

    internal void Start()
    {
        if (!_lifetime.IsCancellationRequested) _runner ??= RunAsync();
    }
    private async Task RunAsync()
    {
        try
        {
            var ready = await Task.Run(() => resources.IsReadyAsync(_lifetime.Token));
            if (!IsDownloading) Publish(ready ? "语音资源已就绪" : "语音资源待准备，课间空闲时自动下载", ready: ready);
            await Task.Delay(TimeSpan.FromSeconds(Random.Shared.Next(15, 91)), _lifetime.Token);
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
            do
            {
                if (!resources.Ready && !_pausedByUser && DateTimeOffset.UtcNow >= _retryAfter) await AttemptAsync();
            }
            while (await timer.WaitForNextTickAsync(_lifetime.Token));
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error) { Failed?.Invoke(error); Publish("语音资源检查未完成，请点击下载重试"); }
    }

    internal Task DownloadAsync()
    {
        if (resources.Ready) { Publish("语音资源已就绪", ready: true); return Task.CompletedTask; }
        if (IsDownloading)
        {
            _pausedByUser = true; _active?.Cancel();
            return Task.CompletedTask;
        }
        _pausedByUser = false; _manualRequested = true; _retryAfter = DateTimeOffset.MinValue;
        return AttemptAsync();
    }

    private async Task AttemptAsync()
    {
        if (_attempting || _lifetime.IsCancellationRequested) return;
        _attempting = true;
        try
        {
            if (!await allowed(!_manualRequested, _lifetime.Token))
            {
                Publish(_manualRequested ? "正在使用语音或活动，结束后继续下载" : "等待课间空闲，或点击手动下载");
                return;
            }
            using var download = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
            _active = download;
            Publish("正在检查并复用本机语音资源…", busy: true);
            var monitor = MonitorAsync(download);
            var progress = new Progress<UpdateProgress>(value =>
            {
                if (!ReferenceEquals(_active, download) || download.IsCancellationRequested) return;
                _lastProgress = value;
                Publish(value.Stage == UpdateStage.Downloading ? $"正在下载语音资源 {value.Percentage}%"
                    : value.Stage == UpdateStage.Verifying ? "正在校验语音资源…" : "正在检查并复用本机语音资源…", busy: true);
            });
            try
            {
                var downloadOrigin = origin();
                await Task.Run(() => resources.PrepareAsync(downloadOrigin, VoiceResources.Client, progress, download.Token));
                _active = null; _manualRequested = false;
                Publish("语音资源已就绪", ready: true);
            }
            catch (OperationCanceledException) when (download.IsCancellationRequested)
            {
                _active = null;
                if (!_lifetime.IsCancellationRequested) Publish(_pausedByUser ? "下载已暂停，可继续下载" : "下载已暂停，空闲后继续");
            }
            catch (Exception error)
            {
                _active = null; _retryAfter = DateTimeOffset.UtcNow.AddMinutes(5);
                Failed?.Invoke(error); Publish("语音资源下载未完成，请检查网络后重试");
            }
            finally { _active = null; download.Cancel(); await monitor; }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error) { Failed?.Invoke(error); _retryAfter = DateTimeOffset.UtcNow.AddMinutes(5); Publish("暂时无法准备语音资源，请重试"); }
        finally { _attempting = false; }
    }
    private async Task MonitorAsync(CancellationTokenSource download)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            while (await timer.WaitForNextTickAsync(download.Token))
                if (!await allowed(!_manualRequested, download.Token)) { download.Cancel(); return; }
        }
        catch (OperationCanceledException) when (download.IsCancellationRequested) { }
        catch (Exception error) { Failed?.Invoke(error); download.Cancel(); }
    }
    private void Publish(string text, bool busy = false, bool ready = false)
    {
        if (resources.SpeechReady && !resources.Ready) text = "播报已就绪 · " + text;
        Current = new(text, busy, ready, _lastProgress); Changed?.Invoke(Current);
    }
    public void Dispose() { _lifetime.Cancel(); _active?.Cancel(); }
}

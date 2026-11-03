using ICeClass.Updates;

namespace ICeClass.Desktop;

internal sealed partial class DesktopWindow
{
    private VoicePreparation? _voicePreparation;
    private DesktopUpdateActivity? _voiceActivity;
    private DateTimeOffset _voiceActivityChecked;

    private bool VoiceActivityBusy => _disposed || _recordingFrames.Count > 0 || _pickingFile || _openingFeedback
        || _pageDownloads.Count > 0 || _browser.Core?.IsDocumentPlayingAudio == true || _voiceNotice?.IsBusy == true
        || _updateDownload is not null || _children.Any(child => child.VoiceActivityBusy);

    private async Task<bool> CanDownloadVoiceAsync(bool automatic, CancellationToken token)
    {
        if (VoiceActivityBusy) return false;
        if (!automatic) return true;
        if (!_navigated || _app.UpdateBusy(true)) return false;
        if (_voiceActivity is null || DateTimeOffset.UtcNow - _voiceActivityChecked >= TimeSpan.FromSeconds(10))
        {
            _voiceActivity = await ReadUpdateActivityAsync(token);
            _voiceActivityChecked = DateTimeOffset.UtcNow;
        }
        return _voiceActivity.AllowsDownload;
    }

    private void InitializeVoiceResources()
    {
        var preparation = _voicePreparation = new VoicePreparation(ClassroomVoiceTranscriber.Resources,
            () => new Uri(_endpoint.TrimEnd('/') + "/"), CanDownloadVoiceAsync);
        preparation.Failed += DesktopLog.Write;
    }

    internal SettingsWindow CreateSettingsWindow(DesktopSettings current) => new(current, _voicePreparation!);

    private void StartVoiceDownload() => _app.RequestVoiceDownload();

    internal bool DownloadVoiceResources()
    {
        if (_disposed || _voicePreparation is null) return false;
        if (!_voicePreparation.IsDownloading) _ = _voicePreparation.DownloadAsync();
        return true;
    }
}

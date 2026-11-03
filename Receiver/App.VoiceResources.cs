using ICeClass.Updates;

namespace ICeClass.Receiver;

public sealed partial class App
{
    private VoicePreparation? _voicePreparation;
    private bool CanDownloadVoice(bool automatic) => !VoiceActivityBusy && _updateInProgress == 0
        && (!automatic || _island?.ScheduleKnown == true && _island.InClass == false);

    private string VoiceEndpoint => ReceiverConfig.TryLoad(out var config) ? config.Endpoint
        : _enrollmentWindow?.ResourceEndpoint ?? ReceiverConfig.TryLoadDefaultEndpoint() ?? ReceiverConfig.DefaultEndpoint;

    private void InitializeVoiceResources()
    {
        _voicePreparation?.Dispose();
        var preparation = new VoicePreparation(VoiceResourceFiles.Resources, () => new Uri(VoiceEndpoint.TrimEnd('/') + "/"),
            (automatic, _) => Task.FromResult(CanDownloadVoice(automatic)));
        _voicePreparation = preparation;
        preparation.Changed += state =>
        {
            if (ReferenceEquals(_voicePreparation, preparation)) _enrollmentWindow?.SetVoiceResourceState(state);
        };
        preparation.Failed += error => AppLog.Error("Voice resource preparation failed", error);
        preparation.Start();
    }
    private void ConnectVoiceResourcesView()
    {
        if (_enrollmentWindow is null) return;
        if (_voicePreparation is not null) _enrollmentWindow.SetVoiceResourceState(_voicePreparation.Current);
        _enrollmentWindow.VoiceDownloadRequested += async () => { if (_voicePreparation is not null) await _voicePreparation.DownloadAsync(); };
    }
}

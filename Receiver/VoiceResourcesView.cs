using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using ICeClass.Updates;

namespace ICeClass.Receiver;

internal sealed class VoiceResourcesView : Grid
{
    private readonly UpdateProgressView _progress = new("语音资源下载进度");
    private readonly Button _download = DesktopStyle.Button("下载语音资源", true);
    internal event Action? DownloadRequested;

    internal VoiceResourcesView()
    {
        ColumnDefinitions = new("*,Auto"); RowDefinitions = new("Auto,Auto");
        _progress.VerticalAlignment = VerticalAlignment.Center;
        _download.MinHeight = 36; _download.Padding = new Thickness(12, 6); _download.FontSize = 13;
        _download.VerticalAlignment = VerticalAlignment.Center; _download.HorizontalAlignment = HorizontalAlignment.Left;
        SetColumn(_download, 1); Children.Add(_progress); Children.Add(_download);
        _download.Click += (_, _) => DownloadRequested?.Invoke();
        SizeChanged += (_, _) => ArrangeDownload();
        SetState(new("正在检查语音资源…"));
    }
    internal void SetState(VoicePreparationState state)
    {
        _progress.SetState(state.Message, state.Busy, state.Ready, state.Progress);
        _download.Content = state.Busy ? "暂停下载" : state.Progress is not null && !state.Ready ? "继续下载" : "下载语音资源";
        _download.IsVisible = !state.Ready;
        AutomationProperties.SetName(_download, _download.Content?.ToString());
        ArrangeDownload();
    }
    private void ArrangeDownload()
    {
        var narrow = Bounds.Width < 540;
        SetRow(_download, narrow ? 1 : 0); SetColumn(_download, narrow ? 0 : 1);
        _download.Margin = narrow ? new Thickness(0, 10, 0, 0) : new Thickness(16, 0, 0, 0);
        SetColumnSpan(_progress, narrow || !_download.IsVisible ? 2 : 1);
    }
}

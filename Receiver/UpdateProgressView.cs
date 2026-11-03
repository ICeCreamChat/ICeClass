using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using ICeClass.Updates;

namespace ICeClass.Receiver;

internal sealed class UpdateProgressView : StackPanel
{
    private readonly TextBlock _status = DesktopStyle.Text("", 13, muted: true);
    private readonly TextBlock _detail = DesktopStyle.Text("", 12, muted: true);
    private readonly ProgressBar _progress = new()
    {
        Minimum = 0, Maximum = 100, Height = 6, IsVisible = false,
        Foreground = DesktopStyle.Blue, Background = DesktopStyle.Brush("#E5F0FF"),
        HorizontalAlignment = HorizontalAlignment.Stretch
    };

    internal UpdateProgressView(string accessibleName = "客户端更新下载进度")
    {
        Spacing = 5;
        _detail.IsVisible = false;
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);
        AutomationProperties.SetName(_progress, accessibleName);
        Children.Add(_status); Children.Add(_progress); Children.Add(_detail);
    }

    internal void SetState(string text, bool busy, bool ready = false, UpdateProgress? progress = null)
    {
        _status.Text = text;
        _progress.IsVisible = busy || ready || progress?.TotalBytes > 0;
        _progress.IsIndeterminate = busy && (progress?.IsIndeterminate ?? true) && DesktopStyle.AnimationsEnabled();
        _progress.Value = ready ? 100 : progress?.Percentage ?? 0;
        _detail.Text = progress?.Detail ?? "";
        _detail.IsVisible = !string.IsNullOrWhiteSpace(_detail.Text);
        AutomationProperties.SetHelpText(_progress, text + " " + _detail.Text);
    }
}

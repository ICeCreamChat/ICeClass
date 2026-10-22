using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;

namespace ICeClass.Receiver;

internal sealed class IslandShoutPreviewWindow : Window
{
    private readonly Func<string, bool, Task> _preview;
    private readonly CheckBox _sound = new() { Content = "播放演示声音（普通提醒仍静音）" };
    private readonly Action _cancel;
    private readonly TextBlock _status = ClassroomStyle.Caption("选择一种喊话，观察屏幕上的变化。");
    private CancellationTokenSource? _playback;
    public IslandShoutPreviewWindow(Func<string, bool, Task> preview, Action cancel)
    {
        _preview = preview; _cancel = cancel;
        ClassroomStyle.Apply(this); Title = "三种喊话演示 · ICeClass 班伴";
        Width = 570; MinWidth = 380; SizeToContent = SizeToContent.Height; CanResize = false;
        Background = DesktopStyle.Brush("#F6F9FD"); DesktopStyle.KeepWindowInWorkingArea(this);
        var body = new StackPanel { Spacing = 12, Margin = new(24) };
        body.Children.Add(ClassroomStyle.SectionTitle("班班来传话"));
        body.Children.Add(ClassroomStyle.Caption("仅在这台电脑演示；真实通知会优先展示。"));
        foreach (var (level, title, detail) in new[] {
            ("info", "普通 · 冰蓝细条", "班班在侧边招手，正文在细岛里轮播"),
            ("warning", "重要 · 浅黄拉开", "班班迈腿小跑拉开岛条，长内容展开成两行"),
            ("urgent", "紧急 · 喇叭喊话", "正文立即显示；班班握喇叭小跑，拉开后举起喊话") })
        {
            var button = ClassroomStyle.Button(""); button.HorizontalContentAlignment = HorizontalAlignment.Stretch; button.MinHeight = 68;
            button.Content = new StackPanel { Spacing = 4, Children = { ClassroomStyle.Text(title, 15, true), ClassroomStyle.Caption(detail) } };
            AutomationProperties.SetName(button, title + "，" + detail);
            button.Click += async (_, _) => { Stop(); await Play(level); }; body.Children.Add(button);
        }
        body.Children.Add(_sound); body.Children.Add(_status);
        var playAll = ClassroomStyle.Button("连播三种", true); playAll.Click += async (_, _) => await PlayAll();
        var stop = ClassroomStyle.Button("结束演示"); stop.Click += (_, _) => Stop();
        body.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Children = { playAll, stop } });
        Content = body; Closed += (_, _) => Stop();
        KeyDown += (_, e) => { if (e.Key == Key.Escape) { Stop(); e.Handled = true; } };
        Opened += (_, _) =>
        {
            var screen = Screens.Primary; if (screen is null) return;
            Position = new PixelPoint(screen.WorkingArea.X + 24, Math.Max(screen.WorkingArea.Y + 100,
                screen.WorkingArea.Bottom - (int)((Bounds.Height + 24) * screen.Scaling)));
        };
    }
    public async Task Play(string level)
    {
        try { await _preview(level, _sound.IsChecked == true); _status.Text = "请看屏幕顶部；点击岛条看全文，“已知晓”确认，Esc 仅收起。"; }
        catch (OperationCanceledException) { }
        catch (Exception error) { _status.Text = error.Message; }
    }
    private async Task PlayAll()
    {
        Stop(); var playback = _playback = new();
        try
        {
            foreach (var (level, duration) in new[] { ("info", 8), ("warning", 12), ("urgent", 16) })
            {
                _cancel(); await Play(level).WaitAsync(playback.Token);
                await Task.Delay(TimeSpan.FromSeconds(duration), playback.Token);
            }
            Stop(); _status.Text = "演示结束，已恢复课堂。";
        }
        catch (OperationCanceledException) { }
    }
    private void Stop() { _playback?.Cancel(); _playback?.Dispose(); _playback = null; _cancel(); _status.Text = "演示已停止，可以重新选择一种喊话。"; }
}

using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

internal sealed class SelfStudyNoticeWindow : Window
{
    private readonly SelfStudyInbox _inbox;
    private readonly Window _anchor;
    private readonly TextBlock _description = DesktopStyle.Text("", 15);
    internal SelfStudyNoticeWindow(SelfStudyInbox inbox, Window anchor, Action open)
    {
        _inbox = inbox; _anchor = anchor;
        Title = "班伴 · 晚自习提醒"; Width = 400; SizeToContent = SizeToContent.Height;
        CanResize = false; SystemDecorations = SystemDecorations.None; ShowInTaskbar = false; ShowActivated = false;
        Topmost = true; Background = Brushes.Transparent; TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        TeacherStyle.Apply(this, floating: true);
        _description.TextWrapping = TextWrapping.Wrap; _description.LineHeight = 25;
        AutomationProperties.SetLiveSetting(_description, AutomationLiveSetting.Polite);
        var later = Dialogs.Button("稍后查看"); later.Click += (_, _) => Close();
        var view = Dialogs.Button("查看晚自习", true); view.Click += (_, _) => { Close(); open(); };
        Content = new Border { Classes = { "native-flyout-surface" }, Margin = new Thickness(16),
            Child = ClassroomGlassHost.Wrap(new Border { Padding = new Thickness(22), Child = new StackPanel {
                Spacing = 14, Children = { DesktopStyle.Text("晚自习需要留意", 18, true), _description,
                    new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Children = { later, view } } }
            } }, 23, teacher: true) };
        Opened += (_, _) => Place();
        SizeChanged += (_, _) => { if (IsVisible) Place(); };
        KeyDown += (_, e) => { if (e.Key == Key.Escape) { e.Handled = true; Close(); } };
        Closed += (_, _) => _inbox.Dismiss();
        Update();
    }
    internal void Update()
    {
        if (_inbox.Pending.Count == 0) { if (IsVisible) Close(); return; }
        var names = string.Join("、", _inbox.Pending.Select(e => e.ClassName).Distinct().Take(3));
        _description.Text = $"{names}在提醒后仍有疑似交谈，共 {_inbox.Pending.Count} 条记录待核实。";
    }
    private void Place()
    {
        var screen = Screens.ScreenFromWindow(_anchor) ?? Screens.Primary;
        if (screen is null) return;
        var area = screen.WorkingArea; var scale = screen.Scaling;
        Width = Math.Min(400, area.Width / scale);
        MaxHeight = area.Height / scale;
        Position = new PixelPoint(area.Right - (int)(Bounds.Width * scale) - 8, area.Y + 12);
    }
}

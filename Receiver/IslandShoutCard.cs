using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

// Optional full text, attached directly to the same island surface. Normal
// arrival stays in the 48 DIP ribbon; this area opens only on an explicit click.
internal sealed class IslandShoutCard : Border, IDisposable
{
    private readonly TextBlock _body = Text("", 20);
    private readonly TextBlock _scope = Text("", 14);
    private readonly TextBlock _remaining = Text("", 14);
    private readonly ScrollViewer _scroll;
    private long _sequence = -1;
    internal Button DismissButton { get; }

    public IslandShoutCard(Action dismiss)
    {
        _body.TextWrapping = TextWrapping.Wrap; _body.LineHeight = 32;
        _body.Margin = new Thickness(0, 0, 8, 4);
        _scroll = new ScrollViewer { Content = _body, MaxHeight = 240, Focusable = true,
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto };
        AutomationProperties.SetName(_scroll, "喊话完整内容，可滚动查看");
        DismissButton = DesktopStyle.Button("已知晓");
        DismissButton.Classes.Add("island-button"); DismissButton.Classes.Add("island-quiet");
        DismissButton.MinHeight = 36; DismissButton.Padding = new Thickness(12, 6);
        DismissButton.Click += (_, _) => dismiss();
        ToolTip.SetTip(DismissButton, "向老师确认已知晓，并停止声音；Esc 仅收起。");
        _scope.VerticalAlignment = _remaining.VerticalAlignment = VerticalAlignment.Center;
        _scope.TextTrimming = TextTrimming.CharacterEllipsis; _scope.Margin = new Thickness(0, 0, 8, 0);
        _remaining.Margin = new Thickness(0, 0, 12, 0);
        var footer = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto"), Margin = new Thickness(0, 12, 0, 0) };
        footer.Children.Add(_scope); Grid.SetColumn(_remaining, 1); footer.Children.Add(_remaining);
        Grid.SetColumn(DismissButton, 2); footer.Children.Add(DismissButton);
        Child = new StackPanel { Children = { _scroll, footer } };
        Padding = new Thickness(20, 16, 20, 16); BorderThickness = new Thickness(0, 1, 0, 0);
    }

    public void Update(ClassroomIslandNotice notice, string className)
    {
        if (_sequence != notice.Sequence)
        {
            _sequence = notice.Sequence; _scroll.Offset = default; _body.Text = notice.Text;
            AutomationProperties.SetName(this, $"班班传话全文，{notice.Sender}，{notice.Text}");
        }
        _scope.Text = className;
        ToolTip.SetTip(_scope, className);
        var seconds = Math.Max(0, (int)Math.Ceiling(notice.DurationSeconds - notice.AgeSeconds));
        _remaining.Text = seconds > 0 ? $"{seconds} 秒后收起" : "";
    }

    public void ApplyTheme(bool light)
    {
        Background = Brushes.Transparent;
        BorderBrush = Brush(light ? "#E1EAF3" : "#36475D");
        _body.Foreground = Brush(light ? "#29465F" : "#F1F6FC");
        _scope.Foreground = _remaining.Foreground = Brush(light ? "#455D7B" : "#C4D1E3");
    }
    public void SetAvailableHeight(double height) => _scroll.MaxHeight = Math.Clamp(height - 110, 32, 240);
    private static IBrush Brush(string value) => new SolidColorBrush(Color.Parse(value));
    private static TextBlock Text(string value, double size) => new()
    { Text = value, FontFamily = ClassroomStyle.Font, FontSize = size, FontWeight = FontWeight.Bold };
    public void Dispose() { }
}

using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.TextFormatting;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

/// <summary>A touch-paged text face for the 240 DIP classroom disc.</summary>
internal sealed class BanbanTextReader : Canvas
{
    private const double BodyWidth = 164, LineHeight = 20;
    private const int LinesPerPage = 5;
    private readonly TextBlock _title = Text("", 17, true), _body = Text("", 15), _counter = Text("", 13, muted: true);
    private readonly BanbanToolSector _previous, _back, _retry, _next;
    private readonly List<int> _starts = [0];
    private string _text = "";
    private int _page;

    internal event Action? BackRequested;
    internal event Action? RetryRequested;

    internal BanbanTextReader()
    {
        Width = Height = BanbanClassroomWheel.Diameter;
        IsVisible = false;
        _title.TextAlignment = TextAlignment.Center;
        _title.TextWrapping = TextWrapping.NoWrap;
        _title.TextTrimming = TextTrimming.CharacterEllipsis;
        _title.LineHeight = 23;
        _body.LineHeight = LineHeight;
        _body.MaxLines = LinesPerPage;
        _body.TextWrapping = TextWrapping.Wrap;
        _body.VerticalAlignment = VerticalAlignment.Center;
        _counter.FontSize = 13;
        _counter.LineHeight = 17;
        _counter.TextAlignment = TextAlignment.Center;
        AddBlock(_title, 136, 12);
        var bodyArea = new Grid { Height = LinesPerPage * LineHeight, Children = { _body } };
        AddBlock(bodyArea, BodyWidth, 38);
        AddBlock(_counter, 76, 153);
        var contrast = DesktopStyle.HighContrastEnabled();
        var accent = contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        BanbanToolSector Footer(string name, string caption, string icon, Action click)
        {
            var button = new BanbanToolSector(name, contrast, accent, BanbanToolSector.Band.Footer);
            button.SetFace(name, caption, icon);
            button.Click += (_, _) => click();
            Children.Add(button);
            return button;
        }
        _previous = Footer("上一页", "上页", "arrow-left", () => Turn(-1));
        _back = Footer("返回", "返回", "arrow-left", () => BackRequested?.Invoke());
        _retry = Footer("重试", "重试", "rotate-ccw", () => RetryRequested?.Invoke());
        _next = Footer("下一页", "下页", "arrow-right", () => Turn(1));
        _back.IsVisible = true;
        AutomationProperties.SetLiveSetting(_body, AutomationLiveSetting.Polite);
        KeyDown += Navigate;
    }

    private void AddBlock(Control control, double width, double top)
    {
        control.Width = width;
        SetLeft(control, (Width - width) / 2);
        SetTop(control, top);
        Children.Add(control);
    }

    internal void Open(string title, string text, string backLabel = "返回")
    {
        if (IsVisible && _title.Text == title && _text == text && AutomationProperties.GetName(_back) == backLabel) return;
        var hadFocus = IsKeyboardFocusWithin;
        // A growing voice reply can append text while the teacher is reading an earlier page.
        if (!IsVisible || _title.Text != title || !text.StartsWith(_text, StringComparison.Ordinal)) _page = 0;
        _title.Text = title;
        ToolTip.SetTip(_title, title);
        if (_text != text)
        {
            _text = text;
            _starts.Clear();
            _starts.Add(0);
            // Use the same shaping, wrap width and line height as the visible body.
            // Offsets stay in the original string, including line breaks and surrogate pairs.
            using var layout = new TextLayout(text, new Typeface(_body.FontFamily, _body.FontStyle, _body.FontWeight),
                _body.FontSize, _body.Foreground, textWrapping: TextWrapping.Wrap, maxWidth: BodyWidth, lineHeight: LineHeight);
            for (var index = LinesPerPage; index < layout.TextLines.Count; index += LinesPerPage)
            {
                var start = layout.TextLines[index].FirstTextSourceIndex;
                if (start < text.Length) _starts.Add(start);
            }
            _page = Math.Min(_page, _starts.Count - 1);
        }
        _back.SetFace(backLabel, backLabel.Length <= 3 ? backLabel : "返回", "arrow-left");
        IsVisible = true;
        ShowPage();
        if (hadFocus && !IsKeyboardFocusWithin) FocusFirst();
    }

    internal void FocusFirst() => _back.Focus();

    internal void SetRetry(string? name, bool enabled)
    {
        var visible = name != null;
        if (visible) _retry.SetFace(name!, name == "重读记录" ? "重读" : "重试", "rotate-ccw");
        _retry.IsEnabled = enabled;
        if (_retry.IsVisible == visible) return;
        _retry.IsVisible = visible;
        if (IsVisible) ShowPage();
    }

    private void Turn(int delta)
    {
        var page = Math.Clamp(_page + delta, 0, _starts.Count - 1);
        if (_page == page) return;
        var wasPrevious = _previous.IsFocused;
        var wasNext = _next.IsFocused;
        _page = page;
        ShowPage();
        if (wasPrevious && !_previous.IsEnabled) _next.Focus();
        if (wasNext && !_next.IsEnabled) _previous.Focus();
    }

    private void ShowPage()
    {
        var paged = _starts.Count > 1;
        var end = _page + 1 < _starts.Count ? _starts[_page + 1] : _text.Length;
        _body.Text = _text[_starts[_page]..end];
        _body.TextAlignment = paged ? TextAlignment.Left : TextAlignment.Center;
        _counter.IsVisible = _previous.IsVisible = _next.IsVisible = paged;
        _counter.Text = $"{_page + 1} / {_starts.Count}";
        var count = (paged ? 3 : 1) + (_retry.IsVisible ? 1 : 0);
        _back.Place(paged ? 1 : 0, count);
        if (_retry.IsVisible) _retry.Place(paged ? 2 : 1, count);
        if (paged) { _previous.Place(0, count); _next.Place(count - 1, count); }
        _previous.IsEnabled = _page > 0;
        _next.IsEnabled = _page + 1 < _starts.Count;
        AutomationProperties.SetHelpText(_back, $"{_title.Text}，第 {_page + 1} 页，共 {_starts.Count} 页。{_body.Text}");
    }

    private void Navigate(object? sender, KeyEventArgs e)
    {
        if (e.Handled) return;
        switch (e.Key)
        {
            case Key.PageUp: Turn(-1); break;
            case Key.PageDown: Turn(1); break;
            case Key.Home: Turn(-_page); break;
            case Key.End: Turn(_starts.Count - 1 - _page); break;
            case Key.Escape: BackRequested?.Invoke(); break;
            case Key.Left or Key.Right or Key.Up or Key.Down:
                Button[] buttons = [_previous, _back, _retry, _next];
                StepFocus(buttons, buttons.FirstOrDefault(b => b.IsFocused), e.Key);
                break;
            default: return;
        }
        e.Handled = true;
    }
}

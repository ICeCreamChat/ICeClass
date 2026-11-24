using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

internal sealed record CardQuizDiscItem(string Id, string Label, string Name, string Icon,
    bool Enabled = true, bool Selected = false, string? Mark = null);
internal sealed record CardQuizDiscPage(string Key, string Layout, string Title, CardQuizDiscItem[] Items,
    string? Value = null, string? Hint = null, string? FocusId = null);

/// <summary>The web document owns the lesson and draft. Its available actions use the same native sectors as the classroom.</summary>
internal sealed class BanbanClassroomDetail : Canvas
{
    private readonly Canvas _sectors = new();
    private readonly Button _hub = MakeButton("返回");
    private readonly TextBlock _title = Text("", 14, true), _value = Text("", 23, true), _hint = Text("", 12, muted: true);
    private readonly TextBlock _readerTitle = Text("", 15, true);
    private readonly bool _contrast = DesktopStyle.HighContrastEnabled();
    private readonly IBrush _accent;
    private readonly List<BanbanToolSector> _buttons = [];
    private readonly Dictionary<string, string> _lastAction = [];
    private CardQuizDiscPage? _page;
    internal bool Reading => _page?.Layout == "reader";
    internal Rect BrowserBounds { get; private set; } = PageBody;
    internal event Action<string, string>? ActionRequested;
    internal event Action<string>? BackRequested;

    internal BanbanClassroomDetail()
    {
        Width = Height = BanbanClassroomWheel.Diameter;
        _accent = _contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        IsVisible = false;
        RoundButton(_hub, 102);
        var center = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
        foreach (var label in new[] { _title, _value, _hint, _readerTitle })
        {
            label.TextAlignment = TextAlignment.Center;
            label.TextTrimming = TextTrimming.CharacterEllipsis;
            label.TextWrapping = TextWrapping.NoWrap;
        }
        _title.LineHeight = 18; _value.LineHeight = 28; _hint.LineHeight = 16;
        _value.Foreground = _accent;
        AutomationProperties.SetLiveSetting(_value, AutomationLiveSetting.Polite);
        center.Children.Add(_title); center.Children.Add(_value); center.Children.Add(_hint);
        var back = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3,
            HorizontalAlignment = HorizontalAlignment.Center, Children = { Glyph("arrow-right", 13, _accent, 180), Text("返回", 13, true) } };
        center.Children.Add(back);
        _hub.Content = center;
        _hub.Click += (_, _) => { if (_page is { } page) BackRequested?.Invoke(page.Key); };
        SetLeft(_hub,69); SetTop(_hub,69);
        _readerTitle.Width = 132;
        _readerTitle.LineHeight = 19;
        SetTop(_readerTitle,13); SetLeft(_readerTitle,54);
        Children.Add(_sectors); Children.Add(_hub); Children.Add(_readerTitle);
        KeyDown += (_, e) =>
        {
            if (e.Key is not (Key.Up or Key.Down or Key.Left or Key.Right or Key.Home or Key.End)) return;
            var controls = _buttons.Cast<Button>().Append(_hub);
            StepFocus(controls, controls.FirstOrDefault(b => b.IsKeyboardFocusWithin), e.Key);
            e.Handled = true;
        };
    }

    internal void Clear()
    {
        _page = null;
        BrowserBounds = PageBody;
        _lastAction.Clear();
        _buttons.Clear();
        _sectors.Children.Clear();
    }

    internal void Update(CardQuizDiscPage page)
    {
        var wasReading = Reading;
        var previous = _page;
        var focused = _buttons.FirstOrDefault(b => b.IsKeyboardFocusWithin)?.ActionId;
        _page = page;
        _hub.IsVisible = !Reading;
        _readerTitle.IsVisible = Reading;
        _readerTitle.Text = _title.Text = page.Title;
        _value.Text = page.Value; _value.IsVisible = !string.IsNullOrEmpty(page.Value);
        _value.FontSize = page.Value?.Length > 7 ? 14 : page.Value?.Length > 4 ? 18 : 23;
        _hint.Text = page.Hint; _hint.IsVisible = !string.IsNullOrEmpty(page.Hint);
        var description = string.Join(" · ", new[] {page.Title, page.Value, page.Hint}.Where(s => !string.IsNullOrEmpty(s)));
        AutomationProperties.SetHelpText(_hub, description);
        ToolTip.SetTip(_hub, description);
        var structureChanged = previous == null || wasReading != Reading ||
            !previous.Items.Select(a => a.Id).SequenceEqual(page.Items.Select(a => a.Id));
        if (structureChanged)
        {
            _sectors.Children.Clear(); _buttons.Clear();
            var ids = page.Items.Select(a => a.Id).ToList();
            if (Reading) ids.Insert(ids.Count == 2 ? 1 : 0, "back");
            var band = Reading ? BanbanToolSector.Band.ReaderFooter : BanbanToolSector.Band.Setup;
            for (int i = 0; i < ids.Count; i++)
            {
                var id = ids[i];
                var sector = new BanbanToolSector(id, _contrast, _accent, band) { IsVisible = true };
                sector.Place(i, ids.Count);
                sector.Click += (_, _) =>
                {
                    if (_page is not { } current) return;
                    if (id == "back") { BackRequested?.Invoke(current.Key); return; }
                    _lastAction[current.Key] = id;
                    ActionRequested?.Invoke(current.Key, id);
                };
                _buttons.Add(sector); _sectors.Children.Add(sector);
            }
            // The native web surface must end above every clickable arc, including its outer wings.
            BrowserBounds = Reading ? PageBody.WithHeight(Math.Min(PageBody.Height, _buttons.Min(GetTop) - 1 - PageBody.Y)) : PageBody;
        }
        foreach (var sector in _buttons)
        {
            if (sector.ActionId == "back") { sector.SetFace("返回", "返回", "arrow-left"); continue; }
            var item = page.Items.First(a => a.Id == sector.ActionId);
            sector.SetChoice(item.Name, item.Label, item.Icon, item.Mark, item.Selected);
            sector.IsEnabled = item.Enabled;
        }
        // 返回待同步列表时先显示禁用的扇面，待读取完成再恢复原记录焦点。
        var focusRestored = previous is { FocusId: null } && previous.Key == page.Key &&
            page.FocusId != null && _hub.IsKeyboardFocusWithin;
        if (IsVisible && Reading && focused != null && _buttons.Any(b => b.ActionId == focused && !b.IsEnabled))
            FocusPage("back");
        else if (IsVisible && focusRestored) FocusPage(page.FocusId);
        else if (IsVisible && (focused != null && structureChanged || previous?.Key != page.Key && !Reading))
            FocusPage(previous?.Key == page.Key ? focused : null);
    }

    internal void FocusPage(string? action = null)
    {
        if (_page == null) return;
        action ??= _page.FocusId ?? _lastAction.GetValueOrDefault(_page.Key);
        var choice = _buttons.Find(b => b.ActionId == action && b.IsEnabled);
        if (choice != null) choice.Focus();
        else if (_hub.IsVisible) _hub.Focus();
        else _buttons.FirstOrDefault(b => b.ActionId == "back")?.Focus();
    }
}

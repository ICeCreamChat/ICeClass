using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Primitives.PopupPositioning;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

/// <summary>The pet's context actions and size control share one light-dismiss popup.</summary>
internal sealed class BanbanPetMenu : Flyout
{
    private readonly bool _contrast = DesktopStyle.HighContrastEnabled();
    private readonly IBrush _ink;
    private readonly Canvas _ring = new();
    private readonly Dictionary<BanbanToolSector, Func<bool>> _conditionalActions = [];
    private readonly BanbanClassroomProgress _progress = new() { IsVisible = false };
    private readonly Grid _home, _sizePage;
    private readonly Viewbox _viewport;
    private readonly Button _close;
    private readonly BanbanToolSector _back, _reset;
    private readonly Slider _slider;
    private readonly Action _focusPet;
    private PopupRoot? _popupRoot;
    private Control? _returnTo, _opener;
    internal IEnumerable<BanbanToolSector> Actions => _ring.Children.OfType<BanbanToolSector>().Where(b => b.IsVisible);
    internal bool Sizing => _sizePage.IsVisible;

    internal BanbanPetMenu(Slider slider, TextBlock value, TextBlock error, Action resetSize, Action focusPet,
        BanbanClassroomProgress classroomProgress)
    {
        _ink = _contrast ? Brushes.Black : DesktopStyle.Brush("#005DBF");
        _slider = slider;
        _focusPet = focusPet;
        _close = MakeButton("收起菜单");
        SetCenter(false);
        _close.Click += (_, _) => CloseToOpener();
        _progress.Bind(BanbanClassroomProgress.FractionProperty, classroomProgress.GetObservable(BanbanClassroomProgress.FractionProperty));
        _home = new Grid { Children = { _ring, _close } };
        AutomationProperties.SetName(_home, "班班菜单");

        var limits = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        limits.Children.Add(Text("25%", 13, muted: true));
        var maximum = Text("150%", 13, muted: true);
        Grid.SetColumn(maximum, 1);
        limits.Children.Add(maximum);
        Grid.SetRow(slider, 1);
        Grid.SetRow(limits, 2);
        Grid.SetRow(error, 2);
        error.PropertyChanged += (_, e) =>
        {
            if (e.Property == Visual.IsVisibleProperty) limits.IsVisible = !error.IsVisible;
        };
        var controls = new Grid { Width = 154, RowDefinitions = new RowDefinitions("42,40,22"),
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 43, 0, 0), Children = { value, slider, limits, error } };
        var heading = Text("班班大小", 16, true);
        heading.HorizontalAlignment = HorizontalAlignment.Center;
        heading.Margin = new Thickness(0, 21, 0, 0);
        heading.VerticalAlignment = VerticalAlignment.Top;
        var footer = new Canvas();
        _back = Footer("返回班班菜单", "返回", "arrow-left", 0, ReturnFromSize);
        _reset = Footer("恢复默认大小", "默认", "rotate-ccw", 1, resetSize);
        _sizePage = new Grid { IsVisible = false, Children = { heading, controls, footer } };
        var disc = new Grid { Width = BanbanClassroomWheel.Diameter, Height = BanbanClassroomWheel.Diameter,
            Children = { DiscSurface(_contrast ? Brushes.White : DesktopStyle.Brush("#E4F1F9"), _contrast), _progress, _home, _sizePage } };
        _viewport = new Viewbox { Width = disc.Width, Height = disc.Height, Child = disc };
        Content = _viewport;
        Placement = PlacementMode.AnchorAndGravity;
        OverlayDismissEventPassThrough = true;
        disc.AddHandler(InputElement.KeyDownEvent, Navigate, RoutingStrategies.Tunnel);
        Opened += (_, _) =>
        {
            _popupRoot = TopLevel.GetTopLevel(_viewport) as PopupRoot;
            if (_popupRoot is not null) Win32Properties.AddWndProcHookCallback(_popupRoot, HitTest);
            FocusPage();
        };
        Closed += (_, _) =>
        {
            if (_popupRoot is not null) Win32Properties.RemoveWndProcHookCallback(_popupRoot, HitTest);
            _popupRoot = null;
        };

        BanbanToolSector Footer(string name, string caption, string glyph, int index, Action run)
        {
            var button = new BanbanToolSector(name, _contrast, _ink, BanbanToolSector.Band.Footer) { IsVisible = true };
            button.SetFace(name, caption, glyph);
            button.Place(index, 2);
            button.Click += (_, _) => run();
            footer.Children.Add(button);
            return button;
        }
    }

    // The native popup handles dismissal. Only the circular surface paints a background.
    protected override Control CreatePresenter() => new ContentPresenter { Content = Content };

    private IntPtr HitTest(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != 0x0084) return IntPtr.Zero; // WM_NCHITTEST
        var packed = lParam.ToInt64();
        var pixel = new PixelPoint(unchecked((short)packed), unchecked((short)(packed >> 16)));
        if (DiscContains(_viewport.Child!.PointToClient(pixel))) return IntPtr.Zero;
        handled = true;
        return new IntPtr(-1); // HTTRANSPARENT lets the slide beneath the corner receive the click.
    }

    internal BanbanToolSector AddAction(string name, string caption, string glyph, Action run, bool primary = false,
        bool opensSize = false, Func<bool>? visible = null)
    {
        var button = new BanbanToolSector(primary ? "primary" : name, _contrast, _ink, BanbanToolSector.Band.Shortcuts)
            { IsVisible = visible?.Invoke() ?? true };
        if (visible is not null) _conditionalActions.Add(button, visible);
        button.SetFace(name, caption, glyph);
        button.Click += (_, _) =>
        {
            if (opensSize) _returnTo = button;
            else Hide();
            run();
        };
        _ring.Children.Add(button);
        return button;
    }

    internal void RefreshActions(bool opening = false)
    {
        var changed = false;
        var lostFocus = false;
        foreach (var (button, available) in _conditionalActions)
        {
            bool visible = available();
            if (button.IsVisible == visible) continue;
            lostFocus |= button.IsFocused;
            button.IsVisible = visible;
            changed = true;
        }
        if (!opening && !changed) return;
        int index = 0, count = Actions.Count();
        foreach (var action in Actions) action.Place(index++, count);
        if (lostFocus && IsOpen && !Sizing) _close.Focus();
    }

    private void SetCenter(bool classroom)
    {
        RoundButton(_close, classroom ? 66 : 60);
        var caption = Text(classroom ? "返回" : "收起", 15, true);
        if (classroom)
        {
            _close.Background = _contrast ? Brushes.Black : _ink;
            caption.Foreground = Brushes.White;
        }
        _close.Content = new StackPanel { Spacing = 2, Children = {
            classroom ? Glyph("arrow-right", 20, Brushes.White, 180) : Glyph("plus", 19, _ink, 45), caption } };
        AutomationProperties.SetName(_close, classroom ? "返回课堂" : "收起菜单");
        ToolTip.SetTip(_close, classroom ? "返回课堂" : "收起菜单");
    }

    internal void ShowPage(Window owner, bool size, bool classroom, Control? opener)
    {
        if (!IsOpen) _opener = opener;
        if (_progress.IsVisible != classroom) SetCenter(classroom);
        _progress.IsVisible = classroom;
        RefreshActions(opening: true);
        _home.IsVisible = !size;
        _sizePage.IsVisible = size;
        if (IsOpen) FocusPage();
        else ShowAt(owner);
    }

    internal void Align(bool right, double inset, double diameter, double bottomInset = 0)
    {
        _viewport.Width = _viewport.Height = diameter;
        PlacementAnchor = right ? PopupAnchor.BottomRight : PopupAnchor.BottomLeft;
        PlacementGravity = right ? PopupGravity.TopLeft : PopupGravity.TopRight;
        HorizontalOffset = right ? -inset : inset;
        VerticalOffset = -bottomInset;
        if (IsOpen) { Popup.HorizontalOffset = HorizontalOffset; Popup.VerticalOffset = VerticalOffset; }
    }

    private void FocusPage() => Dispatcher.UIThread.Post(() =>
    {
        if (!IsOpen) return;
        if (Sizing) _slider.Focus();
        else if (_progress.IsVisible) _close.Focus();
        else (Actions.FirstOrDefault(b => b.IsEnabled) as Button ?? _close).Focus();
    }, DispatcherPriority.Input);

    private void ReturnFromSize()
    {
        _sizePage.IsVisible = false;
        _home.IsVisible = true;
        (_returnTo ?? _close).Focus();
    }

    private void CloseToOpener()
    {
        var opener = _opener;
        Hide();
        if (opener is { IsEffectivelyVisible:true, IsEffectivelyEnabled:true } && opener.Focus()) return;
        _focusPet();
    }

    private void Navigate(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            if (Sizing) ReturnFromSize(); else CloseToOpener();
        }
        else if (e.Key == Key.Apps || e.Key == Key.F10 && e.KeyModifiers == KeyModifiers.Shift) CloseToOpener();
        else if (Sizing)
        {
            if (e.Key != Key.Tab && (_slider.IsKeyboardFocusWithin || e.Key is not (Key.Left or Key.Right or Key.Up or Key.Down))) return;
            Control[] items = [_slider, _back, _reset];
            var index = Array.FindIndex(items, item => item.IsKeyboardFocusWithin);
            var previous = e.Key is Key.Left or Key.Up || e.Key == Key.Tab && e.KeyModifiers.HasFlag(KeyModifiers.Shift);
            items[(index + (previous ? items.Length - 1 : 1)) % items.Length].Focus();
        }
        else if (e.Key is Key.Tab or Key.Home or Key.End or Key.Left or Key.Right or Key.Up or Key.Down)
        {
            var items = Actions.Cast<Button>().Append(_close);
            var direction = e.Key == Key.Tab ? (e.KeyModifiers.HasFlag(KeyModifiers.Shift) ? Key.Left : Key.Right) : e.Key;
            StepFocus(items, items.FirstOrDefault(b => b.IsKeyboardFocusWithin), direction);
        }
        else return;
        e.Handled = true;
    }
}

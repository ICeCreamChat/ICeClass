using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace ICeClass.Receiver;

/// <summary>A companion for the existing voice session; it owns no microphone or browser.</summary>
internal sealed class BanbanPetWindow : Window
{
    private readonly Action _openChat, _startTalk, _cancelTask;
    private readonly Action<bool> _setEnabled;
    private readonly string _preferencePath;
    private readonly BanbanPetMascot _mascot = new();
    private readonly Button _talk, _captionButton;
    private readonly TextBlock _label = ClassroomStyle.Text("你好班班", 13, true);
    private readonly TextBlock _caption = ClassroomStyle.Text("", 14);
    private readonly Border _dot, _pill;
    private readonly MenuItem _pause;
    private readonly DispatcherTimer _captionTimer, _idleTimer;
    private readonly Canvas _layout;
    private PetPreference _preference;
    private string _state = "off";
    private bool _enabled, _suspended, _shutdown, _positioned, _pressed, _dragged, _doubleClick;
    private bool _docked = true, _right = true, _engaged, _inClass;
    private PixelPoint _pressPoint, _pressPosition;

    internal BanbanPetWindow(Action openChat, Action startTalk, Action cancelTask, Action<bool> setEnabled, string? preferencePath = null)
    {
        _openChat = openChat; _startTalk = startTalk; _cancelTask = cancelTask; _setEnabled = setEnabled;
        _preferencePath = preferencePath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "banban-pet.json");
        _preference = LoadPreference();
        Title = "班班 · 桌宠"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 64; Height = 80; CanResize = false;
        ShowInTaskbar = false; ShowActivated = false; Topmost = true;
        SystemDecorations = SystemDecorations.None; Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        WindowStartupLocation = WindowStartupLocation.Manual;
        ClassroomStyle.Apply(this);

        _dot = new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(3), Background = DesktopStyle.Muted, VerticalAlignment = VerticalAlignment.Center };
        _pill = new Border { Background = DesktopStyle.Brush("#F7FAFF"), BorderBrush = DesktopStyle.Brush("#DCE8F4"),
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(10, 4),
            HorizontalAlignment = HorizontalAlignment.Center,
            Child = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { _dot, _label } } };
        _talk = new Button { Name = "BanbanPetTalk", Width = 132, Height = 170, Padding = new Thickness(0),
            Background = Brushes.Transparent, BorderThickness = new Thickness(0),
            Content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Spacing = 1, Children = { _mascot, _pill } } };
        // A normal button keeps keyboard and screen reader activation, without a rectangular hover plate over the artwork.
        _talk.Template = new FuncControlTemplate<Button>((button, _) => new ContentPresenter { Content = button.Content,
            Background = Brushes.Transparent, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center });
        AutomationProperties.SetName(_talk, "与班班说话");
        AutomationProperties.SetHelpText(_talk, "单击说话，双击打开对话。拖动贴边，上下键移动，左右键切换停靠边，Home 复位。右键查看更多操作。");
        ToolTip.SetTip(_talk, "单击说话 · 双击对话 · 拖动移动");
        _talk.Click += (_, _) =>
        {
            if (_shutdown || _suspended || _dragged) return;
            Reveal(true);
            if (_doubleClick) _openChat(); else _startTalk();
        };
        _talk.AddHandler(PointerPressedEvent, Pressed, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerMovedEvent, Moved, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerReleasedEvent, Released, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.PointerCaptureLost += (_, _) => _pressed = false;
        _talk.PointerEntered += (_, _) =>
        {
            if (!_docked && _state == "listening" && !_pressed) _mascot.Play("wink");
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (_talk.IsKeyboardFocusWithin) MoveWithKeyboard(_talk, e);
        }, RoutingStrategies.Tunnel);

        _caption.MaxHeight = 102; _caption.TextTrimming = TextTrimming.CharacterEllipsis;
        _captionButton = new Button { Width = 202, Padding = new Thickness(14, 10), CornerRadius = new CornerRadius(16),
            Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#DCE8F4"), BorderThickness = new Thickness(1),
            IsVisible = false, Content = _caption, HorizontalContentAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(_captionButton, "查看班班对话");
        _captionButton.Click += (_, _) => _openChat();
        _layout = new Canvas { ClipToBounds = true, Children = { _captionButton, _talk } };
        Content = _layout;
        _captionTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(7) };
        _captionTimer.Tick += (_, _) => { _captionTimer.Stop(); _captionButton.IsVisible = false; };
        _idleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(12) };
        _idleTimer.Tick += (_, _) =>
        {
            _idleTimer.Stop();
            if (_pressed || _talk.ContextMenu?.IsOpen == true) { _idleTimer.Start(); return; }
            _engaged = false; ApplyPresence();
        };

        _pause = new MenuItem { Header = "启用语音" };
        _pause.Click += (_, _) => _setEnabled(!_enabled);
        _talk.ContextMenu = new ContextMenu { Items = {
            Item("打开对话", _openChat), Item("停止操作", _cancelTask), _pause,
            new Separator(), Item("移回桌面右下角", ResetPosition), Item("隐藏班班", HidePet) } };

        Win32Properties.AddWndProcHookCallback(this, HitTest);
        Screens.Changed += ScreensChanged;
        Opened += (_, _) => { Place(); Refresh(); };
        Closing += (_, e) => { if (!_shutdown && e.CloseReason is not (WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown)) { e.Cancel = true; HidePet(); } };
        Closed += (_, _) => { Screens.Changed -= ScreensChanged; _captionTimer.Stop(); _idleTimer.Stop(); _mascot.Dispose(); };
        ArrangeCompanion(true);
    }

    private static MenuItem Item(string title, Action action)
    {
        var item = new MenuItem { Header = title };
        item.Click += (_, _) => action();
        return item;
    }

    internal void ShowPet(bool userInitiated)
    {
        if (_shutdown) return;
        if (userInitiated) { _preference = _preference with { Visible = true }; SavePreference(); }
        if (userInitiated && _inClass) Reveal(true);
        else ApplyPresence();
    }
    internal void HidePet()
    {
        _preference = _preference with { Visible = false };
        _engaged = false;
        SavePreference(); _captionTimer.Stop(); _idleTimer.Stop(); _captionButton.IsVisible = false; Hide(); Refresh();
    }
    internal void Suspend(bool value)
    {
        _suspended = value;
        if (value) { _engaged = false; _captionTimer.Stop(); _idleTimer.Stop(); _captionButton.IsVisible = false; }
        ApplyPresence();
    }
    internal void SetInClass(bool value)
    {
        if (_inClass == value || _shutdown) return;
        _inClass = value;
        ApplyPresence();
    }

    private void Reveal(bool animate)
    {
        if (_shutdown || _suspended || !_preference.Visible) return;
        var arriving = !_engaged || _docked || !IsVisible;
        _engaged = true;
        ApplyPresence();
        if (animate && arriving) _mascot.PlayWake(_right);
        _idleTimer.Stop();
        if (_state is not ("thinking" or "speaking" or "confirming")) _idleTimer.Start();
    }

    private void ApplyPresence()
    {
        if (_shutdown) return;
        SetDocked(!_engaged);
        if (_suspended || !_preference.Visible || _inClass && !_engaged)
        {
            _idleTimer.Stop();
            _captionTimer.Stop(); _captionButton.IsVisible = false; Hide(); Refresh(); return;
        }
        Place(); Show(); Refresh();
    }

    private void SetDocked(bool value)
    {
        if (_docked == value) return;
        var screen = Screens.ScreenFromPoint(new PixelPoint(Position.X + (int)(Width * RenderScaling / 2), Position.Y + (int)(Height * RenderScaling / 2))) ?? Screens.Primary;
        var scale = screen?.Scaling ?? RenderScaling;
        var bottom = Position.Y + (int)Math.Ceiling(Height * scale);
        _docked = value;
        Width = value ? 64 : 350; Height = value ? 80 : 204;
        if (_positioned && screen is not null)
            Position = new PixelPoint(_right ? screen.WorkingArea.Right - (int)Math.Ceiling(Width * scale) : screen.WorkingArea.X,
                bottom - (int)Math.Ceiling(Height * scale));
        if (value) { _captionTimer.Stop(); _captionButton.IsVisible = false; }
        ArrangeCompanion(_right);
    }
    internal void Shutdown()
    {
        if (_shutdown) return;
        SavePreference(); _shutdown = true; _captionTimer.Stop(); _idleTimer.Stop(); _mascot.Present("off", false, false); Close();
    }

    internal void Present(BanbanVoiceEvent value)
    {
        if (_shutdown) return;
        if (value.Kind == "state")
        {
            _enabled = value.Enabled; _state = value.State;
            if (_state is "off" or "login" or "error" or "standby")
            { _captionTimer.Stop(); _captionButton.IsVisible = false; }
            if (_state is "off" or "login" or "standby" or "connecting")
            { _engaged = false; _idleTimer.Stop(); ApplyPresence(); }
            else if (_state is "listening" or "thinking" or "speaking" or "confirming") Reveal(false);
            else { Refresh(); if (_engaged) { _idleTimer.Stop(); _idleTimer.Start(); } }
            if (_state == "error") SetCaption(value.Text, true);
        }
        else if (value.Kind is "partial" or "transcript")
        {
            if ((value.Kind == "transcript" || _engaged) && !string.IsNullOrWhiteSpace(value.Text)) Reveal(false);
            SetCaption(value.Text, value.Kind == "partial");
        }
        else if (value.Kind == "caption") SetCaption(value.Text, false);
        else if (value.Kind is "cancel" or "interrupt" or "barge-in")
        {
            _mascot.Play("stop");
            if (value.Kind != "barge-in") SetCaption("已停止", true);
        }
        else if (value.Kind == "unrecognized") _mascot.Play("shrug");
        else if (value.Kind == "wake")
        {
            _captionButton.IsVisible = false; _captionTimer.Stop();
            _state = "listening"; Reveal(true);
        }
    }
    internal void SetCaption(string text, bool transient)
    {
        if (_shutdown || _suspended || _docked || !IsVisible || string.IsNullOrWhiteSpace(text)) return;
        var value = string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        _caption.Text = value.Length > 72 ? value[..72] + "…" : value;
        _captionButton.IsVisible = true;
        _captionTimer.Stop(); _captionTimer.Interval = TimeSpan.FromSeconds(transient ? 4 : 8); _captionTimer.Start();
    }

    private void Refresh()
    {
        _label.Text = _state switch { "listening" => "我在听", "thinking" => "处理中", "speaking" => "正在说",
            "confirming" => "等您确认", "login" => "点击登录", "connecting" => "准备语音", "error" => "语音需重连",
            "off" => "语音已暂停", _ => "你好班班" };
        _dot.Background = DesktopStyle.Brush(_state is "error" ? "#C56B41" : _enabled ? "#3A91D7" : "#8A99AC");
        _pause.Header = _enabled ? "暂停语音" : "启用语音";
        _mascot.Present(_state, _enabled, IsVisible && !_suspended && !_docked);
    }

    private void Pressed(object? sender, PointerPressedEventArgs e)
    {
        if (!e.GetCurrentPoint(_talk).Properties.IsLeftButtonPressed) return;
        _pressPoint = this.PointToScreen(e.GetPosition(this)); _pressPosition = Position;
        _pressed = true; _dragged = false; _doubleClick = e.ClickCount == 2;
    }
    private void Moved(object? sender, PointerEventArgs e)
    {
        if (!_pressed) return;
        var point = this.PointToScreen(e.GetPosition(this));
        var dx = point.X - _pressPoint.X; var dy = point.Y - _pressPoint.Y;
        if (!_dragged && Math.Abs(dx) + Math.Abs(dy) < 6 * RenderScaling) return;
        if (!_dragged) _mascot.Play("sway");
        _dragged = true;
        Position = new PixelPoint(_pressPosition.X + dx, _pressPosition.Y + dy);
    }
    private void Released(object? sender, PointerReleasedEventArgs e)
    {
        if (e.InitialPressMouseButton != MouseButton.Left) return;
        _pressed = false;
        if (_dragged) { Fit(snap: true); SavePreference(); _mascot.Play("settle"); }
    }
    private void MoveWithKeyboard(object? sender, KeyEventArgs e)
    {
        if (e.Key is Key.Space or Key.Enter) { _dragged = _doubleClick = false; return; }
        if (e.Key == Key.Home) { ResetPosition(); e.Handled = true; return; }
        if (e.Key is Key.Left or Key.Right)
        {
            var screen = Screens.ScreenFromPoint(Position) ?? Screens.Primary;
            if (screen is not null)
            {
                Position = new PixelPoint(e.Key == Key.Left ? screen.WorkingArea.X
                    : screen.WorkingArea.Right - (int)Math.Ceiling(Width * screen.Scaling), Position.Y);
                Fit(true); SavePreference();
            }
            e.Handled = true; return;
        }
        var step = e.KeyModifiers.HasFlag(KeyModifiers.Shift) ? 1 : (int)Math.Round(10 * RenderScaling);
        var dx = e.Key == Key.Left ? -step : e.Key == Key.Right ? step : 0;
        var dy = e.Key == Key.Up ? -step : e.Key == Key.Down ? step : 0;
        if (dx == 0 && dy == 0) return;
        Position = new PixelPoint(Position.X + dx, Position.Y + dy); Fit(false); SavePreference(); e.Handled = true;
    }
    private void Place()
    {
        if (!_positioned)
        {
            _positioned = true;
            if (_preference.X.HasValue && _preference.Y.HasValue)
            {
                var screen = Screens.ScreenFromPoint(new PixelPoint(_preference.X.Value, _preference.Y.Value)) ?? Screens.Primary;
                var scale = screen?.Scaling ?? RenderScaling;
                var bottom = _preference.Bottom ?? _preference.Y.Value + (int)Math.Ceiling(204 * scale);
                Position = new PixelPoint(_preference.X.Value, bottom - (int)Math.Ceiling(Height * scale));
            }
            else { ResetPosition(); return; }
        }
        Fit(true);
    }
    private void ResetPosition()
    {
        var screen = Screens.Primary ?? Screens.All.FirstOrDefault();
        if (screen is null) return;
        _positioned = true;
        _right = true;
        Position = new PixelPoint(screen.WorkingArea.Right - (int)Math.Ceiling(Width * screen.Scaling),
            screen.WorkingArea.Bottom - (int)Math.Ceiling(Height * screen.Scaling) - 20);
        Fit(true); SavePreference();
    }
    private void ScreensChanged(object? sender, EventArgs e) { if (_positioned) { Fit(true); SavePreference(); } }
    private void Fit(bool snap)
    {
        var screen = Screens.ScreenFromPoint(new PixelPoint(Position.X + (int)(Width * RenderScaling / 2), Position.Y + (int)(Height * RenderScaling / 2))) ?? Screens.Primary;
        if (screen is null) return;
        Width = Math.Min(_docked ? 64 : 350, screen.WorkingArea.Width / screen.Scaling);
        Height = Math.Min(_docked ? 80 : 204, screen.WorkingArea.Height / screen.Scaling);
        _right = Position.X + Width * screen.Scaling / 2 >= screen.WorkingArea.X + screen.WorkingArea.Width / 2d;
        Position = Constrain(Position, screen.WorkingArea, new Size(Width, Height), screen.Scaling);
        var edge = screen.WorkingArea.Right - (int)Math.Ceiling(Width * screen.Scaling);
        if (snap || _docked) Position = new PixelPoint(_right ? edge : screen.WorkingArea.X, Position.Y);
        ArrangeCompanion(_right);
    }
    internal static PixelPoint Constrain(PixelPoint position, PixelRect work, Size size, double scale) => new(
        Math.Clamp(position.X, work.X, Math.Max(work.X, work.Right - (int)Math.Ceiling(size.Width * scale))),
        Math.Clamp(position.Y, work.Y, Math.Max(work.Y, work.Bottom - (int)Math.Ceiling(size.Height * scale))));

    private void ArrangeCompanion(bool right)
    {
        _pill.IsVisible = !_docked;
        _talk.Width = _docked ? 60 : 132; _talk.Height = _docked ? 76 : 170;
        _mascot.Width = _docked ? 52 : 116; _mascot.Height = _docked ? 62 : 130;
        Canvas.SetLeft(_talk, _docked ? right ? 8 : -4 : right ? Width - 138 : 4);
        Canvas.SetTop(_talk, _docked ? 2 : Height - 174);
        _captionButton.Width = Math.Max(72, Width - 148);
        Canvas.SetLeft(_captionButton, right ? 4 : 144); Canvas.SetTop(_captionButton, Math.Max(2, Height - 190));
    }
    private IntPtr HitTest(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != 0x0084) return IntPtr.Zero; // WM_NCHITTEST: transparent space must not block the lesson behind it.
        var point = this.PointToClient(new PixelPoint(unchecked((short)(lParam.ToInt64() & 0xffff)), unchecked((short)((lParam.ToInt64() >> 16) & 0xffff))));
        if (_talk.Bounds.Contains(point) || _captionButton.IsVisible && _captionButton.Bounds.Contains(point)) return IntPtr.Zero;
        handled = true; return new IntPtr(-1);
    }

    private PetPreference LoadPreference()
    {
        try { return JsonSerializer.Deserialize<PetPreference>(File.ReadAllText(_preferencePath)) ?? new(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
    private void SavePreference()
    {
        if (_positioned) _preference = _preference with { X = Position.X, Y = Position.Y,
            Bottom = Position.Y + (int)Math.Ceiling(Height * RenderScaling) };
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_preferencePath)!);
            var temporary = _preferencePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(_preference), new UTF8Encoding(false));
            File.Move(temporary, _preferencePath, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { AppLog.Error("Save Banban companion preference failed", error); }
    }
    private sealed record PetPreference(bool Visible = true, int? X = null, int? Y = null, int? Bottom = null);
}

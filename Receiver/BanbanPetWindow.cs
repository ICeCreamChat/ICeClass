using System.Diagnostics;
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
    internal const double DockedWidth = 100, ExpandedWidth = 324, SurfaceHeight = 174;
    private readonly Action _openChat, _startTalk, _cancelTask;
    private readonly Action<bool> _setEnabled;
    private readonly string _preferencePath;
    private readonly BanbanPetMascot _mascot = new();
    private readonly BanbanListeningWaveform _waveform = new();
    private readonly BanbanSpeechBubble _captionBubble;
    private readonly Button _talk, _captionButton;
    private readonly TextBlock _label = ClassroomStyle.Text("你好班班", 13, true);
    private readonly TextBlock _caption = ClassroomStyle.Text("", 14);
    private readonly Border _dot, _pill;
    private readonly MenuItem _pause;
    private readonly DispatcherTimer _captionTimer, _idleTimer, _dockFrames, _departureFrames;
    private readonly TranslateTransform _departure = new();
    private readonly IslandSpring _dock = new();
    private long _dockLastFrame;
    private long _departureStarted;
    private readonly Canvas _layout;
    private PetPreference _preference;
    private string _state = "off";
    private bool _enabled, _suspended, _shutdown, _positioned, _pressed, _dragged, _doubleClick;
    private bool _docked = true, _right = true, _engaged, _inClass, _dismissed, _preparing;
    private int _successes;
    private PixelPoint _pressPoint, _pressPosition;
    internal Func<double>? SpeechOpening { set => _mascot.SpeechOpening = value; }

    internal BanbanPetWindow(Action openChat, Action startTalk, Action cancelTask, Action<bool> setEnabled, string? preferencePath = null)
    {
        _openChat = openChat; _startTalk = startTalk; _cancelTask = cancelTask; _setEnabled = setEnabled;
        _preferencePath = preferencePath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "banban-pet.json");
        _preference = LoadPreference();
        Title = "班班 · 桌宠"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = DockedWidth; Height = SurfaceHeight; CanResize = false;
        _dock.Snap(1);
        ShowInTaskbar = false; ShowActivated = false; Topmost = true;
        SystemDecorations = SystemDecorations.None; Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        WindowStartupLocation = WindowStartupLocation.Manual;
        ClassroomStyle.Apply(this);

        _dot = new Border { Width = 6, Height = 6, CornerRadius = new CornerRadius(3), Background = DesktopStyle.Muted, VerticalAlignment = VerticalAlignment.Center };
        _pill = new Border { Background = DesktopStyle.Brush("#F7FAFF"), BorderBrush = DesktopStyle.Brush("#DCE8F4"),
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(10, 4),
            HorizontalAlignment = HorizontalAlignment.Center,
            Child = new Grid { Children = {
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { _dot, _label } }, _waveform } } };
        _talk = new Button { Name = "BanbanPetTalk", Width = 124, Height = 166, Padding = new Thickness(0),
            Background = Brushes.Transparent, BorderThickness = new Thickness(0), ClipToBounds = false, RenderTransform = _departure,
            Content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Spacing = 1, Children = { _mascot, _pill } } };
        // A normal button keeps keyboard and screen reader activation, without a rectangular hover plate over the artwork.
        _talk.Template = new FuncControlTemplate<Button>((button, _) => new ContentPresenter { Content = button.Content,
            Background = Brushes.Transparent, ClipToBounds = false,
            HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Top });
        AutomationProperties.SetName(_talk, "与班班说话");
        AutomationProperties.SetHelpText(_talk, "单击说话，双击打开对话。拖动贴边，上下键移动，左右键切换停靠边，Home 复位。右键查看更多操作。");
        ToolTip.SetTip(_talk, "单击说话 · 双击对话 · 拖动移动");
        _talk.Click += (_, _) =>
        {
            if (_shutdown || _suspended || _dragged || _dismissed) return;
            Reveal(true);
            if (_doubleClick) _openChat(); else _startTalk();
        };
        _talk.AddHandler(PointerPressedEvent, Pressed, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerMovedEvent, Moved, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerReleasedEvent, Released, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.PointerCaptureLost += (_, _) => _pressed = false;
        _talk.PointerEntered += (_, _) =>
        {
            if (_pressed || _mascot.Gesture.Length > 0) return;
            if (_docked) _mascot.Play(_right ? "peek-left" : "peek-right", _right);
            else if (_state == "listening") _mascot.Play("wink", _right);
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (!_dismissed && _talk.IsKeyboardFocusWithin) MoveWithKeyboard(_talk, e);
        }, RoutingStrategies.Tunnel);

        _caption.MaxHeight = 102; _caption.TextTrimming = TextTrimming.CharacterEllipsis;
        _captionBubble = new BanbanSpeechBubble { Child = _caption };
        _captionButton = new Button { Padding = new Thickness(0),
            Background = Brushes.Transparent, BorderThickness = new Thickness(0),
            IsVisible = false, Content = _captionBubble, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        _captionButton.Template = new FuncControlTemplate<Button>((button, _) => new ContentPresenter {
            Content = button.Content, Background = Brushes.Transparent,
            HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch });
        _captionButton.PropertyChanged += (_, e) =>
        {
            if (e.Property == IsPointerOverProperty || e.Property == Button.IsPressedProperty || e.Property == IsKeyboardFocusWithinProperty)
                _captionBubble.SetInteraction(_captionButton.IsPointerOver, _captionButton.IsPressed, _captionButton.IsKeyboardFocusWithin);
        };
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
        _dockFrames = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
        _dockFrames.Tick += (_, _) =>
        {
            var now = Stopwatch.GetTimestamp();
            _dock.Advance(Stopwatch.GetElapsedTime(_dockLastFrame, now).TotalSeconds); _dockLastFrame = now;
            if (!IsVisible || _suspended || !_mascot.Animate || _dock.IsAtRest(.001, .02)) FinishDocking();
            else ArrangeCompanion(_right);
        };
        _departureFrames = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
        _departureFrames.Tick += (_, _) =>
        {
            var elapsed = Stopwatch.GetElapsedTime(_departureStarted).TotalSeconds;
            if (elapsed >= 2 || !IsVisible || _suspended || !_mascot.Animate) { FinishDeparture(); return; }
            var progress = Math.Clamp((elapsed - 1.15) / .85, 0, 1);
            var distance = _right ? Width - Canvas.GetLeft(_talk) + 12 : -Canvas.GetLeft(_talk) - _talk.Width - 12;
            _departure.X = distance * progress * progress * (3 - 2 * progress);
            _talk.Opacity = 1 - progress * progress;
        };

        _pause = new MenuItem { Header = "启用语音" };
        _pause.Click += (_, _) => _setEnabled(!_enabled);
        _talk.ContextMenu = new ContextMenu { Items = {
            Item("打开对话", _openChat), Item("停止操作", _cancelTask), _pause,
            new Separator(), Item("移回桌面右下角", ResetPosition), Item("隐藏班班", HidePet) } };

        Win32Properties.AddWndProcHookCallback(this, HitTest);
        Screens.Changed += ScreensChanged;
        PropertyChanged += (_, e) =>
        {
            if (e.Property != IsVisibleProperty) return;
            if (!IsVisible) { _departureFrames.Stop(); _mascot.Present(_state, _enabled, false, _docked, _right); }
            RefreshWaveform();
        };
        Opened += (_, _) => { Place(); Refresh(); };
        Closing += (_, e) => { if (!_shutdown && e.CloseReason is not (WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown)) { e.Cancel = true; HidePet(); } };
        Closed += (_, _) => { Screens.Changed -= ScreensChanged; _captionTimer.Stop(); _idleTimer.Stop(); _dockFrames.Stop(); _departureFrames.Stop(); _waveform.Dispose(); _mascot.Dispose(); };
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
        if (userInitiated) { CancelDeparture(); _preference = _preference with { Visible = true }; SavePreference(); }
        if (userInitiated && _inClass) Reveal(true);
        else ApplyPresence();
    }
    internal void HidePet()
    {
        _preference = _preference with { Visible = false };
        _engaged = _preparing = false;
        SavePreference(); _captionTimer.Stop(); _idleTimer.Stop(); _departureFrames.Stop(); _captionButton.IsVisible = false; Hide(); Refresh();
    }
    internal void Suspend(bool value)
    {
        _suspended = value;
        if (value) { _engaged = _preparing = false; _captionTimer.Stop(); _idleTimer.Stop(); _captionButton.IsVisible = false; }
        ApplyPresence();
    }
    internal void SetInClass(bool value)
    {
        if (_inClass == value || _shutdown) return;
        _inClass = value;
        ApplyPresence();
    }

    internal void SetPreparing(bool value)
    {
        _preparing = value;
        if (!value) { _captionTimer.Stop(); _captionButton.IsVisible = false; return; }
        _state = "connecting";
        Reveal(true);
        SetCaption("正在准备语音…", false);
        _captionTimer.Stop(); _idleTimer.Stop();
    }

    private void Reveal(bool animate)
    {
        if (_shutdown || _suspended || !_preference.Visible || _dismissed) return;
        var arriving = !_engaged || _docked || !IsVisible;
        _engaged = true;
        ApplyPresence();
        if (animate && arriving) _mascot.PlayWake(_right);
        _idleTimer.Stop();
        _idleTimer.Interval = TimeSpan.FromSeconds(12);
        if (_state is not ("thinking" or "speaking" or "confirming")) _idleTimer.Start();
    }

    private void ApplyPresence()
    {
        if (_shutdown) return;
        if (_dismissed)
        {
            if (_suspended || !_departureFrames.IsEnabled) FinishDeparture();
            return;
        }
        SetDocked(!_engaged);
        if (_suspended || !_preference.Visible || _inClass && !_engaged)
        {
            _idleTimer.Stop();
            _captionTimer.Stop(); _captionButton.IsVisible = false; Hide(); Refresh(); return;
        }
        Place(); Show(); Refresh();
    }

    private void Depart()
    {
        // Voice dismissal lasts until the next wake; it never changes the user's visibility preference.
        if (_dismissed) return;
        _dismissed = true; _engaged = _preparing = false; _pressed = false; _state = "standby";
        _captionTimer.Stop(); _idleTimer.Stop(); _dockFrames.Stop();
        _talk.ContextMenu?.Close(); _talk.IsHitTestVisible = false;
        _captionButton.IsVisible = false; _pill.IsVisible = false; RefreshWaveform();
        if (!IsVisible || _suspended || !_preference.Visible || !_enabled || !_mascot.Animate) { FinishDeparture(); return; }
        _docked = false; _dock.Snap(0); ResizeSurface(ExpandedWidth); ArrangeCompanion(_right); Refresh();
        _mascot.Play("wave", _right);
        _departureStarted = Stopwatch.GetTimestamp(); _departureFrames.Start();
    }
    private void FinishDeparture()
    {
        _departureFrames.Stop(); Hide(); Refresh();
    }
    private void CancelDeparture()
    {
        _departureFrames.Stop(); _dismissed = false; _departure.X = 0; _talk.Opacity = 1; _talk.IsHitTestVisible = true;
    }

    private void SetDocked(bool value)
    {
        if (_docked == value) return;
        _docked = value;
        if (value) { _captionTimer.Stop(); _captionButton.IsVisible = false; }
        _dock.Retarget(value ? 1 : 0);
        if (IsVisible && !_suspended && _preference.Visible && (!_inClass || !value) && _mascot.Animate)
        {
            ResizeSurface(ExpandedWidth);
            _dockLastFrame = Stopwatch.GetTimestamp(); _dockFrames.Start();
        }
        else FinishDocking();
        ArrangeCompanion(_right);
    }
    private void FinishDocking()
    {
        _dockFrames.Stop(); _dock.Snap(_docked ? 1 : 0);
        ResizeSurface(_docked ? DockedWidth : ExpandedWidth);
        ArrangeCompanion(_right);
    }
    private void ResizeSurface(double width)
    {
        var screen = Screens.ScreenFromPoint(new PixelPoint(Position.X + (int)(Width * RenderScaling / 2), Position.Y + (int)(Height * RenderScaling / 2))) ?? Screens.Primary;
        var scale = screen?.Scaling ?? RenderScaling;
        var bottom = Position.Y + (int)Math.Ceiling(Height * scale);
        Width = screen is null ? width : Math.Min(width, screen.WorkingArea.Width / scale);
        Height = screen is null ? SurfaceHeight : Math.Min(SurfaceHeight, screen.WorkingArea.Height / scale);
        if (_positioned && screen is not null)
            Position = new PixelPoint(_right ? screen.WorkingArea.Right - (int)Math.Ceiling(Width * scale) : screen.WorkingArea.X,
                Math.Clamp(bottom - (int)Math.Ceiling(Height * scale), screen.WorkingArea.Y,
                    Math.Max(screen.WorkingArea.Y, screen.WorkingArea.Bottom - (int)Math.Ceiling(Height * scale))));
    }
    internal void Shutdown()
    {
        if (_shutdown) return;
        SavePreference(); _shutdown = true; _captionTimer.Stop(); _idleTimer.Stop(); _dockFrames.Stop(); _departureFrames.Stop(); _waveform.Dispose(); _mascot.Present("off", false, false); Close();
    }

    internal void Present(BanbanVoiceEvent value)
    {
        if (_shutdown) return;
        if (value.Kind == "leave") { Depart(); return; }
        if (value.Kind == "wake") CancelDeparture();
        else if (_dismissed)
        {
            // Late speech/task events must not undo an explicit departure.
            if (value.Kind == "state")
            {
                _enabled = value.Enabled;
                if (!_enabled || value.State is "off" or "login") { _state = value.State; FinishDeparture(); }
            }
            return;
        }
        if (value.Kind == "wake" || value.Kind == "state" && value.State == "error") _preparing = false;
        if (_preparing && value.Kind == "state" && value.State is "off" or "login" or "standby" or "connecting")
        {
            _enabled = value.Enabled;
            Refresh();
            return;
        }
        if (value.Kind == "audio-level")
        {
            RefreshWaveform();
            _waveform.Present(value.Level);
        }
        else if (value.Kind == "state")
        {
            _enabled = value.Enabled; _state = value.State;
            if (_state is "off" or "login" or "error" or "standby")
            { _captionTimer.Stop(); _captionButton.IsVisible = false; }
            if (_state == "standby" && _engaged && IsVisible && !_suspended && _mascot.Animate)
            {
                Refresh(); _mascot.Play("bow");
                _idleTimer.Stop(); _idleTimer.Interval = TimeSpan.FromSeconds(2.4); _idleTimer.Start();
            }
            else if (_state is "off" or "login" or "standby" or "connecting")
            { _engaged = false; _idleTimer.Stop(); ApplyPresence(); }
            else if (_state is "listening" or "thinking" or "speaking" or "confirming") Reveal(false);
            else { Refresh(); if (_engaged) { _idleTimer.Stop(); _idleTimer.Start(); } }
            if (_state == "error") SetCaption(value.Text, true);
        }
        else if (value.Kind is "partial" or "transcript")
        {
            if ((value.Kind == "transcript" || _engaged) && !string.IsNullOrWhiteSpace(value.Text)) Reveal(false);
            if (value.Kind == "transcript" && !string.IsNullOrWhiteSpace(value.Text)) _mascot.Play("double-nod");
            SetCaption(value.Text, value.Kind == "partial");
        }
        else if (value.Kind == "caption") SetCaption(value.Text, false);
        else if (value.Kind is "cancel" or "interrupt" or "barge-in")
        {
            _mascot.Play("stop");
            if (value.Kind != "barge-in") SetCaption("已停止", true);
        }
        else if (value.Kind == "unrecognized") _mascot.Play("shrug");
        else if (value.Kind == "task-result")
            _mascot.Play(value.State switch { "succeeded" => (++_successes % 2 == 0 ? "hop" : "happy"), "cancelled" => "stop", _ => "shake" });
        else if (value.Kind == "wake")
        {
            _captionButton.IsVisible = false; _captionTimer.Stop();
            _state = "listening"; Reveal(true);
        }
    }
    internal void SetCaption(string text, bool transient)
    {
        if (_shutdown || _suspended || _docked || _dismissed || !IsVisible || string.IsNullOrWhiteSpace(text)) return;
        var value = string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        _caption.Text = value.Length > 72 ? value[..72] + "…" : value;
        AutomationProperties.SetHelpText(_captionButton, value);
        _captionButton.IsVisible = true;
        _captionTimer.Stop(); _captionTimer.Interval = TimeSpan.FromSeconds(transient ? 4 : 8); _captionTimer.Start();
    }

    private void Refresh()
    {
        _pill.IsVisible = !_docked && !_dismissed;
        _label.Text = _state switch { "listening" => "我在听", "thinking" => "处理中", "speaking" => "正在说",
            "confirming" => "等您确认", "login" => "点击登录", "connecting" => "准备语音", "error" => "语音需重连",
            "off" => "语音已暂停", _ => "你好班班" };
        var listening = _state == "listening";
        _dot.IsVisible = _label.IsVisible = !listening;
        _waveform.IsVisible = listening;
        AutomationProperties.SetItemStatus(_talk, _label.Text);
        _dot.Background = DesktopStyle.Brush(_state is "error" ? "#C56B41" : _enabled ? "#3A91D7" : "#8A99AC");
        _pause.Header = _enabled ? "暂停语音" : "启用语音";
        if (!IsVisible || _suspended) FinishDocking();
        _mascot.Present(_state, _enabled, IsVisible && !_suspended, _docked, _right);
        RefreshWaveform();
    }

    private void RefreshWaveform() => _waveform.SetListening(
        !_shutdown && !_dismissed && _state == "listening" && _enabled && !_docked && IsVisible && !_suspended, _mascot.Animate);

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
        if (dx != 0 || dy != 0) _mascot.Play("walk");
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
                var bottom = _preference.Bottom ?? _preference.Y.Value + (int)Math.Ceiling(SurfaceHeight * scale);
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
        Width = Math.Min(_docked && !_dockFrames.IsEnabled ? DockedWidth : ExpandedWidth, screen.WorkingArea.Width / screen.Scaling);
        Height = Math.Min(SurfaceHeight, screen.WorkingArea.Height / screen.Scaling);
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
        _pill.IsVisible = !_docked && !_dismissed;
        RefreshWaveform();
        _mascot.Width = 116; _mascot.Height = 130;
        var peek = Math.Clamp(_dock.Value, 0, 1);
        _mascot.SetPeeking(peek, right);
        // Include the tilted artwork in the button without moving its centered content.
        var margin = 24 * peek;
        _talk.Width = 124 + margin * 2;
        Canvas.SetLeft(_talk, (right ? Width - 130 + 72 * peek : 6 - 74 * peek) - margin);
        Canvas.SetTop(_talk, Height - 166);
        _captionButton.MaxWidth = Math.Max(48, Math.Min(172, Width - 144));
        _captionButton.MinWidth = Math.Min(86, _captionButton.MaxWidth);
        _captionBubble.PointRight = right;
        Canvas.SetLeft(_captionButton, right ? double.NaN : 138);
        Canvas.SetRight(_captionButton, right ? 140 : double.NaN);
        Canvas.SetTop(_captionButton, Math.Max(2, Height - 158));
    }
    private IntPtr HitTest(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != 0x0084) return IntPtr.Zero; // WM_NCHITTEST: transparent space must not block the lesson behind it.
        var point = this.PointToClient(new PixelPoint(unchecked((short)(lParam.ToInt64() & 0xffff)), unchecked((short)((lParam.ToInt64() >> 16) & 0xffff))));
        if (!_dismissed && (_talk.Bounds.Contains(point) || _captionButton.IsVisible && _captionButton.Bounds.Contains(point))) return IntPtr.Zero;
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

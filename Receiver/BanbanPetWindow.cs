using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace ICeClass.Receiver;

/// <summary>A companion for the existing voice session; it owns no microphone or browser.</summary>
internal sealed partial class BanbanPetWindow : Window
{
    internal const double DockedWidth = 100, ExpandedWidth = 324, SurfaceHeight = 174;
    private const int DefaultSizePercent = 80;
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
    internal BanbanPetMenu PetMenu { get; }
    private readonly BanbanToolSector _pause;
    private readonly Slider _sizeSlider;
    private readonly TextBlock _sizeValue = BanbanClassroomStyle.Text("", 31, true);
    private readonly TextBlock _sizeError = BanbanClassroomStyle.Text("", 13);
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
    private bool IsDragging => _pressed && _dragged;
    private double Scale => _preference.SizePercent / 100d * (_classroomBinding is null ? 1 : .75);
    private double RestWidth => _classroomBinding is null ? Math.Max(44, DockedWidth * Scale) : Math.Max(78,124 * Scale);
    private double CaptionOffset => Math.Max(140, 140 * Scale);
    private double FullWidth => CaptionOffset + 184;
    private double CompanionHeight => _classroomBinding is null ? Math.Max(SurfaceHeight, 130 * Scale + 44) : Math.Max(128, 130 * Scale + 36);
    internal Func<double>? SpeechOpening { set => _mascot.SpeechOpening = value; }

    internal BanbanPetWindow(Action openChat, Action startTalk, Action cancelTask, Action<bool> setEnabled, string? preferencePath = null,
        ReceiverConfig? classroomBinding = null)
    {
        _classroomBinding = classroomBinding;
        _openChat = openChat; _startTalk = startTalk; _cancelTask = cancelTask; _setEnabled = setEnabled;
        _preferencePath = preferencePath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "banban-pet.json");
        _preference = LoadPreference();
        Title = "班班 · 桌宠"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = RestWidth; Height = CompanionHeight; CanResize = false;
        _dock.Snap(1);
        ShowInTaskbar = false; ShowActivated = false; Topmost = true;
        SystemDecorations = SystemDecorations.None; Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        WindowStartupLocation = WindowStartupLocation.Manual;
        ClassroomStyle.Apply(this, glass: false);

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
            if (_shutdown || _suspended || _dragged || _dismissed || _longPressed) return;
            if (_classroomBinding is not null)
            {
                if (!_doubleClick) SetClassroomExpanded(!ClassroomExpanded);
                return;
            }
            Reveal(true);
            if (_doubleClick) _openChat(); else _startTalk();
        };
        _talk.AddHandler(PointerPressedEvent, Pressed, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerMovedEvent, Moved, RoutingStrategies.Tunnel, handledEventsToo: true);
        _talk.AddHandler(PointerReleasedEvent, Released, RoutingStrategies.Tunnel, handledEventsToo: true);
        // Button raises Click inside its release handler. Only suppress the click from this gesture.
        _talk.AddHandler(PointerReleasedEvent, (_, e) =>
        {
            if (e.Pointer.IsPrimary && e.InitialPressMouseButton == MouseButton.Left)
                _dragged = _doubleClick = _longPressed = false;
        }, RoutingStrategies.Bubble, handledEventsToo: true);
        _talk.PointerCaptureLost += (_, e) =>
        {
            if (!_pressed || !e.Pointer.IsPrimary) return;
            _holdTimer.Stop(); var dragging = IsDragging; _pressed = false;
            if (dragging) FinishDrag();
            _dragged = _doubleClick = _longPressed = false;
        };
        _talk.PointerEntered += (_, _) =>
        {
            if (_pressed || ClassroomExpanded || _mascot.Gesture.Length > 0) return;
            if (_docked) _mascot.Play(_right ? "peek-left" : "peek-right", _right);
            else if (_state == "listening") _mascot.Play("wink", _right);
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (!e.Handled && !ClassroomExpanded && !_dismissed && _talk.IsKeyboardFocusWithin) MoveWithKeyboard(_talk, e);
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
            if (ClassroomExpanded) return;
            if (_pressed || PetMenu?.IsOpen == true) { _idleTimer.Start(); return; }
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

        _sizeSlider = new Slider { Minimum = 25, Maximum = 150, Value = _preference.SizePercent,
            TickFrequency = 1, IsSnapToTickEnabled = true, SmallChange = 1, LargeChange = 25, MinHeight = 40 };
        AutomationProperties.SetName(_sizeSlider, "班班大小");
        AutomationProperties.SetHelpText(_sizeSlider, "25% 到 150%，左右键调整大小。");
        _sizeValue.Text = $"{_preference.SizePercent}%";
        _sizeValue.TextAlignment = TextAlignment.Center;
        _sizeError.TextAlignment = TextAlignment.Center;
        _sizeError.IsVisible = false;
        AutomationProperties.SetLiveSetting(_sizeError, AutomationLiveSetting.Polite);
        PetMenu = new BanbanPetMenu(_sizeSlider, _sizeValue, _sizeError,
            () => { _sizeSlider.Value = DefaultSizePercent; AlignPetMenu(); }, () => _talk.Focus(), _classroomWheel.Progress);
        if (_classroomBinding is not null)
            PetMenu.AddAction("课堂功能", "课堂", "book-open", () => SetClassroomExpanded(true), primary: true,
                visible: () => !ClassroomExpanded);
        PetMenu.AddAction("打开对话", "对话", "message-circle", _openChat, primary: _classroomBinding is null);
        PetMenu.AddAction("停止操作", "停止", "square", _cancelTask);
        _pause = PetMenu.AddAction("启用语音", "开麦", "mic", () => _setEnabled(!_enabled));
        PetMenu.AddAction("大小", "大小", "maximize-2", () => OpenPetMenu(size: true), opensSize: true);
        PetMenu.AddAction("移回桌面右下角", "归位", "rotate-ccw", ResetPosition);
        PetMenu.AddAction("隐藏班班", "隐藏", "eye-off", HidePet);
        if (_classroomBinding is not null)
            PetMenu.AddAction("待同步课堂", "待同步", "rotate-ccw", _classroomWheel.OpenPendingHistory,
                visible: () => ClassroomExpanded && _classroomWheel.HasPendingHistory);
        _talk.ContextRequested += (sender, e) =>
        {
            // Touch and pen drivers may also request a context menu for the same contact.
            if (!PetMenu.IsOpen && (_classroomBinding is null || !e.TryGetPosition(_talk, out _) || !(_pressed || _longPressed || _dragged)))
                OpenPetMenu();
            e.Handled = true;
        };
        InitializeClassroomWheel();
        _sizeSlider.PropertyChanged += (_, e) =>
        {
            if (e.Property != RangeBase.ValueProperty) return;
            var percent = Math.Clamp((int)Math.Round(_sizeSlider.Value), 25, 150);
            if (_preference.SizePercent == percent) return;
            _preference = _preference with { SizePercent = percent };
            _sizeValue.Text = $"{percent}%";
            ResizeSurface(_docked ? RestWidth : FullWidth); ArrangeCompanion(_right); SavePreference();
        };
        _sizeSlider.AddHandler(PointerReleasedEvent, (_, _) => AlignPetMenu(), RoutingStrategies.Tunnel, handledEventsToo: true);
        _sizeSlider.AddHandler(KeyDownEvent, (_, _) => Dispatcher.UIThread.Post(AlignPetMenu), RoutingStrategies.Tunnel, handledEventsToo: true);
        PetMenu.Closed += (_, _) =>
        {
            if (!_shutdown && !ClassroomExpanded && _engaged && _state is not ("thinking" or "speaking" or "confirming")) _idleTimer.Start();
        };

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
        _captionButton.SizeChanged += (_, _) => ArrangeCaption();
        ArrangeCompanion(true);
    }

    private void OpenPetMenu(bool size = false, Control? opener = null)
    {
        if (_shutdown || _suspended || _dismissed) return;
        if (size && !ClassroomExpanded) Reveal(false);
        _idleTimer.Stop();
        AlignPetMenu();
        PetMenu.ShowPage(this, size, ClassroomExpanded, opener);
    }

    private void AlignPetMenu()
    {
        var diameter = BanbanClassroomWheel.Diameter * (ClassroomExpanded ? _wheelScale : 1);
        var screen = Screens.ScreenFromWindow(this) ?? Screens.Primary;
        if (screen is not null)
            diameter = Math.Min(diameter, Math.Min(screen.WorkingArea.Height, screen.WorkingArea.Width) / screen.Scaling);
        if (ClassroomExpanded)
        {
            var inset = _right ? Width - _wheelOffset.X - diameter : _wheelOffset.X;
            PetMenu.Align(_right, inset, diameter, Height - _wheelOffset.Y - diameter);
            return;
        }
        var petInset = _classroomBinding is not null || _docked ? RestWidth : Math.Max(68, 68 * Scale) + 58 * Scale + 8;
        PetMenu.Align(_right, petInset, diameter);
    }

    internal void ShowPet(bool userInitiated)
    {
        if (_shutdown) return;
        if (userInitiated) { CancelDeparture(); _preference = _preference with { Visible = true }; SavePreference(); }
        if (userInitiated && _inClass && _classroomBinding is null) Reveal(true);
        else ApplyPresence();
    }
    internal void HidePet()
    {
        SetClassroomExpanded(false); _holdTimer.Stop();
        _preference = _preference with { Visible = false };
        _engaged = _preparing = false;
        PetMenu.Hide(); SavePreference(); _captionTimer.Stop(); _idleTimer.Stop(); _departureFrames.Stop(); _captionButton.IsVisible = false; Hide(); Refresh();
    }
    internal void Suspend(bool value)
    {
        if (value) SetClassroomExpanded(false);
        _suspended = value;
        if (value) PetMenu.Hide();
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
        if (ClassroomExpanded) { ArrangeClassroomWheel(); Show(); Refresh(); return; }
        if (_dismissed)
        {
            if (_suspended || !_departureFrames.IsEnabled) FinishDeparture();
            return;
        }
        SetDocked(!_engaged);
        if (_suspended || !_preference.Visible || _classroomBinding is null && _inClass && !_engaged)
        {
            _idleTimer.Stop();
            _captionTimer.Stop(); _captionButton.IsVisible = false; Hide(); Refresh(); return;
        }
        Place(); Show(); Refresh();
    }

    private void Depart()
    {
        SetClassroomExpanded(false);
        // Voice dismissal lasts until the next wake; it never changes the user's visibility preference.
        if (_dismissed) return;
        _dismissed = true; _engaged = _preparing = false; _pressed = false; _state = "standby";
        _captionTimer.Stop(); _idleTimer.Stop(); _dockFrames.Stop();
        _talk.IsHitTestVisible = false;
        _captionButton.IsVisible = false; _pill.IsVisible = false; RefreshWaveform();
        PetMenu.Hide();
        if (!IsVisible || _suspended || !_preference.Visible || !_enabled || !_mascot.Animate) { FinishDeparture(); return; }
        _docked = false; _dock.Snap(0); ResizeSurface(FullWidth); ArrangeCompanion(_right); Refresh();
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
        if (IsDragging) { ArrangeCompanion(_right); return; }
        UpdateDocking();
    }
    private void UpdateDocking()
    {
        _dock.Retarget(_docked ? 1 : 0);
        if (IsVisible && !_suspended && _preference.Visible && (!_inClass || !_docked) && _mascot.Animate)
        {
            ResizeSurface(FullWidth);
            _dockLastFrame = Stopwatch.GetTimestamp(); _dockFrames.Start();
        }
        else FinishDocking();
        ArrangeCompanion(_right);
    }
    private void FinishDocking()
    {
        _dockFrames.Stop(); _dock.Snap(_docked ? 1 : 0);
        ResizeSurface(_docked ? RestWidth : FullWidth);
        ArrangeCompanion(_right);
    }
    private void ResizeSurface(double width)
    {
        if (ClassroomExpanded) { RefitClassroom(); return; }
        if (IsDragging) width = FullWidth;
        var screen = Screens.ScreenFromPoint(new PixelPoint(Position.X + (int)(Width * RenderScaling / 2), Position.Y + (int)(Height * RenderScaling / 2))) ?? Screens.Primary;
        var scale = screen?.Scaling ?? RenderScaling;
        var bottom = Position.Y + (int)Math.Ceiling(Height * scale);
        Width = screen is null ? width : Math.Min(Math.Ceiling(width * scale), screen.WorkingArea.Width) / scale;
        Height = screen is null ? CompanionHeight : Math.Min(Math.Ceiling(CompanionHeight * scale), screen.WorkingArea.Height) / scale;
        if (_positioned && screen is not null && !IsDragging)
            Position = new PixelPoint(_right ? screen.WorkingArea.Right - (int)Math.Ceiling(Width * scale) : screen.WorkingArea.X,
                Math.Clamp(bottom - (int)Math.Ceiling(Height * scale), screen.WorkingArea.Y,
                    Math.Max(screen.WorkingArea.Y, screen.WorkingArea.Bottom - (int)Math.Ceiling(Height * scale))));
    }
    internal void Shutdown()
    {
        if (_shutdown) return;
        SetClassroomExpanded(false); _holdTimer.Stop();
        _shutdown = true; PetMenu.Hide(); SavePreference(); _captionTimer.Stop(); _idleTimer.Stop(); _dockFrames.Stop(); _departureFrames.Stop(); _waveform.Dispose(); _mascot.Present("off", false, false); Close();
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
        if (ClassroomExpanded) { _classroomWheel.SetVoiceText(text); return; }
        if (_shutdown || _suspended || ClassroomExpanded || _docked || _dismissed || !IsVisible || string.IsNullOrWhiteSpace(text)) return;
        var value = string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        _caption.Text = value.Length > 72 ? value[..72] + "…" : value;
        AutomationProperties.SetHelpText(_captionButton, value);
        _captionButton.IsVisible = true;
        _captionTimer.Stop(); _captionTimer.Interval = TimeSpan.FromSeconds(transient ? 4 : 8); _captionTimer.Start();
    }

    private void Refresh()
    {
        _pill.IsVisible = !_dismissed && !ClassroomExpanded && (_classroomBinding is not null || !_docked);
        _label.Text = _state switch { "listening" => "我在听", "thinking" => "处理中", "speaking" => "正在说",
            "confirming" => "等您确认", "login" => "点击登录", "connecting" => "准备语音", "error" => "语音需重连",
            "off" => "语音已暂停", _ => "你好班班" };
        if (_classroomBinding is not null && (ClassroomExpanded || _docked || _state is "off" or "standby" or "login"))
            _label.Text = ClassroomExpanded ? "收起" : _classroomWheel.DockLabel;
        var listening = _state == "listening" && !ClassroomExpanded;
        if (ClassroomExpanded && _state is "listening" or "thinking" or "speaking" or "connecting" or "error")
            _classroomWheel.SetVoiceText(_state switch { "listening" => "班班在听", "thinking" => "正在处理", "speaking" => "班班正在说话", "connecting" => "正在连接语音", _ => "语音连接异常，可重试" });
        _label.IsVisible = !listening;
        _dot.IsVisible = !listening && (_classroomBinding is null || !_docked && !ClassroomExpanded);
        _waveform.IsVisible = listening;
        AutomationProperties.SetItemStatus(_talk, _label.Text);
        _dot.Background = DesktopStyle.Brush(_state is "error" ? "#C56B41" : _enabled ? "#3A91D7" : "#8A99AC");
        _pause.SetFace(_enabled ? "暂停语音" : "启用语音", _enabled ? "静音" : "开麦", _enabled ? "mic-off" : "mic");
        if (!IsVisible || _suspended) FinishDocking();
        _mascot.Present(_state, _enabled, IsVisible && !_suspended, _docked, _right);
        RefreshWaveform();
    }

    private void RefreshWaveform() => _waveform.SetListening(
        !_shutdown && !_dismissed && _state == "listening" && _enabled && !_docked && IsVisible && !_suspended, _mascot.Animate);

    private void Pressed(object? sender, PointerPressedEventArgs e)
    {
        if (!e.Pointer.IsPrimary) return;
        var properties = e.GetCurrentPoint(_talk).Properties;
        if (!properties.IsLeftButtonPressed)
        {
            if (properties.IsRightButtonPressed && !_pressed) _longPressed = _dragged = false;
            return;
        }
        _pressPoint = this.PointToScreen(e.GetPosition(this)); _pressPosition = Position;
        _pressed = true; _dragged = _longPressed = false; _doubleClick = e.ClickCount == 2;
        if (!_doubleClick && _classroomBinding is not null) _holdTimer.Start();
    }
    private void Moved(object? sender, PointerEventArgs e)
    {
        if (!_pressed || !e.Pointer.IsPrimary) return;
        var point = this.PointToScreen(e.GetPosition(this));
        var dx = point.X - _pressPoint.X; var dy = point.Y - _pressPoint.Y;
        if (!_dragged && Math.Abs(dx) + Math.Abs(dy) < 6 * RenderScaling) return;
        _holdTimer.Stop();
        _longPressed = false;
        if (ClassroomExpanded) { _dragged = true; Position = new PixelPoint(_pressPosition.X + dx, _pressPosition.Y + dy); return; }
        if (!_dragged)
        {
            var center = new Point(_mascot.Bounds.Width / 2, _mascot.Bounds.Height / 2);
            var before = _mascot.TranslatePoint(center, this)!.Value;
            _dragged = true; _dockFrames.Stop(); _dock.Snap(0);
            _captionTimer.Stop(); _captionButton.IsVisible = false;
            ResizeSurface(FullWidth); ArrangeCompanion(_right); UpdateLayout();
            var after = _mascot.TranslatePoint(center, this)!.Value;
            _pressPosition = new PixelPoint(_pressPosition.X + (int)Math.Round((before.X - after.X) * RenderScaling),
                _pressPosition.Y + (int)Math.Round((before.Y - after.Y) * RenderScaling));
            _mascot.Play("sway");
        }
        Position = new PixelPoint(_pressPosition.X + dx, _pressPosition.Y + dy);
    }
    private void Released(object? sender, PointerReleasedEventArgs e)
    {
        if (!e.Pointer.IsPrimary || !_pressed || e.InitialPressMouseButton != MouseButton.Left && e.Pointer.Type == PointerType.Mouse) return;
        _holdTimer.Stop();
        var dragging = IsDragging;
        _pressed = false;
        if (dragging) FinishDrag();
        else if (_longPressed) OpenPetMenu();
    }
    private void FinishDrag()
    {
        if (ClassroomExpanded)
        {
            var anchor = this.PointToScreen(new Point(Canvas.GetLeft(_talk)+_talk.Width/2, Canvas.GetTop(_talk)+_mascot.Height/2));
            var area = Screens.ScreenFromPoint(anchor) ?? Screens.ScreenFromWindow(this) ?? Screens.Primary;
            if (area is null) return;
            _right = anchor.X >= area.WorkingArea.X + area.WorkingArea.Width/2d;
            PositionClassroom(anchor,area);
            if (_wheelOrigin is { } origin)
            {
                var collapsedWidth = origin.Engaged ? FullWidth : RestWidth;
                var top = anchor.Y - (int)Math.Round((CompanionHeight - (130*Scale+36) + 65*Scale)*area.Scaling);
                _wheelOrigin = (Constrain(new PixelPoint(_right ? area.WorkingArea.Right : area.WorkingArea.X,top),
                    area.WorkingArea,new Size(collapsedWidth,CompanionHeight),area.Scaling),origin.Engaged);
            }
            return;
        }
        var center = this.PointToScreen(_mascot.TranslatePoint(new Point(_mascot.Bounds.Width / 2, _mascot.Bounds.Height / 2), this)!.Value);
        var screen = Screens.ScreenFromPoint(center) ?? Screens.Primary;
        if (screen is not null) _right = center.X >= screen.WorkingArea.X + screen.WorkingArea.Width / 2d;
        UpdateDocking(); Fit(snap: true); SavePreference(); _mascot.Play("settle");
    }
    private void MoveWithKeyboard(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Home) { ResetPosition(); e.Handled = true; return; }
        if (e.Key is Key.Left or Key.Right)
        {
            var screen = Screens.ScreenFromPoint(Position) ?? Screens.Primary;
            if (screen is not null)
            {
                _right = e.Key == Key.Right;
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
                var screen = Screens.ScreenFromPoint(new PixelPoint(_preference.X.Value, _preference.Y.Value));
                if (screen is null) { ResetPosition(); return; }
                var scale = screen.Scaling;
                var bottom = _preference.Bottom ?? _preference.Y.Value + (int)Math.Ceiling(SurfaceHeight * scale);
                Position = new PixelPoint(_preference.X.Value, bottom - (int)Math.Ceiling(Height * scale));
                _right = _preference.Right ?? Position.X + Width * scale / 2 >= screen.WorkingArea.X + screen.WorkingArea.Width / 2d;
                if (_preference.Vertical is { } vertical && double.IsFinite(vertical))
                    Position = new PixelPoint(Position.X, screen.WorkingArea.Y + (int)Math.Round(Math.Clamp(vertical, 0, 1)
                        * Math.Max(0, screen.WorkingArea.Height - Height * scale)));
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
        if (ClassroomExpanded && _wheelOrigin is { } origin)
        {
            var dpi = screen.Scaling;
            var right = screen.WorkingArea.Right;
            var bottom = screen.WorkingArea.Bottom - 20;
            _wheelOrigin = (new PixelPoint(right - (int)Math.Ceiling((origin.Engaged ? FullWidth : RestWidth) * dpi),
                bottom - (int)Math.Ceiling(CompanionHeight * dpi)), origin.Engaged);
            var anchor = new PixelPoint(right - (int)Math.Round(RestWidth * dpi / 2),
                bottom - (int)Math.Round((Math.Max(44, 130 * Scale + 36) - 65 * Scale) * dpi));
            PositionClassroom(anchor, screen);
            return;
        }
        Position = new PixelPoint(screen.WorkingArea.Right - (int)Math.Ceiling(Width * screen.Scaling),
            screen.WorkingArea.Bottom - (int)Math.Ceiling(Height * screen.Scaling) - 20);
        Fit(true); SavePreference();
    }
    private void ScreensChanged(object? sender, EventArgs e)
    {
        if (!_positioned) return;
        if (ClassroomExpanded) { RefitClassroom(); return; }
        var screen = Screens.ScreenFromPoint(Position);
        if (screen is null) { ResetPosition(); return; }
        if (_preference.Vertical is { } vertical && double.IsFinite(vertical))
            Position = new PixelPoint(Position.X, screen.WorkingArea.Y + (int)Math.Round(Math.Clamp(vertical, 0, 1)
                * Math.Max(0, screen.WorkingArea.Height - CompanionHeight * screen.Scaling)));
        Fit(true); SavePreference();
    }
    private void Fit(bool snap)
    {
        if (ClassroomExpanded)
        {
            var display = Screens.ScreenFromWindow(this) ?? Screens.Primary;
            if (display is not null) Position = Constrain(Position, display.WorkingArea, new Size(Width, Height), display.Scaling);
            ArrangeClassroomWheel(); return;
        }
        var screen = Screens.ScreenFromPoint(new PixelPoint(Position.X + (int)(Width * RenderScaling / 2), Position.Y + (int)(Height * RenderScaling / 2))) ?? Screens.Primary;
        if (screen is null) return;
        Width = Math.Min(Math.Ceiling((_docked && !_dockFrames.IsEnabled && !IsDragging ? RestWidth : FullWidth) * screen.Scaling), screen.WorkingArea.Width) / screen.Scaling;
        Height = Math.Min(Math.Ceiling(CompanionHeight * screen.Scaling), screen.WorkingArea.Height) / screen.Scaling;
        if (!IsDragging)
        {
            Position = Constrain(Position, screen.WorkingArea, new Size(Width, Height), screen.Scaling);
            var edge = screen.WorkingArea.Right - (int)Math.Ceiling(Width * screen.Scaling);
            if (snap || _docked) Position = new PixelPoint(_right ? edge : screen.WorkingArea.X, Position.Y);
        }
        ArrangeCompanion(_right);
    }
    internal static PixelPoint Constrain(PixelPoint position, PixelRect work, Size size, double scale) => new(
        Math.Clamp(position.X, work.X, Math.Max(work.X, work.Right - (int)Math.Ceiling(size.Width * scale))),
        Math.Clamp(position.Y, work.Y, Math.Max(work.Y, work.Bottom - (int)Math.Ceiling(size.Height * scale))));

    private void ArrangeCompanion(bool right)
    {
        if (ClassroomExpanded) { ArrangeClassroomWheel(); return; }
        _pill.IsVisible = !_dismissed && (_classroomBinding is not null || !_docked);
        RefreshWaveform();
        _mascot.Width = 116 * Scale; _mascot.Height = 130 * Scale;
        var peek = IsDragging || _classroomBinding is not null ? 0 : Math.Clamp(_dock.Value, 0, 1);
        _mascot.SetPeeking(peek, right);
        // Include the tilted artwork in the button without moving its centered content.
        var margin = 24 * Scale * peek;
        _talk.Width = Math.Max(_docked ? 44 : 124, 124 * Scale) + margin * 2;
        _talk.Height = Math.Max(44, 130 * Scale + 36);
        var inset = Math.Max(68, 68 * Scale);
        var center = right ? Width - inset + (inset + 4 * Scale) * peek : inset - (inset + 6 * Scale) * peek;
        if (_classroomBinding is not null) { _talk.Width = RestWidth; center = right ? Width - RestWidth/2 : RestWidth/2; }
        Canvas.SetLeft(_talk, center - _talk.Width / 2);
        Canvas.SetTop(_talk, Height - _talk.Height);
        _captionButton.MaxWidth = Math.Max(48, Math.Min(172, Width - CaptionOffset - 12));
        _captionButton.MinWidth = Math.Min(86, _captionButton.MaxWidth);
        _captionBubble.PointRight = right;
        Canvas.SetLeft(_captionButton, right ? double.NaN : CaptionOffset - 2);
        Canvas.SetRight(_captionButton, right ? CaptionOffset : double.NaN);
        ArrangeCaption();
    }
    private void ArrangeCaption() => Canvas.SetTop(_captionButton,
        Math.Max(2, Math.Min(Canvas.GetTop(_talk) + 8 * Scale, Height - _captionButton.Bounds.Height - 8)));
    private IntPtr HitTest(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message != 0x0084) return IntPtr.Zero; // WM_NCHITTEST: transparent space must not block the lesson behind it.
        var point = this.PointToClient(new PixelPoint(unchecked((short)(lParam.ToInt64() & 0xffff)), unchecked((short)((lParam.ToInt64() >> 16) & 0xffff))));
        if (ClassroomExpanded && ResizeGripContains(point)) return IntPtr.Zero;
        if (ClassroomExpanded && this.TranslatePoint(point,_classroomWheel) is { } local && _classroomWheel.ContainsInteractive(local)) return IntPtr.Zero;
        if (ClassroomExpanded && _cameraLens.IsVisible && this.TranslatePoint(point,_cameraLens) is { } lens && _cameraLens.ContainsInteractive(lens)) return IntPtr.Zero;
        if (!_dismissed && (_talk.Bounds.Contains(point) || _captionButton.IsVisible && _captionButton.Bounds.Contains(point))) return IntPtr.Zero;
        handled = true; return new IntPtr(-1);
    }

    private PetPreference LoadPreference()
    {
        try
        {
            var value = JsonSerializer.Deserialize<PetPreference>(File.ReadAllText(_preferencePath)) ?? new();
            return value with { SizePercent = Math.Clamp(value.SizePercent, 25, 150),
                WheelSizePercent = Math.Clamp(value.WheelSizePercent, MinWheelPercent, MaxWheelPercent) };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return new(); }
    }
    private void SavePreference()
    {
        if (_positioned && !ClassroomExpanded)
        {
            var screen = Screens.ScreenFromWindow(this) ?? Screens.Primary;
            _preference = _preference with { X = Position.X, Y = Position.Y, Right = _right,
                Bottom = Position.Y + (int)Math.Ceiling(Height * RenderScaling),
                Vertical = screen is null ? null : Math.Clamp((Position.Y - screen.WorkingArea.Y)
                    / Math.Max(1, screen.WorkingArea.Height - Height * screen.Scaling), 0, 1) };
        }
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_preferencePath)!);
            var temporary = _preferencePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(_preference), new UTF8Encoding(false));
            File.Move(temporary, _preferencePath, true);
            _sizeError.IsVisible = false;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            _sizeError.Text = "大小未能保存，请重试。"; _sizeError.IsVisible = true;
            AppLog.Error("Save Banban companion preference failed", error);
        }
    }
    private sealed record PetPreference(bool Visible = true, int? X = null, int? Y = null, int? Bottom = null,
        int SizePercent = DefaultSizePercent, bool? Right = null, double? Vertical = null, int WheelSizePercent = 100);
}

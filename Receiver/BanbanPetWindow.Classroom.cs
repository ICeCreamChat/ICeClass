using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Platform;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed partial class BanbanPetWindow
{
    private readonly BanbanClassroomWheel _classroomWheel = new();
    private readonly BanbanCameraLens _cameraLens = new();
    private Point _wheelOffset, _lensOffset;
    private readonly DispatcherTimer _holdTimer = new() { Interval = TimeSpan.FromMilliseconds(600) };
    private (PixelPoint Position, bool Engaged)? _wheelOrigin;
    private bool _longPressed;
    private double _wheelScale = 1, _companionScale = 1, _wheelPetTop;
    private readonly ReceiverConfig? _classroomBinding;
    internal CardQuizHost? ClassroomHost { get; private set; }
    internal bool ClassroomExpanded => _classroomWheel.IsVisible;

    private void InitializeClassroomWheel()
    {
        _layout.Children.Insert(0, _classroomWheel);
        _layout.Children.Insert(0, _cameraLens);
        _cameraLens.ActionRequested += command => ClassroomHost?.ActivateCompanionAction(command);
        _classroomWheel.ActionRequested += action =>
        {
            if (action.Action == "reload") OpenClassroomHost(reload: true);
            else if (action.Action == "voice") _startTalk();
            else ClassroomHost?.ActivateCompanionAction(action);
        };
        _classroomWheel.SurfaceChanged += ArrangeClassroomBrowser;
        Activated += (_, _) => _classroomWheel.RestorePendingFocus();
        _classroomWheel.MenuRequested += opener => OpenPetMenu(opener: opener);
        if (_classroomBinding is null) return;
        InitializeWheelResize();
        // Use the classroom control theme while the desktop outside the wheel stays transparent.
        Classes.Add("classroom-surface");
        SetClassroomPetName(false);
        _holdTimer.Tick += (_, _) =>
        {
            _holdTimer.Stop();
            if (!_pressed || _dragged || _shutdown || _suspended) return;
            // Commit on lift so a slow drag can still move the pet and cannot select a menu action.
            _longPressed = true;
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (PetMenu.IsOpen) return;
            if (e.Key == Key.F4) { SetClassroomExpanded(!ClassroomExpanded); e.Handled = true; }
            else if (ClassroomExpanded && e.Key == Key.Escape)
            {
                if (_cameraLens.Back()) { e.Handled = true; return; }
                if (_classroomWheel.DetailVisible) ClassroomHost?.ActivateCompanionAction(new("back"));
                else if (!_classroomWheel.BackFromSetup()) SetClassroomExpanded(false);
                e.Handled = true;
            }
            else if (ClassroomExpanded && !_classroomWheel.SetupVisible && !_classroomWheel.DetailVisible && _talk.IsKeyboardFocusWithin && e.Key is Key.Left or Key.Right or Key.Up or Key.Down)
            { _classroomWheel.FocusAction(null, Key.Home); e.Handled = true; }
        }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        PropertyChanged += (_, e) =>
        {
            if (e.Property == IsVisibleProperty || e.Property == WindowStateProperty)
                UpdateClassroomVisibility();
        };
        Closed += (_, _) => { _holdTimer.Stop(); ClassroomHost?.Dispose(); };
    }

    private void OpenClassroomHost(bool reload = false)
    {
        if (_classroomBinding is null) return;
        if (ClassroomHost is { } previous)
        {
            if (!reload) return;
            previous.Dispose(); _layout.Children.Remove(previous.Browser); UpdateCameraLens(null);
        }
        var host = new CardQuizHost(_classroomBinding);
        ClassroomHost = host;
        host.CompanionStateChanged += state =>
        {
            _classroomWheel.Update(state);
            UpdateCameraLens(ClassroomExpanded && IsVisible && WindowState != WindowState.Minimized &&
                state.Lesson.Phase == "collect" ? state.Preview : null);
            if (PetMenu.IsOpen) PetMenu.RefreshActions();
            if (!ClassroomExpanded && _docked) { _label.Text = _classroomWheel.DockLabel; SetClassroomPetName(false); }
        };
        host.PreviewFrame += _cameraLens.ShowFrame;
        host.PreviewPixels += _cameraLens.ShowPixels;
        host.FailedToLoad += message => { UpdateCameraLens(null); _classroomWheel.ShowError(message); };
        host.CollapseRequested += () => SetClassroomExpanded(false);
        host.Browser.FocusOutside += _ => { if (_classroomWheel.DetailVisible) _classroomWheel.FocusDetailBack(); else _talk.Focus(); };
        _layout.Children.Add(host.Browser);
        ArrangeClassroomBrowser();
        UpdateClassroomVisibility();
        _ = host.InitializeAsync();
    }

    private void UpdateClassroomVisibility()
    {
        var visible = ClassroomExpanded && IsVisible && WindowState != WindowState.Minimized;
        if (!visible) UpdateCameraLens(null);
        ClassroomHost?.SetVisible(visible);
    }

    private void UpdateCameraLens(CardQuizCameraPreview? view)
    {
        var before = _cameraLens.Footprint;
        var restoreFocus = view is null && _cameraLens.IsKeyboardFocusWithin;
        _cameraLens.Update(view);
        if (before != _cameraLens.Footprint && ClassroomExpanded)
            RefitClassroom();
        if (restoreFocus && ClassroomExpanded) _classroomWheel.FocusAction(null,Key.Home);
    }

    private void ArrangeClassroomBrowser()
    {
        if (ClassroomHost?.Browser is not { } browser) return;
        var detail = ClassroomExpanded && _classroomWheel.BrowserDetailVisible;
        // Keep the same camera document attached while switching tasks. Only its viewport changes.
        var body = _classroomWheel.BrowserDetailBounds;
        browser.Width = detail ? body.Width * _wheelScale : 1;
        browser.Height = detail ? body.Height * _wheelScale : 1;
        browser.SetContentScale(detail ? _wheelScale : 1);
        Canvas.SetLeft(browser, detail ? Canvas.GetLeft(_classroomWheel) + body.X * _wheelScale : 0);
        Canvas.SetTop(browser, detail ? Canvas.GetTop(_classroomWheel) + body.Y * _wheelScale : Height - 1);
        var entering = detail && !browser.Focusable;
        browser.IsHitTestVisible = browser.Focusable = detail;
        if (entering) browser.Focus();
    }

    internal void SetClassroomExpanded(bool expanded)
    {
        if (_shutdown || _suspended || _classroomBinding is null) return;
        if (expanded == ClassroomExpanded) { if (expanded) Activate(); return; }
        _holdTimer.Stop();
        if (expanded)
        {
            CancelDeparture();
            UpdateLayout();
            var center = _mascot.TranslatePoint(new Point(_mascot.Bounds.Width / 2, _mascot.Bounds.Height / 2), this) ?? new Point(Width / 2, Height / 2);
            var anchor = this.PointToScreen(center);
            _wheelOrigin = (Position, _engaged);
            _classroomWheel.IsVisible = true; _engaged = true; _docked = false;
            _resizeGrip.IsVisible = true;
            _dockFrames.Stop(); _dock.Snap(0); _captionTimer.Stop(); _captionButton.IsVisible = false; _idleTimer.Stop();
            var screen = Screens.ScreenFromPoint(anchor) ?? Screens.Primary;
            if (screen is not null) PositionClassroom(anchor,screen);
            Show(); Refresh();
            OpenClassroomHost(); UpdateClassroomVisibility(); Activate();
            SetClassroomPetName(true);
            if (_classroomWheel.BrowserDetailVisible) ClassroomHost?.Browser.Focus();
            else if (_classroomWheel.DetailVisible) _classroomWheel.FocusDetailBack();
            else { _talk.Focus(); _classroomWheel.FocusFirstWhenReady(); }
        }
        else
        {
            EndWheelDrag();
            _resizeGrip.IsVisible = false;
            PetMenu.Hide();
            _classroomWheel.ResetView();
            if (_classroomWheel.DetailVisible) ClassroomHost?.ActivateCompanionAction(new("dismiss"));
            _classroomWheel.IsVisible = false;
            UpdateClassroomVisibility();
            SetClassroomPetName(false);
            if (_wheelOrigin is { } origin) { _engaged = origin.Engaged; Position = origin.Position; }
            _wheelOrigin = null; _docked = !_engaged; _dock.Snap(_docked ? 1 : 0);
            Width = _docked ? RestWidth : FullWidth; Height = CompanionHeight;
            ArrangeCompanion(_right); Fit(true); Refresh(); SavePreference();
            ArrangeClassroomBrowser();
            _talk.Focus();
            if (_engaged) _idleTimer.Start();
        }
    }

    private void SetClassroomPetName(bool expanded)
    {
        AutomationProperties.SetName(_talk, expanded ? "收起班班课堂" : "班班，展开课堂");
        AutomationProperties.SetHelpText(_talk, (expanded ? "轻点或按 F4 收起课堂并暂停收答。" :
            _classroomWheel.DockLabel + "。轻点或按 F4 展开课堂。") +
            "长按后松手、右键或 Shift+F10 打开更多操作。拖动移动班班。");
        ToolTip.SetTip(_talk, expanded ? "轻点收起 · 长按更多" : "轻点进课堂 · 长按更多");
    }

    private void PositionClassroom(PixelPoint anchor, Screen screen, PixelPoint? wheelCenter = null)
    {
        var placement = FitClassroom(anchor, screen.WorkingArea, screen.Scaling, RestWidth, Scale, _right,
            _cameraLens.Footprint, wheelCenter, _preference.WheelSizePercent);
        Width = placement.Size.Width; Height = placement.Size.Height; Position = placement.Position;
        _wheelScale = placement.Scale; _companionScale = placement.CompanionScale; _wheelPetTop = placement.PetTop;
        _wheelOffset = placement.Wheel; _lensOffset = placement.Lens;
        _cameraLens.SetFootprint(placement.LensSize);
        ArrangeClassroomWheel();
    }

    private PixelPoint WheelCenterOnScreen() => this.PointToScreen(_wheelOffset +
        new Vector(BanbanClassroomWheel.Diameter / 2, BanbanClassroomWheel.Diameter / 2) * _wheelScale);

    private void RefitClassroom(PixelPoint? fixedCenter = null)
    {
        if (!ClassroomExpanded) return;
        var center = new Point(Canvas.GetLeft(_talk) + _talk.Width / 2, Canvas.GetTop(_talk) + _mascot.Height / 2);
        var anchor = this.PointToScreen(center);
        var screen = Screens.ScreenFromPoint(anchor) ?? Screens.Primary;
        if (screen is not null) PositionClassroom(anchor, screen, fixedCenter ?? WheelCenterOnScreen());
    }

    internal static (PixelPoint Position, Size Size, double Scale, double PetTop, Point Wheel, Point Lens, double CompanionScale, Size LensSize) FitClassroom(
        PixelPoint anchor, PixelRect work, double dpi, double restWidth, double petScale, bool right,
        Size lens = default, PixelPoint? wheelCenter = null, int wheelSizePercent = 100)
    {
        const double gap = 8;
        var wheelZoom = Math.Clamp(wheelSizePercent, MinWheelPercent, MaxWheelPercent) / 100d;
        var diameter = BanbanClassroomWheel.Diameter * wheelZoom;
        var hasLens = lens.Height > 0;
        var video = hasLens ? BanbanCameraLens.VideoSize * wheelZoom : default;
        var toolbar = hasLens ? Math.Min(BanbanCameraLens.ToolbarHeight, work.Height / dpi / 2) : 0;
        // Reserve space for the expanded video even when folded so it can reopen at the same center.
        var overhang = Math.Max(0, (video.Width - diameter) / 2);
        var fitWidth = diameter + overhang + Math.Max(restWidth, overhang);
        var fitHeight = diameter + (hasLens ? gap + video.Height : 0);
        var scale = Math.Min(1, Math.Min(work.Width / (dpi * fitWidth), (work.Height / dpi - toolbar) / fitHeight));
        var expanded = new Size(video.Width * scale, video.Height * scale + toolbar);
        var dock = BanbanCameraLens.DockSize;
        var camera = lens == dock ? dock * Math.Min(1, Math.Min(expanded.Width, expanded.Height) / dock.Width) : expanded;
        var disc = diameter * scale;
        var companionWidth = restWidth * scale;
        // Use disc-local coordinates so a wider lens can extend on either side of the wheel.
        var lensBounds = new Rect((disc - camera.Width) / 2, -gap * scale - camera.Height, camera.Width, camera.Height);
        var row = new Rect(right ? 0 : -companionWidth, 0, disc + companionWidth, disc);
        var bounds = hasLens ? row.Union(lensBounds) : row;
        // The host is positioned in physical pixels. Reserve the last fractional pixel for the lens and disc.
        var size = new Size(Math.Min(work.Width, Math.Ceiling(bounds.Width * dpi)) / dpi,
            Math.Min(work.Height, Math.Ceiling(bounds.Height * dpi)) / dpi);
        var wheel = new Point(-bounds.X, -bounds.Y);
        var lensOffset = new Point(wheel.X + lensBounds.X, 0);

        var petCenterX = wheel.X + (right ? disc + companionWidth / 2 : -companionWidth / 2);
        var left = wheelCenter is { } center ? center.X - (int)Math.Round((wheel.X + disc / 2) * dpi)
            : anchor.X - (int)Math.Round(petCenterX * dpi);
        var position = Constrain(new PixelPoint(left,
            (wheelCenter?.Y ?? anchor.Y) - (int)Math.Round((wheel.Y + disc / 2) * dpi)), work, size, dpi);
        var petHeight = Math.Max(44, 130 * petScale) * scale;
        var petTop = Math.Clamp((anchor.Y - position.Y) / dpi - 65 * petScale * scale,
            wheel.Y, wheel.Y + Math.Max(0, disc - petHeight));
        return (position, size, scale * wheelZoom, petTop, wheel, lensOffset, scale, camera);
    }

    private void ArrangeClassroomWheel()
    {
        if (!ClassroomExpanded) return;
        var scale = Scale*_companionScale;
        _pill.IsVisible = false; _captionButton.IsVisible = false;
        _mascot.Width = 116 * scale; _mascot.Height = 130 * scale; _mascot.SetPeeking(0, _right);
        _talk.Width = RestWidth*_companionScale; _talk.Height = Math.Max(44,130*Scale)*_companionScale;
        Canvas.SetLeft(_talk, _wheelOffset.X + (_right ? BanbanClassroomWheel.Diameter * _wheelScale : -_talk.Width));
        Canvas.SetTop(_talk,_wheelPetTop);
        _classroomWheel.RenderTransformOrigin = RelativePoint.TopLeft;
        _classroomWheel.RenderTransform = _wheelScale == 1 ? null : new ScaleTransform(_wheelScale,_wheelScale);
        Canvas.SetLeft(_classroomWheel,_wheelOffset.X); Canvas.SetTop(_classroomWheel,_wheelOffset.Y);
        Canvas.SetLeft(_cameraLens,_lensOffset.X); Canvas.SetTop(_cameraLens,_lensOffset.Y);
        ArrangeResizeGrip();
        ArrangeClassroomBrowser();
        if (PetMenu.IsOpen) AlignPetMenu();
    }
}

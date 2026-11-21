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
    private readonly DispatcherTimer _holdTimer = new() { Interval = TimeSpan.FromMilliseconds(600) };
    private (PixelPoint Position, bool Engaged)? _wheelOrigin;
    private bool _longPressed;
    private double _wheelScale = 1, _wheelPetTop;
    private readonly ReceiverConfig? _classroomBinding;
    internal CardQuizHost? ClassroomHost { get; private set; }
    internal bool ClassroomExpanded => _classroomWheel.IsVisible;

    private void InitializeClassroomWheel()
    {
        _layout.Children.Insert(0, _classroomWheel);
        _classroomWheel.ActionRequested += action =>
        {
            if (action.Action == "reload") OpenClassroomHost(reload: true);
            else if (action.Action == "voice") _startTalk();
            else ClassroomHost?.ActivateCompanionAction(action);
        };
        _classroomWheel.SetupViewChanged += ArrangeClassroomWheel;
        if (_classroomBinding is null) return;
        // Use the classroom control theme while the desktop outside the wheel stays transparent.
        Classes.Add("classroom-surface");
        _talk.ContextMenu!.Items.Insert(0, Item("课堂功能", () => SetClassroomExpanded(true)));
        SetClassroomPetName(false);
        _holdTimer.Tick += (_, _) =>
        {
            _holdTimer.Stop();
            if (!_pressed || _dragged || _shutdown || _suspended) return;
            _longPressed = true; SetClassroomExpanded(!ClassroomExpanded);
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (e.Key == Key.F4) { SetClassroomExpanded(!ClassroomExpanded); e.Handled = true; }
            else if (ClassroomExpanded && e.Key == Key.Escape)
            {
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
            previous.Dispose(); _layout.Children.Remove(previous.Browser);
        }
        var host = new CardQuizHost(_classroomBinding);
        ClassroomHost = host;
        host.CompanionStateChanged += state =>
        {
            _classroomWheel.Update(state);
            if (!ClassroomExpanded && _docked) { _label.Text = _classroomWheel.DockLabel; SetClassroomPetName(false); }
        };
        host.FailedToLoad += _classroomWheel.ShowError;
        host.CollapseRequested += () => SetClassroomExpanded(false);
        host.Browser.FocusOutside += _ => _talk.Focus();
        _layout.Children.Add(host.Browser);
        ArrangeClassroomBrowser();
        UpdateClassroomVisibility();
        _ = host.InitializeAsync();
    }

    private void UpdateClassroomVisibility() =>
        ClassroomHost?.SetVisible(ClassroomExpanded && IsVisible && WindowState != WindowState.Minimized);

    private void ArrangeClassroomBrowser()
    {
        if (ClassroomHost?.Browser is not { } browser) return;
        var detail = ClassroomExpanded && _classroomWheel.DetailVisible;
        // Keep the same camera document attached while switching tasks. Only its viewport changes.
        browser.Width = detail ? (BanbanClassroomWheel.Diameter - 32)*_wheelScale : 1;
        browser.Height = detail ? (BanbanClassroomWheel.SurfaceHeight - 32)*_wheelScale : 1;
        Canvas.SetLeft(browser, detail ? Canvas.GetLeft(_classroomWheel)+16*_wheelScale : 0);
        Canvas.SetTop(browser, detail ? Canvas.GetTop(_classroomWheel)+16*_wheelScale : Height - 1);
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
            _dockFrames.Stop(); _dock.Snap(0); _captionTimer.Stop(); _captionButton.IsVisible = false; _idleTimer.Stop();
            var screen = Screens.ScreenFromPoint(anchor) ?? Screens.Primary;
            if (screen is not null) PositionClassroom(anchor,screen);
            Show(); Refresh();
            OpenClassroomHost(); UpdateClassroomVisibility(); Activate();
            SetClassroomPetName(true);
            if (_classroomWheel.DetailVisible) ClassroomHost?.Browser.Focus();
            else { _talk.Focus(); _classroomWheel.FocusFirstWhenReady(); }
        }
        else
        {
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
        AutomationProperties.SetHelpText(_talk, expanded ? "收起时暂停收答。按 F4 收起，按方向键选择课堂功能。" :
            _classroomWheel.DockLabel+"。单击或按 F4 展开课堂。拖动贴边，上下键移动，左右键切换停靠边。");
        ToolTip.SetTip(_talk, expanded ? "收起课堂 · F4" : "单击展开课堂 · 拖动移动");
    }

    private void PositionClassroom(PixelPoint anchor,Screen screen)
    {
        var placement = FitClassroom(anchor,screen.WorkingArea,screen.Scaling,RestWidth,Scale,_right);
        Width = placement.Size.Width; Height = placement.Size.Height; Position = placement.Position;
        _wheelScale = placement.Scale; _wheelPetTop = placement.PetTop;
        ArrangeClassroomWheel();
    }

    internal static (PixelPoint Position, Size Size, double Scale, double PetTop) FitClassroom(
        PixelPoint anchor, PixelRect work, double dpi, double restWidth, double petScale, bool right)
    {
        var scale = Math.Min(1,Math.Min(work.Height/dpi/BanbanClassroomWheel.SurfaceHeight,
            work.Width/dpi/(BanbanClassroomWheel.Diameter+restWidth)));
        var size = new Size((BanbanClassroomWheel.Diameter+restWidth)*scale, BanbanClassroomWheel.SurfaceHeight*scale);
        var center = right ? size.Width-restWidth*scale/2 : restWidth*scale/2;
        var position = Constrain(new PixelPoint(anchor.X-(int)Math.Round(center*dpi),anchor.Y-(int)Math.Round(size.Height*dpi/2)),work,size,dpi);
        var top = Math.Clamp((anchor.Y-position.Y)/dpi-65*petScale*scale,0,Math.Max(0,size.Height-(130*petScale+36)*scale));
        return (position,size,scale,top);
    }

    private void ArrangeClassroomWheel()
    {
        if (!ClassroomExpanded) return;
        var scale = Scale*_wheelScale;
        _pill.IsVisible = true; _captionButton.IsVisible = false;
        _mascot.Width = 116 * scale; _mascot.Height = 130 * scale; _mascot.SetPeeking(0, _right);
        _talk.Width = RestWidth*_wheelScale; _talk.Height = (130*Scale+36)*_wheelScale;
        Canvas.SetLeft(_talk,_right ? Width-_talk.Width : 0); Canvas.SetTop(_talk,_wheelPetTop);
        _classroomWheel.RenderTransformOrigin = RelativePoint.TopLeft;
        _classroomWheel.RenderTransform = _wheelScale == 1 ? null : new ScaleTransform(_wheelScale,_wheelScale);
        Canvas.SetLeft(_classroomWheel,_right ? 0 : _talk.Width); Canvas.SetTop(_classroomWheel,0);
        ArrangeClassroomBrowser();
    }
}

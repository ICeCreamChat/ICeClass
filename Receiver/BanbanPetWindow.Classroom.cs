using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed partial class BanbanPetWindow
{
    private readonly BanbanClassroomWheel _classroomWheel = new();
    private readonly DispatcherTimer _holdTimer = new() { Interval = TimeSpan.FromMilliseconds(600) };
    private (PixelPoint Position, bool Engaged)? _wheelOrigin;
    private bool _longPressed;
    internal event Action? ClassroomRequested;
    internal event Action<string>? ClassroomActionRequested;
    internal bool ClassroomExpanded => _classroomWheel.IsVisible;

    private void InitializeClassroomWheel()
    {
        _layout.Children.Insert(0, _classroomWheel);
        _classroomWheel.ActionRequested += action => ClassroomActionRequested?.Invoke(action);
        _talk.ContextMenu!.Items.Insert(0, Item("课堂功能", () => SetClassroomExpanded(true)));
        AutomationProperties.SetHelpText(_talk, "单击说话，双击打开对话，长按或 F4 展开课堂功能。拖动贴边，上下键移动，左右键切换停靠边，Home 复位。");
        ToolTip.SetTip(_talk, "单击说话 · 双击对话 · 长按课堂功能 · 拖动移动");
        _talk.ContextRequested += (sender, e) => { if (_longPressed && e.TryGetPosition(_talk, out _)) e.Handled = true; };
        _holdTimer.Tick += (_, _) =>
        {
            _holdTimer.Stop();
            if (!_pressed || _dragged || _shutdown || _suspended) return;
            _longPressed = true; SetClassroomExpanded(!ClassroomExpanded);
        };
        AddHandler(KeyDownEvent, (_, e) =>
        {
            if (e.Key == Key.F4) { SetClassroomExpanded(!ClassroomExpanded); e.Handled = true; }
            else if (ClassroomExpanded && e.Key == Key.Escape) { SetClassroomExpanded(false); e.Handled = true; }
            else if (ClassroomExpanded && _talk.IsKeyboardFocusWithin && e.Key is Key.Left or Key.Right or Key.Up or Key.Down)
            { _classroomWheel.FocusAction(null, Key.Home); e.Handled = true; }
        }, Avalonia.Interactivity.RoutingStrategies.Tunnel);
        Closed += (_, _) => _holdTimer.Stop();
    }

    internal void SetClassroomState(CardQuizWheelState state) => _classroomWheel.Update(state);
    internal void SetClassroomError(string message) => _classroomWheel.ShowError(message);

    internal void SetClassroomExpanded(bool expanded)
    {
        if (_shutdown || _suspended || expanded == ClassroomExpanded) return;
        _holdTimer.Stop();
        if (expanded)
        {
            CancelDeparture();
            var center = _mascot.TranslatePoint(new Point(_mascot.Bounds.Width / 2, _mascot.Bounds.Height / 2), this) ?? new Point(Width / 2, Height / 2);
            var anchor = this.PointToScreen(center);
            _wheelOrigin = (Position, _engaged);
            _classroomWheel.IsVisible = true; _engaged = true; _docked = false;
            _dockFrames.Stop(); _dock.Snap(0); _captionTimer.Stop(); _captionButton.IsVisible = false; _idleTimer.Stop();
            Width = BanbanClassroomWheel.Diameter; Height = BanbanClassroomWheel.SurfaceHeight;
            var screen = Screens.ScreenFromPoint(anchor) ?? Screens.Primary;
            Position = new PixelPoint(anchor.X - (int)(Width * RenderScaling / 2), anchor.Y - (int)(BanbanClassroomWheel.Diameter * RenderScaling / 2));
            if (screen is not null) Position = Constrain(Position, screen.WorkingArea, new Size(Width, Height), screen.Scaling);
            ArrangeClassroomWheel(); Show(); Refresh();
            ClassroomRequested?.Invoke(); Activate(); _talk.Focus();
        }
        else
        {
            _classroomWheel.IsVisible = false;
            if (_wheelOrigin is { } origin) { _engaged = origin.Engaged; Position = origin.Position; }
            _wheelOrigin = null; _docked = !_engaged; _dock.Snap(_docked ? 1 : 0);
            Width = _docked ? RestWidth : FullWidth; Height = CompanionHeight;
            ArrangeCompanion(_right); Fit(true); Refresh();
            _talk.Focus();
            if (_engaged) _idleTimer.Start();
        }
    }

    private void ArrangeClassroomWheel()
    {
        var scale = Math.Min(Scale, .8);
        _pill.IsVisible = false; _captionButton.IsVisible = false;
        _mascot.Width = 116 * scale; _mascot.Height = 130 * scale; _mascot.SetPeeking(0, _right);
        _talk.Width = Math.Max(80, 124 * scale); _talk.Height = Math.Max(60, 130 * scale);
        Canvas.SetLeft(_talk, (BanbanClassroomWheel.Diameter - _talk.Width) / 2);
        Canvas.SetTop(_talk, (BanbanClassroomWheel.Diameter - _talk.Height) / 2);
    }
}

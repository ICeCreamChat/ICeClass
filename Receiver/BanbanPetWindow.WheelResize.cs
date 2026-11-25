using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed partial class BanbanPetWindow
{
    private const int MinWheelPercent = 80, MaxWheelPercent = 200;
    private const double GripSize = 44;
    private readonly Border _resizeGrip = new() { Name = "ClassroomResizeGrip", IsVisible = false,
        Focusable = true, Width = GripSize, Height = GripSize, Background = Brushes.Transparent,
        Clip = new EllipseGeometry(new Rect(0, 0, GripSize, GripSize)) };
    private readonly Cursor _resizeLeft = new(StandardCursorType.TopLeftCorner);
    private readonly Cursor _resizeRight = new(StandardCursorType.TopRightCorner);
    private sealed record WheelDrag(IPointer Pointer, PixelPoint Center, double StartRadius, int StartPercent, double Dpi);
    private WheelDrag? _wheelDrag;
    private bool _wheelDragMoved;

    private void InitializeWheelResize()
    {
        var contrast = DesktopStyle.HighContrastEnabled();
        var ink = contrast ? Brushes.Black : BanbanClassroomStyle.ActionBlue;
        var face = new Border { Width = 24, Height = 24, CornerRadius = new CornerRadius(12),
            BorderThickness = new Thickness(1), BorderBrush = contrast ? Brushes.Black : BanbanClassroomStyle.ToolEdge,
            Background = contrast ? Brushes.White : BanbanClassroomStyle.ToolFill,
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
            Child = BanbanClassroomStyle.Glyph("maximize-2", 13, ink) };
        _resizeGrip.Child = face;
        _resizeGrip.GotFocus += (_, _) => face.BorderBrush = ink;
        _resizeGrip.LostFocus += (_, _) => face.BorderBrush = contrast ? Brushes.Black : BanbanClassroomStyle.ToolEdge;
        AutomationProperties.SetName(_resizeGrip, "课堂圆盘大小");
        AutomationProperties.SetHelpText(_resizeGrip, "向外拖动放大，向内拖动缩小。方向键调整，Home 恢复 100%。");
        ToolTip.SetTip(_resizeGrip, "拖动调整圆盘大小");
        AutomationProperties.SetItemStatus(_resizeGrip, $"{_preference.WheelSizePercent}%");
        // Keep the entire sector clickable wherever the grip's touch area meets the wheel.
        _layout.Children.Insert(0, _resizeGrip);
        AddHandler(PointerPressedEvent, StartWheelDrag, RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerMovedEvent, MoveWheelDrag, RoutingStrategies.Tunnel, handledEventsToo: true);
        AddHandler(PointerReleasedEvent, (_, e) =>
        {
            if (_wheelDrag?.Pointer != e.Pointer) return;
            MoveWheelDrag(this, e);
            e.Handled |= _wheelDragMoved || e.Pointer.Captured == _classroomWheel;
            EndWheelDrag();
        }, RoutingStrategies.Tunnel, handledEventsToo: true);
        _classroomWheel.PointerCaptureLost += (_, e) =>
        {
            if (e.Source == _classroomWheel && _wheelDrag?.Pointer == e.Pointer) EndWheelDrag();
        };
        Deactivated += (_, _) => EndWheelDrag();
        _resizeGrip.KeyDown += (_, e) =>
        {
            var size = _preference.WheelSizePercent;
            switch (e.Key)
            {
                case Key.Left: case Key.Down: size -= 10; break;
                case Key.Right: case Key.Up: size += 10; break;
                case Key.Home: size = 100; break;
                default: return;
            }
            if (SetWheelSize(size, WheelCenterOnScreen())) SavePreference();
            e.Handled = true;
        };
    }

    private void ArrangeResizeGrip()
    {
        var diameter = BanbanClassroomWheel.Diameter * _wheelScale;
        // The grip sits tangent to the wheel on the side facing the classroom, clear of the sectors.
        var radius = diameter / 2;
        var inset = Math.Max(Math.Min(GripSize / 2, radius),
            radius - (radius - BanbanClassroomStyle.RimInset * _wheelScale + 12) / Math.Sqrt(2));
        Canvas.SetLeft(_resizeGrip, _wheelOffset.X + (_right ? inset : diameter - inset) - GripSize / 2);
        Canvas.SetTop(_resizeGrip, _wheelOffset.Y + inset - GripSize / 2);
        _resizeGrip.Cursor = _right ? _resizeLeft : _resizeRight;
        if (_resizeGrip.Child is Border { Child: { } glyph })
            glyph.RenderTransform = _right ? MirrorResizeGlyph : null;
    }

    private static readonly ScaleTransform MirrorResizeGlyph = new(-1, 1);

    private bool ResizeGripContains(Point windowPoint)
    {
        Vector offset = windowPoint - _resizeGrip.Bounds.Center;
        return _resizeGrip.IsVisible && offset.SquaredLength <= GripSize * GripSize / 4;
    }

    private void StartWheelDrag(object? sender, PointerPressedEventArgs e)
    {
        if (!ClassroomExpanded || PetMenu.IsOpen || !e.Pointer.IsPrimary ||
            !e.GetCurrentPoint(this).Properties.IsLeftButtonPressed) return;
        var point = e.GetPosition(this);
        const double radius = BanbanClassroomWheel.Diameter / 2;
        var local = e.GetPosition(_classroomWheel);
        var grip = !_classroomWheel.ContainsInteractive(local) && ResizeGripContains(point);
        var distance = new Vector(local.X - radius, local.Y - radius).Length;
        if (!grip && (!_classroomWheel.ContainsInteractive(local) ||
            (radius - distance) * _wheelScale > (e.Pointer.Type == PointerType.Mouse ? 12 : 22))) return;
        var center = WheelCenterOnScreen();
        var start = this.PointToScreen(point);
        var startRadius = new Vector(start.X - center.X, start.Y - center.Y).Length;
        if (startRadius < 1) return;
        _wheelDrag = new(e.Pointer, center, startRadius, _preference.WheelSizePercent, RenderScaling);
        _wheelDragMoved = false;
        // A tap inside a sector still belongs to that sector. Take capture only after a radial drag.
        if (grip || distance >= radius - BanbanClassroomStyle.RimInset - BanbanClassroomStyle.SectorMargin)
        {
            if (grip) _resizeGrip.Focus();
            e.Pointer.Capture(_classroomWheel);
            e.Handled = true;
        }
    }

    private void MoveWheelDrag(object? sender, PointerEventArgs e)
    {
        if (_wheelDrag is not { } drag || drag.Pointer != e.Pointer) return;
        var point = this.PointToScreen(e.GetPosition(this));
        // Work in screen pixels against the original center: moving/resizing the host must not feed back into the gesture.
        var radius = new Vector(point.X - drag.Center.X, point.Y - drag.Center.Y).Length;
        if (!_wheelDragMoved && Math.Abs(radius - drag.StartRadius) < 5 * drag.Dpi) return;
        _wheelDragMoved = true;
        if (e.Pointer.Captured != _classroomWheel) e.Pointer.Capture(_classroomWheel);
        SetWheelSize((int)Math.Round(drag.StartPercent * radius / drag.StartRadius), drag.Center);
        e.Handled = true;
    }

    private bool SetWheelSize(int percent, PixelPoint center)
    {
        percent = Math.Clamp(percent, MinWheelPercent, MaxWheelPercent);
        if (_preference.WheelSizePercent == percent) return false;
        _preference = _preference with { WheelSizePercent = percent };
        AutomationProperties.SetItemStatus(_resizeGrip, $"{percent}%");
        RefitClassroom(center);
        return true;
    }

    private void EndWheelDrag()
    {
        if (_wheelDrag is not { } drag) return;
        _wheelDrag = null;
        if (drag.Pointer.Captured == _classroomWheel) drag.Pointer.Capture(null);
        if (_wheelDragMoved) SavePreference();
        _wheelDragMoved = false;
    }
}

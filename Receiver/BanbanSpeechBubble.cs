using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

/// <summary>The companion's speech surface; the surrounding button owns input and accessibility.</summary>
internal sealed class BanbanSpeechBubble : Decorator
{
    private const double Tail = 8, HorizontalInset = 15, VerticalInset = 12;
    private static readonly IBrush Paper = DesktopStyle.Brush("#FFFEFB");
    private static readonly IBrush Hover = DesktopStyle.Brush("#F7FAFE");
    private static readonly IBrush Pressed = DesktopStyle.Brush("#EDF4FB");
    private static readonly IPen Outline = new Pen(DesktopStyle.Brush("#D5DFE9"), .8, lineJoin: PenLineJoin.Round);
    private static readonly IPen FocusOutline = new Pen(DesktopStyle.Brush("#548BB8"), 1.5, lineJoin: PenLineJoin.Round);
    private bool _pointRight = true, _hovered, _pressed, _focused;

    internal bool PointRight
    {
        get => _pointRight;
        set
        {
            if (_pointRight == value) return;
            _pointRight = value; InvalidateArrange(); InvalidateVisual();
        }
    }

    internal void SetInteraction(bool hovered, bool pressed, bool focused)
    {
        if ((_hovered, _pressed, _focused) == (hovered, pressed, focused)) return;
        (_hovered, _pressed, _focused) = (hovered, pressed, focused);
        InvalidateVisual();
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        Child?.Measure(new Size(Math.Max(0, availableSize.Width - HorizontalInset * 2 - Tail),
            Math.Max(0, availableSize.Height - VerticalInset * 2)));
        var content = Child?.DesiredSize ?? default;
        return new Size(content.Width + HorizontalInset * 2 + Tail, Math.Max(44, content.Height + VerticalInset * 2));
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        Child?.Arrange(new Rect(HorizontalInset + (_pointRight ? 0 : Tail), VerticalInset,
            Math.Max(0, finalSize.Width - HorizontalInset * 2 - Tail), Math.Max(0, finalSize.Height - VerticalInset * 2)));
        return finalSize;
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        var width = Bounds.Width; var height = Bounds.Height;
        if (width < 38 || height < 36) return;
        const double left = 1, top = 1, radius = 14, lowerRadius = 9;
        var right = width - Tail - 1; var bottom = height - 1;
        var neck = Math.Min(26, bottom - 16);
        Point P(double x, double y) => new(_pointRight ? x : width - x, y);
        var geometry = new StreamGeometry();
        using (var path = geometry.Open())
        {
            path.BeginFigure(P(left + radius, top), true);
            path.LineTo(P(right - radius, top));
            path.CubicBezierTo(P(right - 5, top), P(right, top + 5), P(right, top + radius));
            path.LineTo(P(right, neck - 6));
            // One continuous contour keeps the small curved tail free of overlapping borders.
            path.CubicBezierTo(P(right, neck + 1), P(right + 3, neck + 5), P(right + Tail, neck + 7));
            path.CubicBezierTo(P(right + 4, neck + 9), P(right + 1, neck + 8), P(right, neck + 6));
            path.LineTo(P(right, bottom - lowerRadius));
            path.CubicBezierTo(P(right, bottom - 3), P(right - 3, bottom), P(right - lowerRadius, bottom));
            path.LineTo(P(left + radius, bottom));
            path.CubicBezierTo(P(left + 5, bottom), P(left, bottom - 5), P(left, bottom - radius));
            path.LineTo(P(left, top + radius));
            path.CubicBezierTo(P(left, top + 5), P(left + 5, top), P(left + radius, top));
            path.EndFigure(true);
        }
        context.DrawGeometry(_pressed ? Pressed : _hovered ? Hover : Paper, _focused ? FocusOutline : Outline, geometry);
    }
}

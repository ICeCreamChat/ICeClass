using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// Static tint and one soft shadow keep the two capsules legible without a
// capture session, a second window or a continuously repainted backdrop.
internal sealed class IslandGlassBackdrop : Panel, IDisposable
{
    private readonly ClassroomIslandRibbon _ribbon;
    private readonly Border[] _panes = [new(), new()];
    private bool _light = true, _continuous;
    internal string DiagnosticState => $"浮岛玻璃：启用={IsVisible}；轻量静态材质；背景采集=关闭；实时折射=关闭；模糊窗口=0\n";

    public IslandGlassBackdrop(ClassroomIslandRibbon ribbon)
    {
        _ribbon = ribbon;
        IsHitTestVisible = false;
        foreach (var pane in _panes)
        {
            pane.CornerRadius = new CornerRadius(24);
            pane.BorderThickness = new Thickness(1);
            pane.BoxShadow = new BoxShadows(new BoxShadow { OffsetY = 2, Blur = 7, Color = Color.Parse("#20163D67") });
            Children.Add(pane);
        }
        SetMaterial();
        ribbon.MaterialGeometryChanged += GeometryChanged;
    }

    public void Apply(bool glass, bool light, bool continuous)
    {
        if (IsVisible == glass && _light == light && _continuous == continuous) return;
        IsVisible = glass;
        if (_light != light) { _light = light; SetMaterial(); }
        _continuous = continuous;
        InvalidateArrange();
    }

    private void GeometryChanged() { if (IsVisible) InvalidateArrange(); }
    public void Dispose() => _ribbon.MaterialGeometryChanged -= GeometryChanged;

    private void SetMaterial()
    {
        var tint = new LinearGradientBrush {
            StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
            EndPoint = new RelativePoint(.3, 1, RelativeUnit.Relative),
            GradientStops = [
                new GradientStop(Color.Parse(_light ? "#E5EDF7FF" : "#EF1B3047"), 0),
                new GradientStop(Color.Parse(_light ? "#D9D9EAF8" : "#EB112339"), 1)
            ]
        };
        var rim = new SolidColorBrush(Color.Parse(_light ? "#42658AA6" : "#40658BAB"));
        foreach (var pane in _panes) { pane.Background = tint; pane.BorderBrush = rim; }
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        foreach (var child in Children) child.Measure(availableSize);
        return default;
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var regions = _continuous ? new[] { new Rect(finalSize) } : _ribbon.MaterialRegions(finalSize.Width);
        for (var i = 0; i < _panes.Length; i++)
        {
            _panes[i].IsVisible = i < regions.Length;
            if (i < regions.Length) _panes[i].Arrange(regions[i]);
        }
        return finalSize;
    }
}

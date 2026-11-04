using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.VisualTree;

namespace ICeClass.Receiver;

// The backdrop is a sibling below the content: blur and highlights never affect
// text, and the gap between the daily capsules stays completely transparent.
internal sealed class IslandGlassBackdrop : Panel, IDisposable
{
    private readonly ClassroomIslandRibbon _ribbon;
    private readonly Border[] _panes = [new(), new()];
    private readonly IslandGlassLens _lens = new();
    private readonly GlassEdges _edges = new();
    private bool _light = true, _continuous;
    private Window? _owner;
    private IslandGlassBlurWindow? _blur;
    private Rect[] _regions = [];

    public IslandGlassBackdrop(ClassroomIslandRibbon ribbon)
    {
        _ribbon = ribbon;
        IsHitTestVisible = false;
        Children.Add(_lens);
        foreach (var pane in _panes)
        {
            pane.CornerRadius = new CornerRadius(24);
            Children.Add(pane);
        }
        Children.Add(_edges);
        SetMaterial();
        ribbon.MaterialGeometryChanged += () => { if (IsVisible) InvalidateArrange(); };
        AttachedToVisualTree += (_, _) =>
        {
            if (!OperatingSystem.IsWindows() || TopLevel.GetTopLevel(this) is not Window owner) return;
            _owner = owner;
            owner.LayoutUpdated += FollowOwner;
            owner.PositionChanged += OwnerMoved;
            owner.PropertyChanged += OwnerChanged;
            owner.Activated += OwnerActivated;
        };
        DetachedFromVisualTree += (_, _) => Dispose();
    }

    public void Apply(bool glass, bool light, bool continuous)
    {
        if (IsVisible == glass && _light == light && _continuous == continuous) return;
        IsVisible = glass;
        if (_light != light) { _light = light; SetMaterial(); }
        _continuous = continuous;
        if (!glass) { _blur?.Hide(); _lens.Stop(); }
        InvalidateArrange();
    }

    internal void RefreshBlur()
    {
        if (_owner is not { IsVisible: true } owner || !IsVisible || _regions.Length == 0)
        { _blur?.Hide(); _lens.Stop(); return; }
        var offset = this.TranslatePoint(default, owner);
        if (offset is null) return;
        var opacity = 1d;
        for (Visual? visual = this; visual is not null; visual = visual.GetVisualParent()) opacity *= visual.Opacity;
        _blur ??= new IslandGlassBlurWindow();
        // A full-strength Windows acrylic is a milky grey veil. The approved
        // sample has a clear tint with only a little diffusion underneath it.
        _blur.Follow(owner, _regions.Select(rect => rect.Translate((Vector)offset.Value)).ToArray(), opacity * (_light ? .12 : .18));
        _lens.Follow(owner, _regions, _blur.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero);
    }

    internal void SetHighlight(Point? point)
    {
        if (!IsVisible) return;
        var highlight = _ribbon.Animate ? point : null;
        if (_edges.Highlight == highlight) return;
        _edges.Highlight = highlight;
        _edges.InvalidateVisual();
    }

    private void FollowOwner(object? sender, EventArgs args) => RefreshBlur();
    private void OwnerMoved(object? sender, PixelPointEventArgs args) => RefreshBlur();
    private void OwnerChanged(object? sender, AvaloniaPropertyChangedEventArgs args)
    {
        if (args.Property == IsVisibleProperty || args.Property == OpacityProperty) RefreshBlur();
    }
    private void OwnerActivated(object? sender, EventArgs args) { if (_blur?.IsVisible == true && _owner is { } owner) _blur.PlaceBelow(owner); }

    public void Dispose()
    {
        if (_owner is { } owner)
        {
            owner.LayoutUpdated -= FollowOwner; owner.PositionChanged -= OwnerMoved;
            owner.PropertyChanged -= OwnerChanged; owner.Activated -= OwnerActivated;
            _owner = null;
        }
        _blur?.Close(); _blur = null;
        _lens.Dispose();
    }

    private void SetMaterial()
    {
        foreach (var pane in _panes)
            pane.Background = new SolidColorBrush(Color.Parse(_light ? "#52E2F3FF" : "#AD112339"));
        _edges.Light = _light;
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        foreach (var child in Children) child.Measure(availableSize);
        return default;
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var regions = _continuous
            ? new[] { new Rect(finalSize) }
            : _ribbon.MaterialRegions(finalSize.Width);
        for (var i = 0; i < _panes.Length; i++)
        {
            _panes[i].IsVisible = i < regions.Length;
            if (i < regions.Length) _panes[i].Arrange(regions[i]);
        }
        _edges.Regions = regions;
        _regions = regions;
        _lens.Arrange(new Rect(finalSize));
        _edges.Arrange(new Rect(finalSize));
        _edges.InvalidateVisual();
        return finalSize;
    }

    private sealed class GlassEdges : Control
    {
        private static readonly LinearGradientBrush Sheen = Gradient("#2BFFFFFF", "#00FFFFFF", "#1A4D7797");
        private static readonly LinearGradientBrush DarkSheen = Gradient("#12D9F2FF", "#00FFFFFF", "#3306182F");
        private static readonly LinearGradientBrush Rim = Gradient("#D6FFFFFF", "#08FFFFFF", "#70608EAE");
        private static readonly LinearGradientBrush DarkRim = Gradient("#9CF0FAFF", "#08FFFFFF", "#38C7EAFF");
        private static readonly LinearGradientBrush Glint = new()
        {
            StartPoint = new RelativePoint(0, .5, RelativeUnit.Relative), EndPoint = new RelativePoint(1, .5, RelativeUnit.Relative),
            GradientStops = [new GradientStop(Colors.Transparent, 0), new GradientStop(Color.Parse("#DCFFFFFF"), .5), new GradientStop(Colors.Transparent, 1)]
        };
        private static readonly RadialGradientBrush Glow = GlowBrush("#6BFFFFFF");
        private static readonly RadialGradientBrush DarkGlow = GlowBrush("#30B4E0FF");
        private static readonly BoxShadows Shadow = new(new BoxShadow { OffsetY = 3, Blur = 9, Color = Color.Parse("#20163D67") });
        public bool Light { get; set; }
        public Point? Highlight { get; set; }
        public Rect[] Regions { get; set; } = [];

        public override void Render(DrawingContext context)
        {
            foreach (var region in Regions)
            {
                if (region.Width <= 1 || region.Height <= 1) continue;
                var rect = region.Deflate(.5);
                context.DrawRectangle(Brushes.Transparent, null, new RoundedRect(rect, 23.5), Shadow);
                var x = Highlight is { } pointer ? Math.Clamp(pointer.X, rect.Left + rect.Width * .1, rect.Right - rect.Width * .1) : rect.Left + rect.Width * .4;
                var y = Highlight?.Y ?? rect.Top;
                using (context.PushClip(new RoundedRect(rect, 23.5)))
                {
                    context.DrawRectangle(Light ? Sheen : DarkSheen, null, rect);
                    context.DrawRectangle(Light ? Glow : DarkGlow, null,
                        new Rect(x - rect.Width * .42, y - rect.Height * 1.1, rect.Width * .84, rect.Height * 2.2));
                    context.DrawRectangle(Glint, null, new Rect(x - rect.Width * .19, rect.Top + .5, rect.Width * .38, 1.3));
                }
                context.DrawRectangle(null, new Pen(Light ? Rim : DarkRim, 1.25), rect, 23.5, 23.5);
            }
        }

        private static RadialGradientBrush GlowBrush(string center) => new()
        {
            Center = RelativePoint.Center, GradientOrigin = RelativePoint.Center,
            RadiusX = new RelativeScalar(.5, RelativeUnit.Relative), RadiusY = new RelativeScalar(.5, RelativeUnit.Relative),
            GradientStops = [new GradientStop(Color.Parse(center), 0), new GradientStop(Colors.Transparent, 1)]
        };

        private static LinearGradientBrush Gradient(string top, string middle, string bottom) => new()
        {
            StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
            EndPoint = new RelativePoint(.3, 1, RelativeUnit.Relative),
            GradientStops = [new GradientStop(Color.Parse(top), 0), new GradientStop(Color.Parse(middle), .48), new GradientStop(Color.Parse(bottom), 1)]
        };
    }
}

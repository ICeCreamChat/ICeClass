using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal static class BanbanClassroomStyle
{
    internal static readonly FontFamily Font = new("Microsoft YaHei");
    internal static readonly IBrush ActionBlue = DesktopStyle.Brush("#005DBF");
    internal static readonly IBrush SecondaryInk = DesktopStyle.Brush("#4E6C83");
    internal static readonly IBrush ToolFill = DesktopStyle.Brush("#EFF8FD"), ToolEdge = DesktopStyle.Brush("#ABC8DC"),
        ToolHover = DesktopStyle.Brush("#D7EDFC"), ToolPressed = DesktopStyle.Brush("#BFDEFA");
    // This whole rectangle, including the WebView2 child HWND, fits inside the 240 DIP disc.
    internal static readonly Rect PageBody = new(42, 35, 156, 140);

    internal const double RimInset = 4;
    internal const double SectorMargin = 6;
    internal static bool DiscContains(Point point)
    {
        const double center = BanbanClassroomWheel.Diameter / 2;
        var delta = point - new Point(center, center);
        return delta.X * delta.X + delta.Y * delta.Y <= (center - RimInset) * (center - RimInset);
    }

    internal static Border DiscSurface(IBrush background, bool contrast) => new()
    {
        Margin = new Thickness(RimInset), CornerRadius = new CornerRadius(BanbanClassroomWheel.Diameter / 2 - RimInset),
        Background = background, IsHitTestVisible = false,
        BorderThickness = new Thickness(1), BorderBrush = contrast ? Brushes.Black : DesktopStyle.Brush("#A8C1D7"),
        BoxShadow = contrast ? default : BoxShadows.Parse("0 2 4 0 #26315A7F")
    };

    internal static Canvas DiscPage(Control title, BanbanToolSector back)
    {
        var page = new Canvas { Width = BanbanClassroomWheel.Diameter, Height = BanbanClassroomWheel.Diameter };
        var header = new Grid { Width = 150, Height = 40, Children = { title } };
        Canvas.SetLeft(header, 45); Canvas.SetTop(header, 8);
        page.Children.Add(header);
        page.Children.Add(back);
        return page;
    }

    internal static Viewbox Glyph(string name, double size, IBrush ink, double rotation = 0)
    {
        var icon = ClassroomStyle.ResourceIcon($"ICeClass.Classroom.Icons.{name}.svg", size, ink);
        if (rotation != 0) icon.RenderTransform = new RotateTransform(rotation);
        return icon;
    }

    internal static TextBlock Text(string text, double size, bool bold = false, bool muted = false)
    {
        var block = ClassroomStyle.Text(text, size, bold, muted);
        block.FontFamily = Font;
        block.FontWeight = bold ? FontWeight.Bold : FontWeight.Normal;
        if (DesktopStyle.HighContrastEnabled()) block.Foreground = Brushes.Black;
        return block;
    }

    internal static Button MakeButton(string label, bool primary = false)
    {
        var button = ClassroomStyle.Button(label, primary);
        button.FontFamily = Font;
        button.FontWeight = FontWeight.Bold;
        if (!primary) button.FontSize = 16;
        button.Padding = new Thickness(9, 4);
        AutomationProperties.SetName(button, label);
        return button;
    }

    internal static void RoundButton(Button button, double size)
    {
        var contrast = DesktopStyle.HighContrastEnabled();
        button.Width = button.Height = size;
        button.HorizontalAlignment = HorizontalAlignment.Center;
        button.VerticalAlignment = VerticalAlignment.Center;
        button.CornerRadius = new CornerRadius(size / 2);
        button.Clip = new EllipseGeometry(new Rect(0, 0, size, size));
        button.FocusAdorner = new FuncTemplate<Control>(() => new Border {
            CornerRadius = button.CornerRadius, Margin = new Thickness(1), BorderThickness = new Thickness(1),
            IsHitTestVisible = false, BorderBrush = !contrast && button.TryFindResource("NativeFocusBrush", out var focus) && focus is IBrush brush ? brush : Brushes.Black });
        button.BorderBrush = contrast ? Brushes.Black : DesktopStyle.Brush("#B6CBDD");
        button.Background = contrast ? Brushes.White : DesktopStyle.Brush("#DCF8FDFF");
        button.Padding = new Thickness(0);
    }

    internal static void StepFocus(IEnumerable<Button> buttons, Control? current, Key key)
    {
        var enabled = buttons.Where(b => b.IsEffectivelyVisible && b.IsEnabled).ToList();
        if (enabled.Count == 0) return;
        var index = enabled.FindIndex(b => b == current);
        int next = key switch { Key.Home => 0, Key.End => enabled.Count - 1,
            Key.Left or Key.Up => index <= 0 ? enabled.Count - 1 : index - 1, _ => (index + 1) % enabled.Count };
        enabled[next].Focus();
    }

}

/// <summary>The classroom disc and its shortcut menu display the same live fraction.</summary>
internal sealed class BanbanClassroomProgress : Grid
{
    // Leave one DIP between the progress stroke and the sector faces.
    internal const double RingThickness = BanbanClassroomStyle.SectorMargin - 1;
    internal static readonly StyledProperty<double?> FractionProperty =
        AvaloniaProperty.Register<BanbanClassroomProgress, double?>(nameof(Fraction));
    internal double? Fraction { get => GetValue(FractionProperty); set => SetValue(FractionProperty, value); }
    internal Ellipse Rail { get; } = new() { StrokeThickness = RingThickness, IsVisible = false };
    internal Arc Segment { get; } = new() { StrokeThickness = RingThickness, StartAngle = -90,
        StrokeLineCap = PenLineCap.Round, IsVisible = false };
    private readonly IBrush _track, _ink;

    internal BanbanClassroomProgress()
    {
        Width = Height = BanbanClassroomWheel.Diameter - 2 * BanbanClassroomStyle.RimInset;
        IsHitTestVisible = false;
        var contrast = DesktopStyle.HighContrastEnabled();
        _track = DesktopStyle.Brush(contrast ? "#AAA" : "#B6CBDD");
        _ink = contrast ? Brushes.Black : BanbanClassroomStyle.ActionBlue;
        Segment.Stroke = _ink;
        Children.Add(Rail);
        Children.Add(Segment);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property != FractionProperty) return;
        var fraction = Fraction;
        Rail.IsVisible = fraction.HasValue;
        // A complete ellipse remains closed when the two ends of a 360° arc coincide.
        Rail.Stroke = fraction >= 1 ? _ink : _track;
        Segment.IsVisible = fraction is > 0 and < 1;
        Segment.SweepAngle = (fraction ?? 0) * 360;
    }
}

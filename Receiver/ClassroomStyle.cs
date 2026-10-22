using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using System.Globalization;
using System.Xml.Linq;

namespace ICeClass.Receiver;

// Classroom typography and icons; both native shells share DesktopStyle and NativeControls.
internal static class ClassroomStyle
{
    internal static readonly FontFamily Font = new("Microsoft YaHei UI, Microsoft YaHei, Segoe UI");
    internal static TextBlock Title(string text) => Text(text, 24, true);
    internal static TextBlock SectionTitle(string text) => Text(text, 20, true);
    internal static TextBlock Caption(string text) => Text(text, 14, muted: true);
    internal static void Apply(Window window) => RenderOptions.SetTextRenderingMode(window, TextRenderingMode.Antialias);
    internal static TextBlock Text(string text, double size = 16, bool bold = false, bool muted = false)
    {
        var block = new TextBlock {
        Text = text, FontFamily = Font, FontSize = size,
        FontWeight = bold ? FontWeight.SemiBold : FontWeight.Normal,
        Foreground = muted ? DesktopStyle.Muted : DesktopStyle.Ink,
        TextWrapping = TextWrapping.Wrap, LineHeight = size * 1.5,
        };
        RenderOptions.SetTextRenderingMode(block, TextRenderingMode.Antialias);
        return block;
    }
    internal static Border Card(Control content, bool accent = false) => new()
    {
        Background = DesktopStyle.Brush(accent ? "#F0F6FF" : "#FFFFFF"),
        BorderBrush = DesktopStyle.Brush(accent ? "#DBE8F8" : "#E2E8F0"),
        BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14),
        Padding = new Thickness(20), Child = content,
    };
    internal static Button Button(string text, bool primary = false)
    {
        var button = DesktopStyle.Button(text, primary); button.FontFamily = Font; button.FontSize = 16;
        button.Classes.Add(primary ? "classroom-primary" : "classroom-secondary");
        return button;
    }
    internal static StackPanel Field(string label, Control input) => new()
    {
        Spacing = 6, Children = { Text(label, 14, true), input },
    };
    internal static Border SettingsCard(Control content) => new()
    {
        Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E2E8F0"), BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(12), Padding = new Thickness(20, 12), Child = content,
    };
    internal static Border SettingsDivider() => new() { Height = 1, Background = DesktopStyle.Brush("#EDF1F6") };
    internal static StackPanel SettingsSection(string title, Control content) => new()
    {
        Spacing = 8, Children = { Text(title, 15, true), SettingsCard(content) },
    };
    // Unmodified Lucide paths, bundled locally; see Assets/Icons/SOURCE.md.
    internal static Border IconBadge(string name)
    {
        using var stream = typeof(ClassroomStyle).Assembly.GetManifestResourceStream($"ICeClass.Classroom.Icons.{name}.svg")!;
        var canvas = new Canvas { Width = 24, Height = 24 };
        foreach (var shape in XDocument.Load(stream).Root!.Elements())
        {
            Geometry? geometry = shape.Name.LocalName switch {
                "path" => StreamGeometry.Parse(shape.Attribute("d")!.Value),
                "line" => new LineGeometry(new Point(Number("x1"), Number("y1")), new Point(Number("x2"), Number("y2"))),
                _ => null,
            };
            double Number(string key) => double.Parse(shape.Attribute(key)!.Value, CultureInfo.InvariantCulture);
            if (geometry is not null) canvas.Children.Add(new Avalonia.Controls.Shapes.Path {
                Data = geometry, Stroke = DesktopStyle.Blue, StrokeThickness = 1.8,
                StrokeLineCap = PenLineCap.Round, StrokeJoin = PenLineJoin.Round });
        }
        return new Border { Width = 48, Height = 48, Background = DesktopStyle.Brush("#E8F2FF"),
            CornerRadius = new CornerRadius(12), Child = new Viewbox { Width = 26, Height = 26, Child = canvas } };
    }
}

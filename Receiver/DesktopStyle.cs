using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal static class DesktopStyle
{
    public static void KeepWindowInWorkingArea(Window window)
    {
        var queued = false;
        void QueueFit()
        {
            if (queued || !window.IsVisible || window.WindowState != WindowState.Normal) return;
            queued = true;
            Dispatcher.UIThread.Post(() =>
            {
                queued = false;
                if (!window.IsVisible || window.WindowState != WindowState.Normal) return;
                var screen = window.Screens.ScreenFromWindow(window) ?? window.Screens.Primary;
                if (screen is null) return;
                FitWindowToWorkingArea(window, screen.WorkingArea);
            }, DispatcherPriority.Background);
        }
        window.Opened += (_, _) => QueueFit();
        window.SizeChanged += (_, _) => QueueFit();
        window.PropertyChanged += (_, args) => { if (args.Property == Window.WindowStateProperty) QueueFit(); };
    }
    internal static void FitWindowToWorkingArea(Window window, PixelRect work)
    {
        var scale = window.RenderScaling;
        var frame = window.FrameSize ?? window.ClientSize;
        var borderWidth = Math.Max(0, frame.Width - window.ClientSize.Width);
        var borderHeight = Math.Max(0, frame.Height - window.ClientSize.Height);
        var maxWidth = Math.Max(1, work.Width / scale - borderWidth - 8);
        var maxHeight = Math.Max(1, work.Height / scale - borderHeight - 8);
        window.MinWidth = Math.Min(window.MinWidth, maxWidth);
        window.MinHeight = Math.Min(window.MinHeight, maxHeight);
        window.Width = Math.Min(window.ClientSize.Width, maxWidth);
        window.Height = Math.Min(window.ClientSize.Height, maxHeight);
        var width = (int)Math.Ceiling((window.Width + borderWidth) * scale);
        var height = (int)Math.Ceiling((window.Height + borderHeight) * scale);
        window.Position = new PixelPoint(
            Math.Clamp(window.Position.X, work.X, Math.Max(work.X, work.Right - width)),
            Math.Clamp(window.Position.Y, work.Y, Math.Max(work.Y, work.Bottom - height)));
    }
    public static IBrush Ink => Brush("#1D1D1F");
    public static IBrush Muted => Brush("#636366");
    public static IBrush Blue => Brush("#0071E3");
    public static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex));
    public static TextBlock Text(string text, double size = 16, bool bold = false, bool muted = false) => new()
    {
        Text = text, FontSize = size, FontWeight = bold ? FontWeight.SemiBold : FontWeight.Normal,
        Foreground = muted ? Muted : Ink, TextWrapping = TextWrapping.Wrap, LineHeight = size * 1.6,
    };
    public static Image Logo(double size = 56) => new()
    {
        Source = new Bitmap(AppIconFactory.CreateBitmapStream()), Width = size, Height = size,
        Stretch = Stretch.Uniform,
    };
    public static Border Card(Control child, double padding = 24) => new()
    {
        Background = Brushes.White, BorderBrush = Brush("#E5E5EA"), BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(18), Padding = new Thickness(padding), Child = child,
    };
    public static StackPanel Field(string label, Control input) => new()
    {
        Spacing = 8, Children = { Text(label, 16, true), input },
    };
    public static Button Button(string text, bool primary = false) => new()
    {
        Content = text, MinHeight = 46, FontSize = 16, Padding = new Thickness(18, 10),
        Background = primary ? Blue : Brushes.White, Foreground = primary ? Brushes.White : Ink,
        BorderBrush = primary ? Blue : Brush("#D2D2D7"), BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(12), HorizontalAlignment = HorizontalAlignment.Stretch,
    };
    public static Grid Brand(string subtitle)
    {
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        var words = new StackPanel { Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center, Children = { Text("班伴", 24, true), Text(subtitle, 14, muted: true) } };
        grid.Children.Add(Logo()); Grid.SetColumn(words, 1); grid.Children.Add(words);
        return grid;
    }
}

using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// Windows acrylic covers an entire HWND, including transparent content. Keep
// it below the content window and clip its native region to the glass panes.
internal sealed class IslandGlassBlurWindow : Window
{
    private Rect[] _regions = [];
    private double _scale;

    internal IslandGlassBlurWindow()
    {
        Title = "教室浮岛玻璃";
        SystemDecorations = SystemDecorations.None;
        TransparencyLevelHint = [WindowTransparencyLevel.AcrylicBlur, WindowTransparencyLevel.Transparent];
        Background = Brushes.Transparent;
        ShowInTaskbar = false; ShowActivated = false; Topmost = true; CanResize = false;
        IsHitTestVisible = false; Focusable = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
    }

    internal void Follow(Window owner, Rect[] regions, double opacity)
    {
        if (!owner.IsVisible || regions.Length == 0) { Hide(); return; }
        var changed = !_regions.SequenceEqual(regions) || _scale != owner.RenderScaling;
        Width = owner.Bounds.Width; Height = owner.Bounds.Height; Position = owner.Position;
        Opacity = opacity;
        if (changed)
        {
            if (!SetBlurRegion(regions, owner.RenderScaling)) { Hide(); return; }
            _regions = regions; _scale = owner.RenderScaling;
        }
        var showing = !IsVisible;
        if (showing) { Show(); IslandPlatform.SetClickThrough(this, true); }
        PlaceBelow(owner);
    }

    internal void PlaceBelow(Window owner)
    {
        var hwnd = TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        var content = owner.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        if (hwnd == IntPtr.Zero || content == IntPtr.Zero || GetWindow(hwnd, 3) == content) return;
        // Taskbar-less Avalonia windows share a hidden native owner. Windows
        // can reorder that owned group when inserting one popup after another.
        // Put the blur in the topmost band first, then the content above it.
        const uint flags = 0x0001 | 0x0002 | 0x0010 | 0x0200;
        if (owner.Topmost)
        {
            SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, flags);
            SetWindowPos(content, new IntPtr(-1), 0, 0, 0, 0, flags);
        }
        else SetWindowPos(hwnd, content, 0, 0, 0, 0, flags);
    }

    private bool SetBlurRegion(Rect[] regions, double scale)
    {
        var union = CreateRectRgn(0, 0, 0, 0);
        if (union == IntPtr.Zero) return false;
        try
        {
            foreach (var rect in regions)
            {
                var diameter = (int)Math.Round(Math.Min(48, Math.Min(rect.Width, rect.Height)) * scale);
                var pane = CreateRoundRectRgn((int)Math.Floor(rect.Left * scale), (int)Math.Floor(rect.Top * scale),
                    (int)Math.Ceiling(rect.Right * scale), (int)Math.Ceiling(rect.Bottom * scale), diameter, diameter);
                if (pane == IntPtr.Zero) return false;
                try { if (CombineRgn(union, union, pane, 2) == 0) return false; }
                finally { DeleteObject(pane); }
            }
            var hwnd = TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
            if (hwnd == IntPtr.Zero || SetWindowRgn(hwnd, union, true) == 0) return false;
            union = IntPtr.Zero; // Windows owns the region after a successful call.
            return true;
        }
        finally { if (union != IntPtr.Zero) DeleteObject(union); }
    }

    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr destination, IntPtr first, IntPtr second, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
}

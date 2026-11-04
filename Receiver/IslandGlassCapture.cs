using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Microsoft.Win32.SafeHandles;
using SkiaSharp;

namespace ICeClass.Receiver;

// Capture a DWM thumbnail of the one opaque window behind the glass. The
// thumbnail lives offscreen; neither the island nor its recording affinity is
// changed. Ambiguous/overlapping backgrounds keep the existing light material.
internal sealed class IslandGlassCapture : SafeHandleZeroOrMinusOneIsInvalid
{
    internal readonly record struct Source(IntPtr Window, PixelRect Area, PixelRect WindowBounds);
    private IslandGlassCapture() : base(true) => SetHandle(IceGlassCreate());
    internal static IslandGlassCapture Create() => new();
    internal void Update(Source source) => IceGlassUpdate(this, source.Window, source.Area.X, source.Area.Y, source.Area.Width, source.Area.Height);
    internal int Read(SKBitmap pixels, ulong previous, out ulong version, out double milliseconds) =>
        IceGlassRead(this, pixels.GetPixels(), pixels.RowBytes, pixels.Width, pixels.Height, previous, out version, out milliseconds);
    protected override bool ReleaseHandle() { IceGlassClose(handle); return true; }

    internal static Source FindSource(Window owner, PixelRect area, IntPtr blur)
    {
        var current = owner.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        for (var count = 0; current != IntPtr.Zero && count < 256; count++)
        {
            current = GetWindow(current, 2); // GW_HWNDNEXT: below the island.
            if (current == IntPtr.Zero) break;
            if (current == blur || !IsWindowVisible(current) || IsIconic(current)) continue;
            if (DwmGetWindowAttribute(current, 14, out int cloaked, sizeof(int)) == 0 && cloaked != 0) continue;
            if (!GetWindowRect(current, out var raw)) continue;
            var bounds = raw;
            if (DwmGetWindowAttribute(current, 9, out NativeRect extended, Marshal.SizeOf<NativeRect>()) == 0) bounds = extended;
            var rect = bounds.ToRect();
            if (rect.Width <= 0 || rect.Height <= 0 || !rect.Intersects(area)) continue;
            // A partially covering or translucent window cannot describe the
            // composite desktop behind all the panes. Do not show a wrong image.
            if (!rect.Contains(area) || (GetWindowLongPtr(current, -20).ToInt64() & 0x80000) != 0
                || GetWindowDisplayAffinity(current, out var affinity) && affinity != 0) return default;
            return new Source(current, area, raw.ToRect());
        }
        return default;
    }

    [StructLayout(LayoutKind.Sequential)] private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
        public readonly PixelRect ToRect() => new(Left, Top, Math.Max(0, Right - Left), Math.Max(0, Bottom - Top));
    }
    [DllImport("ICeClass.Glass", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr IceGlassCreate();
    [DllImport("ICeClass.Glass", CallingConvention = CallingConvention.Cdecl)] private static extern void IceGlassClose(IntPtr capture);
    [DllImport("ICeClass.Glass", CallingConvention = CallingConvention.Cdecl)] private static extern void IceGlassUpdate(IslandGlassCapture capture, IntPtr source, int x, int y, int width, int height);
    [DllImport("ICeClass.Glass", CallingConvention = CallingConvention.Cdecl)] private static extern int IceGlassRead(IslandGlassCapture capture, IntPtr pixels, int stride, int width, int height, ulong previous, out ulong version, out double milliseconds);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out NativeRect value, int size);
}

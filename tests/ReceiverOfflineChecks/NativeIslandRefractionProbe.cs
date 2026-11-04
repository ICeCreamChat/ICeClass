using System.Diagnostics;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Threading;

// Characterize capture before adding a production rendering loop. The test
// surface contains only synthetic colors; no screen pixels are written to disk.
internal static class NativeIslandRefractionProbe
{
    internal static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Probe()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Probe()
    {
        var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        var background = new Window { Title = "玻璃背景取样检查", Width = 600, Height = 220,
            SystemDecorations = SystemDecorations.None, Background = Brush.Parse("#216CA4"),
            ShowInTaskbar = false, ShowActivated = false, Topmost = true,
            WindowStartupLocation = WindowStartupLocation.Manual, Position = new PixelPoint(180, 220) };
        var overlay = new Window { Title = "玻璃自身排除检查", Width = 400, Height = 90,
            SystemDecorations = SystemDecorations.None, TransparencyLevelHint = [WindowTransparencyLevel.Transparent],
            Background = Brushes.Transparent, Content = new Border { Background = Brush.Parse("#E52858"), CornerRadius = new CornerRadius(24) },
            ShowInTaskbar = false, ShowActivated = false, Topmost = true,
            WindowStartupLocation = WindowStartupLocation.Manual, Position = new PixelPoint(280, 280) };
        try
        {
            background.Show(); overlay.Show(); await Task.Delay(350);
            var screen = overlay.PointToScreen(new Point(20, 20));
            var client = background.PointToClient(screen);
            var source = GetDC(IntPtr.Zero);
            var windowDc = GetDC(background.TryGetPlatformHandle()!.Handle);
            var info = new BitmapInfo { Size = 40, Width = 360, Height = -64, Planes = 1, BitCount = 32 };
            var destination = CreateCompatibleDC(source);
            var bitmap = CreateDIBSection(source, ref info, 0, out var bits, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || destination == IntPtr.Zero || source == IntPtr.Zero || windowDc == IntPtr.Zero)
                throw new InvalidOperationException("Cannot create capture probe resources.");
            var previous = SelectObject(destination, bitmap);
            try
            {
                foreach (var mode in new[] { "screen", "screen-layered", "window-dc", "print-window" })
                {
                    bool Capture() => mode == "print-window"
                        ? PrintWindow(background.TryGetPlatformHandle()!.Handle, destination, 3)
                        : BitBlt(destination, 0, 0, 360, 64, mode == "window-dc" ? windowDc : source,
                            mode == "window-dc" ? (int)(client.X * background.RenderScaling) : screen.X,
                            mode == "window-dc" ? (int)(client.Y * background.RenderScaling) : screen.Y,
                            mode == "screen-layered" ? 0x40CC0020u : 0x00CC0020u);
                    var times = new List<double>();
                    var process = Process.GetCurrentProcess(); var cpu = process.TotalProcessorTime;
                    var elapsed = Stopwatch.StartNew(); var ok = true;
                    for (var i = 0; i < 60; i++)
                    {
                        var start = Stopwatch.GetTimestamp(); ok &= Capture(); GdiFlush();
                        times.Add(Stopwatch.GetElapsedTime(start).TotalMilliseconds);
                        await Task.Delay(1);
                    }
                    var color = (uint)Marshal.ReadInt32(bits, (32 * 360 + 180) * 4) & 0xFFFFFF;
                    times.Sort();
                    Console.WriteLine($"{mode}: ok={ok}, rgb=#{color:X6}, background=#{0x216CA4:X6}, self=#{0xE52858:X6}, "
                        + $"median={times[30]:F3}ms, p95={times[57]:F3}ms, cpu={(process.TotalProcessorTime - cpu).TotalMilliseconds:F1}ms/{elapsed.Elapsed.TotalMilliseconds:F0}ms");
                }
                Console.WriteLine($"overlay transparency={overlay.ActualTransparencyLevel}, scale={overlay.RenderScaling}, "
                    + $"extendedStyle=0x{GetWindowLongPtr(overlay.TryGetPlatformHandle()!.Handle, -20).ToInt64():X}");
            }
            finally
            {
                SelectObject(destination, previous); DeleteObject(bitmap); DeleteDC(destination);
                ReleaseDC(IntPtr.Zero, source); ReleaseDC(background.TryGetPlatformHandle()!.Handle, windowDc);
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { overlay.Close(); background.Close(); desktop.Shutdown(Environment.ExitCode); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo
    {
        public uint Size; public int Width, Height; public ushort Planes, BitCount;
        public uint Compression, SizeImage; public int XPels, YPels; public uint ColorsUsed, ColorsImportant;
    }
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr destination, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr source);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr item);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool GdiFlush();
    [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
}

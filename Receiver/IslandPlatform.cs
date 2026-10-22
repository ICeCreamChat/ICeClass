using System.Runtime.InteropServices;
using System.Text;
using Avalonia.Controls;

namespace ICeClass.Receiver;

internal static class IslandPlatform
{
    public static void SetClickThrough(Window window, bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return;
        var hwnd = window.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
        if (hwnd == IntPtr.Zero) return;
        var style = GetWindowLongPtr(hwnd, -20).ToInt64();
        const long flags = 0x00000020L | 0x00080000L; // WS_EX_TRANSPARENT + WS_EX_LAYERED
        // Keep Avalonia's layered flag when returning to interactive mode.
        var next = enabled ? style | flags : style & ~0x00000020L;
        if (style != next) SetWindowLongPtr(hwnd, -20, new IntPtr(next));
    }
    public static bool ForegroundFullscreen(Window island)
    {
        if (!OperatingSystem.IsWindows()) return false;
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || hwnd == island.TryGetPlatformHandle()?.Handle) return false;
        var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity);
        if (name.ToString() is "Progman" or "WorkerW" or "Shell_TrayWnd") return false;
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == Environment.ProcessId) return false;
        if (!GetWindowRect(hwnd, out var rect)) return false;
        var monitor = MonitorFromWindow(hwnd, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        return GetMonitorInfo(monitor, ref info) && rect.Left <= info.Monitor.Left && rect.Top <= info.Monitor.Top && rect.Right >= info.Monitor.Right && rect.Bottom >= info.Monitor.Bottom;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public Rect Monitor, Work; public int Flags; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
}

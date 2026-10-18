using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Platform;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

/// <summary>Windows WebView2 child, sharing Avalonia's STA dispatcher.</summary>
internal sealed class ReadingBrowser : NativeControlHost
{
    private readonly TaskCompletionSource<IntPtr> _handleReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CoreWebView2Controller? _controller;
    private bool _disposed;
    private bool _resizeQueued;
    public CoreWebView2? Core => _controller?.CoreWebView2;
    public event Action? EscapePressed;
    public event Action? FullscreenPressed;
    public event Action<bool>? FocusOutside;
    public bool HandleEscapeKey { get; set; } = true;
    public bool HandleFullscreenKey { get; set; } = true;
    public ReadingBrowser() { Focusable = true; GotFocus += (_, _) => FocusPage(); }

    protected override IPlatformHandle CreateNativeControlCore(IPlatformHandle parent)
    {
        var handle = CreateWindowEx(0, "STATIC", "", 0x50000000 | 0x02000000, 0, 0, 1, 1, parent.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("无法创建应用窗口，请重新打开客户端。");
        _handleReady.TrySetResult(handle);
        return new PlatformHandle(handle, "HWND");
    }

    public async Task InitializeAsync(string profileDirectory, CancellationToken token)
    {
        var handle = await _handleReady.Task.WaitAsync(token);
        var environment = await CoreWebView2Environment.CreateAsync(null, profileDirectory);
        token.ThrowIfCancellationRequested();
        if (_disposed) throw new OperationCanceledException();
        var controller = await environment.CreateCoreWebView2ControllerAsync(handle);
        if (_disposed || token.IsCancellationRequested) { controller.Close(); token.ThrowIfCancellationRequested(); throw new OperationCanceledException(); }
        _controller = controller;
        controller.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 244, 249, 255);
        controller.AcceleratorKeyPressed += (_, args) =>
        {
            if (args.KeyEventKind is not (CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown)) return;
            if (HandleEscapeKey && args.VirtualKey == 27) { args.Handled = true; Dispatcher.UIThread.Post(() => EscapePressed?.Invoke()); }
            if (HandleFullscreenKey && args.VirtualKey == 122) { args.Handled = true; Dispatcher.UIThread.Post(() => FullscreenPressed?.Invoke()); }
        };
        SizeChanged += (_, _) => QueueResizeBrowser(handle);
        controller.IsVisible = true;
        controller.MoveFocusRequested += (_, args) =>
        {
            args.Handled = true;
            Dispatcher.UIThread.Post(() => FocusOutside?.Invoke(args.Reason == CoreWebView2MoveFocusReason.Next));
        };
        ResizeBrowser(handle);
        QueueResizeBrowser(handle);
    }

    private void QueueResizeBrowser(IntPtr handle)
    {
        if (_disposed || _resizeQueued) return;
        _resizeQueued = true;
        // NativeControlHost moves its HWND during layout. Read its final physical
        // size after that pass, including when the fullscreen header disappears.
        Dispatcher.UIThread.Post(() => { _resizeQueued = false; ResizeBrowser(handle); }, DispatcherPriority.Background);
    }

    private void ResizeBrowser(IntPtr handle)
    {
        if (_disposed || _controller is null) return;
        if (GetClientRect(handle, out var bounds)) _controller.Bounds = new System.Drawing.Rectangle(0, 0, Math.Max(1, bounds.Right), Math.Max(1, bounds.Bottom));
        _controller.NotifyParentWindowPositionChanged();
    }

    public void FocusPage() => _controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
    public void SetPageVisible(bool visible) { if (_controller is not null) _controller.IsVisible = visible; }
    public void DisposeBrowser()
    {
        if (_disposed) return;
        _disposed = true;
        _handleReady.TrySetCanceled();
        _controller?.Close(); _controller = null;
    }
    protected override void DestroyNativeControlCore(IPlatformHandle control)
    {
        DisposeBrowser(); DestroyWindow(control.Handle);
    }

    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(int extendedStyle, string className, string text, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr handle, out Rect rect);
}

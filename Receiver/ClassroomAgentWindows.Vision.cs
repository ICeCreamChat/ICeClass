using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace ICeClass.Receiver;

internal sealed partial class ClassroomAgentWindows
{
    private sealed record VisualFrame(string WindowId, int NativeWidth, int NativeHeight, int Width, int Height, DateTime Seen);
    private readonly Dictionary<string, VisualFrame> _frames = new();
    private sealed record VisualFocus(string WindowId, int[] RuntimeId, DateTime Seen);
    private VisualFocus? _visualFocus;
    private static readonly HashSet<string> VisualActions = new(StringComparer.Ordinal)
        { "click_window", "drag_window", "scroll_window", "type_window_text", "press_window_key" };
    private const int MaximumImageBytes = 512 * 1024;

    private static void VisualAllowed(Target target)
    {
        var name = Path.GetFileNameWithoutExtension(target.Path).ToLowerInvariant();
        if (name is "cmd" or "powershell" or "pwsh" or "windowsterminal" or "conhost" or "credentialuibroker"
            or "logonui" or "lockapp" or "securityhealthsystray" or "msmpeng" or "bitwarden" or "1password" or "keepass")
            throw new InvalidOperationException("此窗口不支持班班视觉操作。");
        if (IsIconic(target.Handle) || !IsWindowVisible(target.Handle) || !IsWindowEnabled(target.Handle))
            throw new InvalidOperationException("窗口已最小化、不可见或被弹窗阻止，请重新查看并选择当前窗口。");
    }

    private static RECT WindowBounds(Target target)
    {
        if (!GetWindowRect(target.Handle, out var rect) || rect.right <= rect.left || rect.bottom <= rect.top ||
            rect.right - rect.left > 8192 || rect.bottom - rect.top > 8192 ||
            (long)(rect.right - rect.left) * (rect.bottom - rect.top) > 16_000_000)
            throw new InvalidOperationException("无法读取有效的窗口尺寸。");
        return rect;
    }

    private JsonObject CaptureWindow(string id, Target target, IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        VisualAllowed(target);
        var bounds = WindowBounds(target);
        var nativeWidth = bounds.right - bounds.left;
        var nativeHeight = bounds.bottom - bounds.top;
        var pixels = ReadWindowPixels(target, nativeWidth, nativeHeight, token);
        token.ThrowIfCancellationRequested();
        // PrintWindow draws only this HWND; it never captures the desktop or
        // an unrelated window covering it. Reject empty GPU-only captures.
        var changed = false;
        for (var offset = 4; offset < pixels.Length; offset += 4096)
            if (pixels[offset] != pixels[0] || pixels[offset + 1] != pixels[1] || pixels[offset + 2] != pixels[2]) { changed = true; break; }
        if (!changed) throw new InvalidOperationException("此窗口未返回可识别的画面，未发送空白截图，请使用应用公开的控件或文稿接口。");
        var source = BitmapSource.Create(nativeWidth, nativeHeight, 96, 96, PixelFormats.Bgr32, null, pixels, nativeWidth * 4);
        source.Freeze();
        byte[] encoded = [];
        var width = 0; var height = 0;
        foreach (var edge in new[] { 1280, 960, 768 })
        {
            token.ThrowIfCancellationRequested();
            var scale = Math.Min(1d, (double)edge / Math.Max(nativeWidth, nativeHeight));
            BitmapSource image = scale == 1 ? source : new TransformedBitmap(source, new ScaleTransform(scale, scale));
            width = image.PixelWidth; height = image.PixelHeight;
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
            using var memory = new MemoryStream(); encoder.Save(memory); encoded = memory.ToArray();
            if (encoded.Length <= MaximumImageBytes) break;
        }
        if (encoded.Length > MaximumImageBytes) throw new InvalidOperationException("窗口画面过于复杂，请缩小目标窗口后再试。");
        var latest = ReadTarget(target.Handle);
        var finalBounds = WindowBounds(latest);
        if (latest.Title != target.Title || finalBounds.right - finalBounds.left != nativeWidth || finalBounds.bottom - finalBounds.top != nativeHeight)
            throw new InvalidOperationException("截图时窗口已变化，请重新查看窗口。");
        var frameId = Guid.NewGuid().ToString("N");
        lock (_gate)
        {
            _frames.Clear();
            _frames[frameId] = new(id, nativeWidth, nativeHeight, width, height, DateTime.UtcNow);
        }
        var result = Inspect(apps, token);
        result["targetId"] = id;
        result["screenshot"] = new JsonObject { ["id"] = frameId, ["targetId"] = id, ["width"] = width, ["height"] = height,
            ["dataUrl"] = "data:image/png;base64," + Convert.ToBase64String(encoded) };
        result["verified"] = true;
        var focused = AutomationElement.FocusedElement;
        result["textInputReady"] = _visualFocus is { } focus && focus.WindowId == id &&
            (DateTime.UtcNow - focus.Seen).TotalSeconds < 60 && focused is not null && focused.GetRuntimeId().SequenceEqual(focus.RuntimeId);
        result["detail"] = "已读取所选窗口的当前画面。";
        var activePopup = result["windows"]!.AsArray().FirstOrDefault(w => w?["foreground"]?.GetValue<bool>() == true &&
            w["isPopup"]?.GetValue<bool>() == true && w["id"]?.GetValue<string>() != id);
        if (activePopup is not null)
        {
            Target? popup;
            lock (_gate) _targets.TryGetValue(activePopup["id"]!.GetValue<string>(), out popup);
            if (popup is not null && popup.Pid == target.Pid && popup.Path == target.Path)
            {
                result["activePopupId"] = activePopup["id"]!.DeepClone();
                result["detail"] = "已读取主窗口；当前应用另有独立弹出窗口，请用 activePopupId 查看并操作该浮层。主窗口截图不包含浮层。";
            }
        }
        return result;
    }

    private static byte[] ReadWindowPixels(Target target, int width, int height, CancellationToken token)
    {
        nint dc = 0, bitmap = 0, previous = 0;
        try
        {
            dc = CreateCompatibleDC(0);
            if (dc == 0) throw new InvalidOperationException("无法创建窗口截图资源。");
            var info = new BITMAPINFO { size = 40, width = width, height = -height, planes = 1, bitCount = 32 };
            bitmap = CreateDIBSection(dc, ref info, 0, out var bits, 0, 0);
            if (bitmap == 0 || bits == 0) throw new InvalidOperationException("无法创建窗口截图缓冲区。");
            previous = SelectObject(dc, bitmap);
            token.ThrowIfCancellationRequested();
            if (!PrintWindow(target.Handle, dc, 2)) throw new InvalidOperationException("应用未提供窗口截图，请重新查看窗口。");
            token.ThrowIfCancellationRequested();
            var pixels = new byte[checked(width * height * 4)]; Marshal.Copy(bits, pixels, 0, pixels.Length);
            return pixels;
        }
        finally
        {
            if (previous != 0 && dc != 0) SelectObject(dc, previous);
            if (bitmap != 0) DeleteObject(bitmap);
            if (dc != 0) DeleteDC(dc);
        }
    }

    private JsonObject VisualInput(string action, string id, Target target, JsonElement args, IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        VisualAllowed(target);
        var frameId = ClassroomAgentService.Text(args, "screenshotId", 100);
        VisualFrame? frame;
        lock (_gate) _frames.TryGetValue(frameId, out frame);
        if (frame is null || frame.WindowId != id || (DateTime.UtcNow - frame.Seen).TotalSeconds >= 60)
            throw new InvalidOperationException("截图已过期或已经使用，请重新查看该窗口。");
        var rect = WindowBounds(target);
        if (rect.right - rect.left != frame.NativeWidth || rect.bottom - rect.top != frame.NativeHeight)
            throw new InvalidOperationException("窗口尺寸已变化，请重新截图后再操作。");
        POINT Point(string xKey, string yKey)
        {
            if (!args.TryGetProperty(xKey, out var xValue) || !xValue.TryGetInt32(out var x) || x < 0 || x >= frame.Width ||
                !args.TryGetProperty(yKey, out var yValue) || !yValue.TryGetInt32(out var y) || y < 0 || y >= frame.Height)
                throw new InvalidOperationException("坐标超出所选窗口截图。");
            return new() { x = rect.left + (int)Math.Round((x + .5) * frame.NativeWidth / frame.Width),
                y = rect.top + (int)Math.Round((y + .5) * frame.NativeHeight / frame.Height) };
        }
        var point = action is "press_window_key" or "type_window_text" ? default : Point("x", "y");
        var destination = action == "drag_window" ? Point("toX", "toY") : default;
        var key = action == "press_window_key" ? VisualKeys(ClassroomAgentService.Text(args, "key", 20)) : [];
        var text = action == "type_window_text" ? ClassroomAgentService.Text(args, "text", 2000) : "";
        var button = action == "click_window" ? ClassroomAgentService.Text(args, "button", 10, false) : "left";
        if (button.Length == 0) button = "left";
        if (button is not ("left" or "right")) throw new InvalidOperationException("仅支持左键和右键。");
        var count = args.TryGetProperty("clickCount", out var clicks) ? clicks.GetInt32() : 1;
        if (count is < 1 or > 2) throw new InvalidOperationException("仅支持单击或双击。");
        var amount = action == "scroll_window" ? args.GetProperty("amount").GetInt32() : 0;
        if (action == "scroll_window" && (amount == 0 || amount is < -1200 or > 1200)) throw new InvalidOperationException("滚动量超出范围。");
        Focus(target);
        token.ThrowIfCancellationRequested();
        if (action is not ("press_window_key" or "type_window_text")) EnsurePoint(target, point);
        if (action == "drag_window") EnsurePoint(target, destination);
        // Consume before the first input. Partial input, cancellation or a
        // failed acknowledgement can never authorize a second attempt.
        lock (_gate) _frames.Clear();
        if (action == "press_window_key")
        {
            EnsureNotPrivate(); Keys(target, key, token);
        }
        else if (action == "scroll_window")
        {
            MoveCursor(target, point, token); Mouse(0x0800, unchecked((uint)-amount));
        }
        else if (action == "drag_window")
        {
            MoveCursor(target, point, token);
            try
            {
                Mouse(0x0002);
                for (var step = 1; step <= 12; step++)
                {
                    var next = new POINT { x = point.x + (destination.x - point.x) * step / 12, y = point.y + (destination.y - point.y) * step / 12 };
                    MoveCursor(target, next, token);
                    if (token.WaitHandle.WaitOne(15)) token.ThrowIfCancellationRequested();
                }
            }
            finally { Mouse(0x0004); }
        }
        else if (action == "type_window_text")
        {
            EnsureNotPrivate();
            var focused = AutomationElement.FocusedElement;
            if (_visualFocus is not { } saved || saved.WindowId != id || (DateTime.UtcNow - saved.Seen).TotalSeconds >= 60 ||
                focused is null || !focused.GetRuntimeId().SequenceEqual(saved.RuntimeId))
                throw new InvalidOperationException("输入区域未获得可核对的焦点，请先点击目标输入区域并重新截图。");
            foreach (var unit in text)
            {
                token.ThrowIfCancellationRequested();
                if (GetForegroundWindow() != target.Handle) throw new InvalidOperationException("前台窗口已变化，已停止输入文字。");
                INPUT[] input = [new() { type = 1, data = new() { keyboard = new() { scan = unit, flags = 4 } } },
                                 new() { type = 1, data = new() { keyboard = new() { scan = unit, flags = 6 } } }];
                if (SendInput(2, input, Marshal.SizeOf<INPUT>()) != 2) throw new InvalidOperationException("系统阻止了文字输入，已停止继续操作。");
            }
        }
        else
        {
            MoveCursor(target, point, token);
            for (var n = 0; n < count; n++)
            {
                token.ThrowIfCancellationRequested();
                try { Mouse(button == "right" ? 0x0008u : 0x0002u); }
                finally { Mouse(button == "right" ? 0x0010u : 0x0004u); }
                if (count == 2 && n == 0 && token.WaitHandle.WaitOne(60)) token.ThrowIfCancellationRequested();
            }
        }
        if (token.WaitHandle.WaitOne(100)) token.ThrowIfCancellationRequested();
        if (action == "click_window")
        {
            var focused = AutomationElement.FocusedElement;
            _visualFocus = focused is null ? null : new(id, focused.GetRuntimeId(), DateTime.UtcNow);
        }
        var result = Inspect(apps, token);
        result["targetId"] = id; result["inputSent"] = true; result["effectVerified"] = false;
        result["verified"] = true; result["detail"] = "已向所选窗口发送输入，请重新截图核对实际结果。";
        try
        {
            var current = ReadTarget(target.Handle);
            if (WindowIdentity(current) != id)
                throw new InvalidOperationException("窗口已切换到新文档，请从返回的窗口列表选择新目标并重新查看；不要重复刚才的输入。");
            var observed = CaptureWindow(id, current, apps, token);
            foreach (var field in observed) result[field.Key] = field.Value?.DeepClone();
            result["detail"] = "已发送输入并返回操作后的新画面，请根据实际画面核对任务结果。";
        }
        catch (InvalidOperationException error)
        {
            result["observationError"] = error.Message;
            result["detail"] = "输入已发送，当前无法读取新画面，请重新查看窗口；不要重复输入。";
        }
        return result;
    }

    private static ushort[] VisualKeys(string key) => key switch
    {
        "enter" => [0x0D], "escape" => [0x1B], "space" => [0x20], "tab" => [0x09], "shift_tab" => [0x10, 0x09],
        "up" => [0x26], "down" => [0x28], "left" => [0x25], "right" => [0x27], "home" => [0x24], "end" => [0x23],
        "page_up" => [0x21], "page_down" => [0x22], "ctrl_a" => [0x11, 0x41], "ctrl_z" => [0x11, 0x5A],
        "ctrl_s" => [0x11, 0x53], "f5" => [0x74], "f11" => [0x7A],
        _ => throw new InvalidOperationException("仅支持当前窗口的标准编辑和导航按键。")
    };

    private static void EnsureNotPrivate()
    {
        try
        {
            if (AutomationElement.FocusedElement is { } focused && SensitiveControl(focused.Current))
                throw new InvalidOperationException("不会操作密码或其他私密输入框。");
        }
        catch (ElementNotAvailableException) { throw new InvalidOperationException("输入焦点已变化，请重新查看窗口。"); }
    }

    private static void EnsurePoint(Target target, POINT point)
    {
        if (GetAncestor(WindowFromPoint(point), 2) != target.Handle)
            throw new InvalidOperationException("该位置被其他窗口或弹窗遮挡，请重新查看并选择目标窗口。");
        try
        {
            var element = AutomationElement.FromPoint(new System.Windows.Point(point.x, point.y));
            if (element is not null && SensitiveControl(element.Current)) throw new InvalidOperationException("不会点击密码或私密输入框。");
        }
        catch (ElementNotAvailableException) { throw new InvalidOperationException("目标位置已变化，请重新查看窗口。"); }
    }

    private static void MoveCursor(Target target, POINT point, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (GetForegroundWindow() != target.Handle) throw new InvalidOperationException("前台窗口已变化，未继续发送鼠标输入。");
        EnsurePoint(target, point);
        if (!SetCursorPos(point.x, point.y)) throw new InvalidOperationException("系统未允许移动鼠标。");
    }

    private static void Mouse(uint flags, uint data = 0)
    {
        INPUT[] input = [new() { type = 0, data = new() { mouse = new() { flags = flags, mouseData = data } } }];
        if (SendInput(1, input, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("系统阻止了鼠标输入。");
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] private struct BITMAPINFO
    {
        public uint size; public int width, height; public ushort planes, bitCount;
        public uint compression, imageSize; public int xPixelsPerMeter, yPixelsPerMeter; public uint colorsUsed, colorsImportant;
    }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint handle, out RECT rect);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(nint handle);
    [DllImport("user32.dll")] private static extern bool PrintWindow(nint handle, nint dc, uint flags);
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint handle, uint flags);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("gdi32.dll")] private static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] private static extern nint CreateDIBSection(nint dc, ref BITMAPINFO info, uint usage, out nint bits, nint section, uint offset);
    [DllImport("gdi32.dll")] private static extern nint SelectObject(nint dc, nint value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint value);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(nint dc);
}

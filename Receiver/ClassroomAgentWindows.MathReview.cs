using System.Text.Json.Nodes;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace ICeClass.Receiver;

internal sealed partial class ClassroomAgentWindows
{
    internal Task<JsonObject> MathWindowsAsync(IReadOnlyList<AgentApplication> apps, CancellationToken token) => Apartment(() =>
    {
        var observation = Inspect(apps, token);
        var candidates = observation["windows"]!.AsArray().Where(window =>
            window?["kind"]?.GetValue<string>() == "wps-presentation" && window["presentationMode"]?.GetValue<string>() == "slideshow" &&
            window["minimized"]?.GetValue<bool>() == false).Select(window => window!.DeepClone()).ToArray();
        return new JsonObject { ["windows"] = new JsonArray(candidates) };
    }, token, ApartmentState.STA);

    internal Task<JsonObject> MathCaptureAsync(string id, IReadOnlyList<AgentApplication> apps, CancellationToken token) => Apartment(() =>
    {
        var target = ValidateTarget(id, apps);
        var app = apps.First(application => application.MatchesPath(target.Path));
        if (WindowKind(app.Kind, target.Title) != "wps-presentation" || !LooksLikeSlideShow(target))
            throw new InvalidOperationException("请先在 WPS 中开始放映，再点评当前题目。");
        VisualAllowed(target);
        var bounds = WindowBounds(target);
        var width = bounds.right - bounds.left; var height = bounds.bottom - bounds.top;
        var capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var pixels = ReadWindowPixels(target, width, height, token);
        var changed = false;
        for (var offset = 0; offset + 2 < pixels.Length; offset += 64)
            if (pixels[offset] != pixels[0] || pixels[offset + 1] != pixels[1] || pixels[offset + 2] != pixels[2]) { changed = true; break; }
        if (!changed) throw new InvalidOperationException("WPS 未返回可读的题目画面，请检查放映窗口后重试。");
        var source = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgr32, null, pixels, width * 4); source.Freeze();
        var scale = Math.Min(1d, 1920d / Math.Max(width, height));
        BitmapSource image = scale == 1 ? source : new TransformedBitmap(source, new ScaleTransform(scale, scale));
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
        using var memory = new MemoryStream(); encoder.Save(memory);
        if (memory.Length > 2 * 1024 * 1024) throw new InvalidOperationException("题目画面过大，请缩小放映窗口或简化页面后重试。");
        var latest = ReadTarget(target.Handle); var latestBounds = WindowBounds(latest);
        if (latest.Pid != target.Pid || latest.Started != target.Started || latest.Path != target.Path || latest.Title != target.Title ||
            latestBounds.right - latestBounds.left != width || latestBounds.bottom - latestBounds.top != height)
            throw new InvalidOperationException("取图时 WPS 窗口发生变化，请继续展示后重新点评。");
        token.ThrowIfCancellationRequested();
        // This branch never creates or replaces the general computer-control screenshot credential.
        return new JsonObject { ["dataUrl"] = "data:image/png;base64," + Convert.ToBase64String(memory.ToArray()),
            ["width"] = image.PixelWidth, ["height"] = image.PixelHeight, ["capturedAt"] = capturedAt };
    }, token, ApartmentState.STA);
}

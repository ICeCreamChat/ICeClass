using Avalonia;
using SkiaSharp;
using System.Runtime.InteropServices;

namespace ICeClass.Receiver;

// Pure optics shared by the desktop, classroom and floating island.
internal static class LiquidGlassOptics
{
    // This uses Skia's supported displacement filter, including on software
    // renderers. SkiaSharp 2.88 runtime shaders cannot render on raster surfaces.
    internal static SKImageFilter CreateFilter(Rect pane, double scale, double? cornerRadius = null, bool bounded = false)
    {
        var ratio = bounded ? Math.Min(1, Math.Min(760 / (pane.Width * scale), 560 / (pane.Height * scale))) : 1;
        var width = Math.Max(1, (int)Math.Ceiling(pane.Width * scale * ratio));
        var height = Math.Max(1, (int)Math.Ceiling(pane.Height * scale * ratio));
        var colors = new int[width * height];
        var radius = Math.Min(cornerRadius ?? 24, Math.Min(pane.Width, pane.Height) / 2);
        var band = Math.Min(16, pane.Height * .4);
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++)
        {
            var px = (x + .5) / (scale * ratio) - pane.Width / 2;
            var py = (y + .5) / (scale * ratio) - pane.Height / 2;
            var qx = Math.Abs(px) - (pane.Width / 2 - radius);
            var qy = Math.Abs(py) - (pane.Height / 2 - radius);
            var ox = Math.Max(0, qx); var oy = Math.Max(0, qy);
            var length = Math.Sqrt(ox * ox + oy * oy);
            var distance = -(length + Math.Min(Math.Max(qx, qy), 0) - radius);
            var nx = length > 0 ? ox / length * Math.Sign(px) : qx > qy ? Math.Sign(px) : 0;
            var ny = length > 0 ? oy / length * Math.Sign(py) : qx > qy ? 0 : Math.Sign(py);
            var edge = Math.Pow(Math.Max(0, 1 - Math.Max(0, distance) / band), 2);
            var red = (byte)Math.Clamp(Math.Round(128 - nx * edge * 112), 0, 255);
            var green = (byte)Math.Clamp(Math.Round(128 - ny * edge * 112), 0, 255);
            colors[y * width + x] = unchecked((int)(0xFF000080u | (uint)red << 16 | (uint)green << 8));
        }
        using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, SKAlphaType.Premul));
        Marshal.Copy(colors, 0, bitmap.GetPixels(), colors.Length);
        using var map = SKImage.FromBitmap(bitmap);
        using var mapFilter = SKImageFilter.CreateImage(map, new SKRect(0, 0, width, height),
            new SKRect((float)(pane.Left * scale), (float)(pane.Top * scale), (float)(pane.Right * scale), (float)(pane.Bottom * scale)), SKFilterQuality.Low);
        using var blur = SKImageFilter.CreateBlur((float)(1.35 * scale), (float)(1.35 * scale));
        using var displacement = SKImageFilter.CreateDisplacementMapEffect(SKColorChannel.R, SKColorChannel.G, (float)(28 * scale), mapFilter, blur);
        const float saturation = 1.25f;
        var redWeight = (1 - saturation) * .2126f;
        var greenWeight = (1 - saturation) * .7152f;
        var blueWeight = (1 - saturation) * .0722f;
        using var color = SKColorFilter.CreateColorMatrix([
            redWeight + saturation, greenWeight, blueWeight, 0, 0,
            redWeight, greenWeight + saturation, blueWeight, 0, 0,
            redWeight, greenWeight, blueWeight + saturation, 0, 0,
            0, 0, 0, 1, 0]);
        return SKImageFilter.CreateColorFilter(color, displacement);
    }
}

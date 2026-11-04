using System.Reflection;
using Avalonia;
using ICeClass.Receiver;
using SkiaSharp;

internal static class IslandRefractionShaderChecks
{
    internal static void Run()
    {
        var checks = 0;
        void Assert(bool value, string description)
        { if (!value) throw new InvalidOperationException(description); checks++; Console.WriteLine("PASS " + description); }
        var lens = typeof(ClassroomIslandWindow).Assembly.GetType("ICeClass.Receiver.IslandGlassLens");
        Assert(lens is not null, "production glass has a background displacement renderer");
        var factory = lens!.GetMethod("CreateFilter", BindingFlags.Static | BindingFlags.NonPublic)!;
        using var pixels = new SKBitmap(192, 96);
        for (var y = 0; y < pixels.Height; y++) for (var x = 0; x < pixels.Width; x++)
        { var grey = (byte)(x * 255 / 191); pixels.SetPixel(x, y, new SKColor(grey, grey, grey)); }
        using var image = SKImage.FromBitmap(pixels);
        using var filter = (SKImageFilter)factory.Invoke(null, [new Rect(0, 0, 96, 48), 2d])!;
        using var result = new SKBitmap(192, 96);
        using (var canvas = new SKCanvas(result))
        using (var paint = new SKPaint { ImageFilter = filter })
        {
            canvas.Clear(SKColors.Transparent);
            canvas.ClipRoundRect(new SKRoundRect(new SKRect(0, 0, 192, 96), 48), SKClipOperation.Intersect, true);
            canvas.DrawImage(image, 0, 0, paint);
        }
        Assert(Math.Abs(result.GetPixel(96, 48).Red - pixels.GetPixel(96, 48).Red) <= 3,
            "center samples the original background at 200% DPI");
        Assert(result.GetPixel(3, 48).Red - pixels.GetPixel(3, 48).Red >= 20,
            "left lens edge visibly samples pixels farther inside the background");
        Assert(pixels.GetPixel(188, 48).Red - result.GetPixel(188, 48).Red >= 20,
            "right lens edge bends toward the opposite normal");
        Assert(result.GetPixel(0, 0).Alpha == 0 && result.GetPixel(96, 48).Alpha == 255,
            "rounded outer corner remains clear while the lens center retains its background");
        Console.WriteLine($"{checks} refraction shader checks passed.");
    }
}

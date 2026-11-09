using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;

// Explicit opt-in hardware check. Uses the production camera implementation,
// saves one photograph locally, and never starts audio or connects to an AI.
internal static class SelfStudyCameraChecks
{
    internal static void Run(string output)
    {
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(Path.GetFullPath(output))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Check(string output)
    {
        Directory.CreateDirectory(output);
        var started = Stopwatch.StartNew();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(35));
            Console.WriteLine("Opening the real camera once; no audio capture, no AI connection.");
            var image = await SelfStudyCamera.CaptureAsync(timeout.Token, Console.WriteLine);
            var bytes = Convert.FromBase64String(image);
            using var bitmap = SKBitmap.Decode(bytes) ?? throw new InvalidDataException("摄像头未返回有效 JPEG。");
            if (bitmap.Width <= 0 || bitmap.Height <= 0 || bitmap.Width > 1280 || bitmap.Height > 720 || bytes.Length > 320000)
                throw new InvalidDataException("摄像头照片的尺寸或大小超出限制。");
            var file = Path.Combine(output, "real-camera-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jpg");
            await File.WriteAllBytesAsync(file, bytes, timeout.Token);
            var min = 255; var max = 0; var sum = 0L; var count = 0;
            for (var y = 0; y < bitmap.Height; y += 8)
            for (var x = 0; x < bitmap.Width; x += 8)
            {
                var pixel = bitmap.GetPixel(x, y);
                var value = (pixel.Red * 299 + pixel.Green * 587 + pixel.Blue * 114) / 1000;
                min = Math.Min(min, value); max = Math.Max(max, value); sum += value; count++;
            }
            var report = new { success = true, photo = file, width = bitmap.Width, height = bitmap.Height,
                bytes = bytes.Length, elapsedMs = started.ElapsedMilliseconds,
                luma = new { minimum = min, maximum = max, mean = (double)sum / count },
                audioCaptured = false, uploaded = false, source = "SelfStudyCamera.CaptureAsync (physical device)" };
            await File.WriteAllTextAsync(Path.Combine(output, "result.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine(JsonSerializer.Serialize(report));
        }
        catch (Exception error)
        {
            Environment.ExitCode = 1;
            await File.WriteAllTextAsync(Path.Combine(output, "result.json"), JsonSerializer.Serialize(new {
                success = false, elapsedMs = started.ElapsedMilliseconds, error = error.ToString(), audioCaptured = false, uploaded = false
            }, new JsonSerializerOptions { WriteIndented = true }));
            Console.Error.WriteLine(error);
        }
        finally { ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
    }
}

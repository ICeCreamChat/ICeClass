using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class RibbonRenderingChecks
{
    internal static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(_ => Dispatcher.UIThread.Post(Check))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static void Check()
    {
        try {
            using var ribbon = new ClassroomIslandRibbon { Light = true, Glass = true, ReviewPhase = 1 };
            ribbon.Measure(new Size(640, 48)); ribbon.Arrange(new Rect(0, 0, 640, 48));
            var profile = IslandRibbonChecks.Fixture();
            var frame = IslandRibbonPresentation.Build(profile, IslandRibbonChecks.At(10,39,6), IslandRibbonChecks.View());
            if (frame.Text.Length == 0 || frame.Detail.Length == 0) throw new Exception("Fixture must exercise styled preparation text");
            ribbon.Present(frame);
            using var bitmap = new RenderTargetBitmap(new PixelSize(1000,48),new Vector(96,96));
            void Paint() { using var context = bitmap.CreateDrawingContext(); ribbon.Render(context); }
            for (var i = 0; i < 10; i++) Paint();
            var before = GC.GetAllocatedBytesForCurrentThread(); var started = Stopwatch.StartNew();
            for (var i = 0; i < 60; i++) Paint();
            var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
            Console.WriteLine($"60 warm countdown paints: {bytes} allocated bytes; {started.Elapsed.TotalMilliseconds:0.0} ms");
            if (bytes > 1_000_000) throw new Exception("Static countdown text is being rebuilt during animation paints");
            foreach (var width in new[] { 380, 640, 1000 }) foreach (var light in new[] { false, true }) {
                ribbon.Light = light; ribbon.Arrange(new Rect(0, 0, width, 48)); ribbon.Present(frame); Paint();
                if (ribbon.Frame != frame || ribbon.Bounds.Height != 48) throw new Exception("Rendering changed presentation or ribbon height");
            }
            Console.WriteLine("7 ribbon rendering checks passed.");
        } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
    }
}

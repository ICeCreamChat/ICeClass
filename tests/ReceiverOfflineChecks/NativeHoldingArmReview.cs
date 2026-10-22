using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

// Render the production mascot at fixed times, without a binding, audio or network.
internal static class NativeHoldingArmReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>()
        .UsePlatformDetect().WithInterFont()
        .AfterSetup(_ => Dispatcher.UIThread.Post(() => Capture(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static void Capture(string output)
    {
        using var mascot = new IslandBanbanMascot { Animate = true, ReviewSeconds = 0 };
        var host = new Window { Title = "班班左手原生采样", Width = 64, Height = 66,
            ShowActivated = false, ShowInTaskbar = false, CanResize = false,
            SystemDecorations = SystemDecorations.None, Background = Brushes.Transparent, Content = mascot };
        try
        {
            Directory.CreateDirectory(output);
            host.Show(); mascot.Measure(new Size(64, 66)); mascot.Arrange(new Rect(0, 0, 64, 66));
            void Save(string name, double scale)
            {
                using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(64 * scale),
                    (int)Math.Ceiling(66 * scale)), new Vector(96 * scale, 96 * scale));
                bitmap.Render(mascot); bitmap.Save(Path.Combine(output, name + ".png"));
            }
            foreach (var (level, sequence) in new[] { ("info", 1L), ("warning", 2L), ("urgent", 3L) })
            {
                mascot.Begin(new ClassroomIslandNotice("本机美术检查", "请同学们回到座位，听从老师安排。", level, Sequence: sequence));
                mascot.ReviewSeconds = 2.5;
                Save(level + "-300", 3); Save(level + "-1200", 12);
            }
            foreach (var (name, seconds) in new[] { ("carry", .65), ("lift", 2.05), ("raised", 2.3), ("settled", 2.6) })
            {
                mascot.ReviewSeconds = seconds;
                Save(name + "-1200", 12);
            }
            foreach (var scale in new[] { 1d, 1.25, 1.5, 2, 3 })
            {
                for (var frame = 0; frame <= 78; frame++)
                {
                    mascot.ReviewSeconds = frame / 30d;
                    Save($"motion-{frame:000}-{scale * 100:0}", scale);
                }
            }
            mascot.Animate = false;
            Save("reduced-motion-300", 3);
            Console.WriteLine("Captured 395 native motion samples and 11 reference poses: " + output);
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            host.Close();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

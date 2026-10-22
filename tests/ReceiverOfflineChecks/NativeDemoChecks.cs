using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeDemoChecks
{
    public static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check()
    {
        const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Instance;
        var output = Path.GetFullPath("output/island-demo-20261020"); Directory.CreateDirectory(output);
        var checks = new List<string>();
        void Assert(bool condition, string text) { if (!condition) throw new Exception(text); checks.Add(text); Console.WriteLine("PASS " + text); }
        object Field(object target, string name) => target.GetType().GetField(name, flags)!.GetValue(target)!;
        void Capture(Window window, string name)
        {
            var root = (Control)window;
            using var image = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width), (int)Math.Ceiling(root.Bounds.Height)), new Vector(96, 96));
            image.Render(root); image.Save(Path.Combine(output, name + ".png"));
        }
        using var service = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        try
        {
            service.PlayDemo(); await Task.Delay(100);
            var island = (ClassroomIslandWindow)Field(service, "_window");
            var controller = (IslandDemoWindow)Field(service, "_demoWindow");
            var playback = (IslandDemoPlayback)Field(service, "_demo");
            var ribbon = (ClassroomIslandRibbon)Field(island, "_ribbon");
            Assert(island.IsVisible && controller.IsVisible && !island.IsExpanded && island.ClientSize.Height <= 60,
                "complete demo opens the real thin desktop island and its playback controls");
            service.PlayDemo();
            Assert(ReferenceEquals(controller, Field(service, "_demoWindow")), "repeated activation reuses one demo controller");
            foreach (var (stage, index) in IslandDemoPlayback.Stages.Select((stage, index) => (stage, index)))
            {
                controller.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == stage.Title)
                    .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Task.Delay(600);
                Assert(!playback.Playing && playback.Position == stage.At && ribbon.Frame!.ProgressPerSecond == 0,
                    "stage selection pauses sample time and painted progress: " + stage.Title);
                Capture(island, "island-" + index);
            }
            Capture(controller, "controller");
            foreach (var width in new[] { 550, 380 })
            {
                controller.Width = width; await Task.Delay(40);
                var root = (Control)controller.Content!;
                Assert(root.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible).All(b => {
                    var point = b.TranslatePoint(default, root)!.Value;
                    return point.X >= -1 && point.X + b.Bounds.Width <= root.Bounds.Width + 1;
                }), "playback controls fit within the native window at " + width + " DIP");
            }
            controller.Close(); await Task.Delay(20);
            Assert(!island.IsVisible && typeof(ClassroomIslandService).GetField("_demo", flags)!.GetValue(service) is null,
                "closing the controller ends the isolated demo and removes an unbound sample island");
            service.PlayDemo(); await Task.Delay(20);
            typeof(ClassroomIslandService).GetMethod("Notify", flags)!.Invoke(service, ["真实提醒", "当前课堂有新提醒", 8]);
            Assert(typeof(ClassroomIslandService).GetField("_demo", flags)!.GetValue(service) is null,
                "a real classroom reminder interrupts demo playback");
            Console.WriteLine(checks.Count + " native demo checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            service.Dispose(); File.WriteAllLines(Path.Combine(output, "native-checks.txt"), checks);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

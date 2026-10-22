using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class NativeTimetableChecks
{
    public static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check()
    {
        var output = Path.GetFullPath("output/island-full-day-20261020"); Directory.CreateDirectory(output);
        var checks = new List<string>();
        void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); Console.WriteLine("PASS " + label); }
        var ribbon = new ClassroomIslandRibbon { Light = true, Animate = false, VerticalAlignment = VerticalAlignment.Top };
        var host = new Window { Content = ribbon, Width = 560, Height = 54, ShowActivated = false,
            Background = new SolidColorBrush(Color.Parse("#F2F5FA")), SystemDecorations = SystemDecorations.None };
        try
        {
            ClassroomStyle.Apply(host); host.Show();
            var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
            foreach (var width in new[] { 380, 560, 1000 })
            {
                host.Width = width; await Task.Delay(40);
                foreach (var (name, now) in new[] { ("before", IslandRibbonChecks.At(7, 0)), ("break", IslandRibbonChecks.At(10, 38)),
                    ("lesson", IslandRibbonChecks.At(10, 40)), ("after", IslandRibbonChecks.At(20, 0)) })
                {
                    var frame = IslandRibbonPresentation.Build(profile, now, IslandRibbonChecks.View());
                    ribbon.Present(frame);
                    var layout = typeof(ClassroomIslandRibbon).GetMethod("Layout", BindingFlags.NonPublic | BindingFlags.Instance)!
                        .Invoke(ribbon, [frame, ribbon.Bounds.Width])!;
                    object Property(string key) => layout.GetType().GetProperty(key)!.GetValue(layout)!;
                    var items = (List<IslandRibbonItem>)Property("Items");
                    Assert(items.Select(i => i.Id).SequenceEqual(frame.Items.Select(i => i.Id)) && items.Count(i => i.Id != "break") == 11,
                        $"all eleven lessons remain in order at {width} DIP, {name}");
                    Assert((double)Property("Used") + (double)Property("DateWidth") + (double)Property("Gap") + 12 <= (double)Property("Width") + .1
                        && (double)Property("Width") <= ribbon.Bounds.Width + .1 && (double)Property("SubjectSize") >= 12 && ribbon.Bounds.Height == 48,
                        $"the complete timetable fits with readable abbreviations and stays 48 DIP tall at {width} DIP, {name}");
                    using var image = new RenderTargetBitmap(new PixelSize(width, 54), new Vector(96, 96));
                    image.Render(host); image.Save(Path.Combine(output, $"{name}-{width}.png"));
                }
            }
            Console.WriteLine(checks.Count + " native full-day timetable checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            ribbon.Dispose(); host.Close(); File.WriteAllLines(Path.Combine(output, "native-checks.txt"), checks);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

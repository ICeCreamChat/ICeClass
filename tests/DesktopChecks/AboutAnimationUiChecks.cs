using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Desktop;
using ICeClass.Receiver;

internal static class AboutAnimationUiChecks
{
    internal static string Output = "";
    internal static bool Preview;

    internal static void Run(string output, bool preview = false)
    {
        Output = Path.GetFullPath(output); Preview = preview;
        var thread = new Thread(() => AppBuilder.Configure<AboutAnimationUiApp>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

public sealed class AboutAnimationUiApp : Application
{
    public override void Initialize()
    {
        var product = new App(); product.Initialize();
        foreach (var resource in product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = product.Styles.ToArray(); product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }

    public override void OnFrameworkInitializationCompleted()
    { base.OnFrameworkInitializationCompleted(); Dispatcher.UIThread.Post(() => _ = Check()); }

    private async Task Check()
    {
        var checks = new List<string>();
        var window = Dialogs.Window("ICeClass 教师端 · 关于动画本地验收", 740);
        window.Height = 660; window.SizeToContent = SizeToContent.Manual; window.CanResize = true;
        window.MinWidth = 600; window.MinHeight = 500;
        DesktopStyle.KeepWindowInWorkingArea(window);
        window.Content = AboutContent.Build("教师端", DesktopUpdates.CurrentVersion, "", "", window.Close);
        void Assert(bool value, string label) { if (!value) throw new InvalidOperationException(label); checks.Add(label); }
        var lifetime = (IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!;
        try
        {
            window.Show();
            var mascot = window.GetVisualDescendants().OfType<AboutThankYouMascot>().Single();
            foreach (var width in new[] { 740, 600 })
            {
                window.Width = width;
                mascot.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                var frames = new HashSet<int>(); var elapsed = Stopwatch.StartNew();
                while (elapsed.Elapsed.TotalSeconds < 2.8) { frames.Add(mascot.CurrentFrame); await Task.Delay(20); }
                Assert(frames.Contains(7) && frames.Count >= 4 && !mascot.IsPlaying, $"{width}: the teacher assembly loads the bow sprite and plays a finite timer-driven greeting");
                Assert(mascot.Focus(), $"{width}: the teacher mascot supports keyboard focus");
                Assert(mascot.TranslatePoint(default, window) is { } point && point.X >= 0 && point.Y >= 0
                    && point.X + mascot.Bounds.Width <= window.ClientSize.Width, $"{width}: the mascot fits the existing about layout");
                foreach (var title in new[] { "许可与说明", "更新记录", "诊断日志" })
                {
                    window.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == title)
                        .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    Assert(!mascot.IsPlaying, $"{width}: {title} stops the hidden teacher mascot");
                }
                window.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "致谢名单")
                    .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                Assert(mascot.IsPlaying, $"{width}: returning to teacher acknowledgements replays the greeting");
            }
            if (AboutAnimationUiChecks.Preview)
            {
                window.Width = 740;
                mascot.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                window.Closed += (_, _) => lifetime.Shutdown();
                return;
            }
            window.Close(); Assert(!mascot.IsPlaying, "Closing teacher About releases its timer");
        }
        catch (Exception error) { Environment.ExitCode = 1; Console.Error.WriteLine(error); window.Close(); }
        finally
        {
            Directory.CreateDirectory(AboutAnimationUiChecks.Output);
            await File.WriteAllTextAsync(Path.Combine(AboutAnimationUiChecks.Output, "checks.json"), JsonSerializer.Serialize(new
            { passed = checks.Count, checks, exitCode = Environment.ExitCode, scope = "Teacher assembly's production AboutContent, sprite and styles; isolated native window, no account, binding, network or installed settings." }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} teacher About animation checks passed; exit {Environment.ExitCode}.");
            if (!AboutAnimationUiChecks.Preview || Environment.ExitCode != 0) lifetime.Shutdown(Environment.ExitCode);
        }
    }
}

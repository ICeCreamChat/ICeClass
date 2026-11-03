#if ABOUT_MOTION_CHECKS
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Rendering;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;

namespace ICeClass.Receiver;

// Compile the production mascot unchanged. Only its Windows-preference dependency
// is replaced, so this regression never changes the current user's OS settings.
internal static class DesktopStyle
{
    internal static bool AnimationsEnabled() => false;
}

internal sealed class AboutMotionHost : Application
{
    private static readonly List<string> Checks = [];
    [STAThread]
    private static int Main(string[] args)
    {
        var output = Path.GetFullPath(args.FirstOrDefault(arg => !arg.StartsWith("--")) ?? "output/about-motion-disabled");
        AppBuilder.Configure<AboutMotionHost>().UsePlatformDetect()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Run(output, args.Contains("--pet-only"))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
        return Environment.ExitCode;
    }
    public override void Initialize() => Styles.Add(new FluentTheme());
    private static void Check(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException(label);
        Checks.Add(label); Console.WriteLine("PASS " + label);
    }
    private static async Task Until(Func<bool> condition, string label)
    {
        var elapsed = Stopwatch.StartNew();
        while (!condition())
        {
            if (elapsed.ElapsedMilliseconds > 3000) throw new TimeoutException(label);
            await Task.Delay(20);
        }
    }
    private static async Task CheckPet()
    {
        using var pet = new BanbanPetMascot();
        var window = new Window { Title = "班班桌宠 · 系统动效关闭回归（隔离）", Width = 220, Height = 220, Content = pet };
        try
        {
            window.Show(); pet.Present("listening", true, true);
            Check(pet.Animate && pet.AnimationRunning, "The native voice mascot animates by default with Windows motion disabled");
            var poseField = typeof(BanbanPetMascot).GetField("_motion", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var motion = (BanbanPetMotion)poseField.GetValue(pet)!;
            var poses = new HashSet<BanbanPetPose>();
            var elapsed = Stopwatch.StartNew();
            while (elapsed.Elapsed.TotalSeconds < .6) { poses.Add(motion.Pose); await Task.Delay(20); }
            Check(poses.Count >= 3, "The default voice mascot advances real timer-driven poses");
            pet.Animate = false;
            Check(!pet.AnimationRunning && !pet.IdleScheduled, "An explicit motion-off request stops voice mascot work");
            pet.Animate = true;
            Check(pet.AnimationRunning, "Re-enabling motion resumes the active voice mascot");
            pet.Present("listening", true, false);
            Check(!pet.AnimationRunning && !pet.IdleScheduled, "A hidden voice mascot stops its animation and idle timers");
            pet.Present("listening", true, true);
            Check(pet.AnimationRunning, "Showing the voice mascot resumes motion");
            pet.Present("off", false, true);
            Check(!pet.AnimationRunning && !pet.IdleScheduled, "Disabling voice stops the mascot without animation work");
            pet.Dispose();
            Check(!pet.AnimationRunning && !pet.IdleScheduled, "Disposing the voice mascot releases both timers");
        }
        finally { window.Close(); }
    }
    private static async Task Run(string output, bool petOnly)
    {
        var mascot = new AboutThankYouMascot();
        var window = new Window { Title = "班班鞠躬 · 系统动效关闭回归（隔离）", Width = 280, Height = 300, Content = mascot };
        var frames = new HashSet<int>(); Exception? failure = null; var scenes = 0;
        var renderer = ((IRenderRoot)window).Renderer;
        var sceneEvent = typeof(IRenderer).GetEvent("SceneInvalidated", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
        EventHandler<SceneInvalidatedEventArgs> handler = (_, _) => Interlocked.Increment(ref scenes);
        try
        {
            Check(!DesktopStyle.AnimationsEnabled(), "Windows motion is simulated as disabled without changing OS preferences");
            if (petOnly) { await CheckPet(); return; }
            sceneEvent.GetAddMethod(true)!.Invoke(renderer, [handler]);
            mascot.SetActive(true); window.Show();
            var elapsed = Stopwatch.StartNew();
            while (elapsed.Elapsed.TotalSeconds < 2.8) { frames.Add(mascot.CurrentFrame); await Task.Delay(20); }
            Check(frames.Contains(7) && frames.Count >= 4 && scenes >= 3, "The default greeting bows through real timer and native repaint frames even with Windows motion disabled");
            Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "The finite greeting returns to a still pose after 2.4 seconds");
            mascot.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Until(() => mascot.CurrentFrame > 0, "Click replay did not advance");
            Check(mascot.IsPlaying, "Click replay also works when Windows motion is disabled");
            mascot.SetActive(false);
            Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "Leaving acknowledgements stops and resets playback");
            mascot.SetActive(true); await Until(() => mascot.CurrentFrame > 0, "Returning to acknowledgements did not replay");
            window.Hide(); Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "Hiding the window stops playback");
            window.Show(); await Until(() => mascot.CurrentFrame > 0, "Showing the window did not replay");
            window.WindowState = WindowState.Minimized;
            Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "Minimizing the window stops playback");
            window.WindowState = WindowState.Normal; await Until(() => mascot.CurrentFrame > 0, "Restoring the window did not replay");
            window.Close(); Check(!mascot.IsPlaying, "Closing the window releases the animation timer");
            await CheckPet();
        }
        catch (Exception error) { failure = error; Environment.ExitCode = 1; Console.Error.WriteLine(error); }
        finally
        {
            sceneEvent.GetRemoveMethod(true)!.Invoke(renderer, [handler]); window.Close();
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new
            { passed = Checks.Count, checks = Checks, frames = frames.Order().ToArray(), scenes, error = failure?.ToString(),
              scope = "Production mascot source and sprite; Windows motion preference simulated as false; native timer/repaint; no installed settings, class binding, network or audio." },
                new JsonSerializerOptions { WriteIndented = true }));
            ((IClassicDesktopStyleApplicationLifetime)Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}
#endif

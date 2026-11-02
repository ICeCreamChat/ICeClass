using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml.Styling;
using Avalonia.Media;
using Avalonia.Rendering;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

// Start only presentation controls. Never start Receiver.Program/App, connect a
// receiver, read a binding, play audio, or write the installed client's settings.
internal static class Program
{
    private static readonly List<string> Checks = [];
    private static readonly Dictionary<string, object?> Metrics = new();
    private static readonly List<Window> Windows = [];

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Any(a => a.StartsWith('-') && a is not ("--software" or "--preview")))
        {
            Console.Error.WriteLine("Usage: NativeAnimationChecks [--software] [--preview] [output-directory]");
            return 2;
        }
        var software = args.Contains("--software");
        var output = Path.GetFullPath(args.FirstOrDefault(a => !a.StartsWith('-'))
            ?? $"output/native-animation-{(software ? "software" : "default")}");
        var builder = AppBuilder.Configure<AnimationHost>().UsePlatformDetect().WithInterFont();
        if (software) builder.With(new Win32PlatformOptions { RenderingMode = [Win32RenderingMode.Software] });
        builder.AfterSetup(configured => Dispatcher.UIThread.Post(() =>
        {
            if (args.Contains("--preview")) Preview();
            else _ = Run(output, software);
        })).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
        return Environment.ExitCode;
    }

    private static void Check(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException(label);
        Checks.Add(label); Console.WriteLine("PASS " + label);
    }

    private static async Task Until(Func<bool> condition, string label, int milliseconds = 6000)
    {
        var elapsed = Stopwatch.StartNew();
        while (!condition())
        {
            if (elapsed.ElapsedMilliseconds >= milliseconds) throw new TimeoutException(label);
            await Task.Delay(20);
        }
    }

    private static T Find<T>(Window window) where T : Control => window.GetVisualDescendants().OfType<T>().Single();
    private static void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));

    private static async Task Run(string output, bool software)
    {
        Exception? failure = null;
        try
        {
            Metrics["os"] = RuntimeInformation.OSDescription;
            Metrics["runtime"] = RuntimeInformation.FrameworkDescription;
            Metrics["architecture"] = RuntimeInformation.ProcessArchitecture.ToString();
            Metrics["avalonia"] = typeof(Window).Assembly.GetName().Version?.ToString();
            Metrics["receiver"] = typeof(AboutWindow).Assembly.GetName().Version?.ToString();
            Metrics["requestedRenderer"] = software ? "Software" : "Avalonia default (ANGLE with software fallback)";
            Metrics["systemAnimationsEnabled"] = DesktopStyle.AnimationsEnabled();
            await CheckAbout();
            await CheckShout();
        }
        catch (Exception error) { failure = error; Environment.ExitCode = 1; Console.Error.WriteLine(error); }
        finally
        {
            foreach (var window in Windows.Where(w => w.IsVisible)) window.Close();
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new
            {
                passed = Checks.Count, checks = Checks, metrics = Metrics, error = failure?.ToString(),
                scope = "Isolated native controls; no installed-client settings, binding, network, or audio. Scene invalidations do not prove physical GPU presentation."
            }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{Checks.Count} native animation checks passed; exit {Environment.ExitCode}. Report: {output}");
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private static async Task CheckAbout()
    {
        var about = new AboutWindow { Title = "原生动画诊断 · 关于（隔离）" };
        Windows.Add(about); about.Show();
        var mascot = Find<AboutThankYouMascot>(about);
        var frames = new HashSet<int>();
        using var scenes = new SceneCounter(about);

        // Sample real timer-driven frames. Do not call RenderTargetBitmap.Render,
        // set ReviewSeconds, invoke Advance, or invalidate visuals to make them move.
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed.TotalSeconds < 2.8)
        {
            frames.Add(mascot.CurrentFrame);
            await Task.Delay(20);
        }
        Metrics["aboutFrames"] = frames.Order().ToArray();
        Metrics["aboutSceneInvalidations"] = scenes.Count;
        Check(DesktopStyle.AnimationsEnabled() ? frames.Contains(7) && frames.Count >= 4 && scenes.Count >= 3 : frames.SetEquals([0]),
            "About automatically bows through real timer/repaint frames, or stays static when Windows disables motion");
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0,
            "About deliberately returns to static artwork after the finite 2.4-second greeting");

        Click(mascot);
        if (DesktopStyle.AnimationsEnabled())
        {
            await Until(() => mascot.CurrentFrame > 0, "About replay never advanced");
            Check(mascot.IsPlaying, "clicking About's artwork replays the greeting");
        }
        else Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "About replay also respects Windows reduced motion");

        about.Hide();
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "hiding About stops and resets its timer");
        about.Show();
        if (DesktopStyle.AnimationsEnabled()) await Until(() => mascot.CurrentFrame > 0, "About did not resume after showing");
        about.WindowState = WindowState.Minimized;
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "minimizing About stops its timer");
        about.WindowState = WindowState.Normal;
        if (DesktopStyle.AnimationsEnabled()) await Until(() => mascot.CurrentFrame > 0, "About did not resume after restoring");
        Click(about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "许可与说明"));
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "the hidden acknowledgements page performs no animation work");
        Click(about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "致谢名单"));
        if (DesktopStyle.AnimationsEnabled()) await Until(() => mascot.CurrentFrame > 0, "returning to acknowledgements did not replay");
        about.Close();
        Check(!mascot.IsPlaying, "closing About releases the animation timer");
    }

    private static async Task CheckShout()
    {
        using var mascot = new IslandBanbanMascot();
        using var companion = new IslandShoutCompanion(new Border
        {
            Height = 48, Background = Brushes.MistyRose, CornerRadius = new CornerRadius(24),
            Child = new TextBlock { Text = "紧急喊话 · 本机隔离诊断", Margin = new Thickness(18, 12) }
        }, mascot);
        var window = new Window
        {
            Title = "原生动画诊断 · 喊话（隔离）", Width = 420, Height = 72,
            SystemDecorations = SystemDecorations.None, TransparencyLevelHint = [WindowTransparencyLevel.Transparent],
            Background = Brushes.Transparent, Content = companion, CanResize = false
        };
        Windows.Add(window);
        companion.GeometryChanged += () => window.Width = 420 + companion.Expansion;
        window.Opened += (_, _) => { companion.ResumeAnimation(); mascot.ResumeAnimation(); };
        window.Show();
        Metrics["renderScaling"] = window.RenderScaling;
        Metrics["actualTransparency"] = window.ActualTransparencyLevel.ToString();
        Check(mascot.AssetsLoaded, "the installed native shout artwork loads without WebView or video codecs");
        Check(mascot.Animate == DesktopStyle.AnimationsEnabled(), "a fresh shout mascot uses the effective Windows motion preference");

        var pulse = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        window.RequestAnimationFrame(_ => pulse.SetResult());
        await pulse.Task.WaitAsync(TimeSpan.FromSeconds(6));
        Check(true, "the visible native window receives RequestAnimationFrame callbacks");

        long sequence = 0;
        using var scenes = new SceneCounter(window);
        void Begin(string level, bool animate)
        {
            mascot.Animate = animate;
            companion.PullEnabled = level is "warning" or "urgent";
            mascot.Begin(new ClassroomIslandNotice("本机诊断", "仅检查原生动画，不发送通知。", level, Sequence: ++sequence));
            companion.SetActive(true, animate, restart: true);
        }

        // Force movement only in this isolated test, including on a machine whose
        // system preference disables it. This separates policy from broken rendering.
        foreach (var level in new[] { "info", "warning", "urgent" })
        {
            scenes.Reset();
            Begin(level, animate: true);
            var intermediate = false;
            var elapsed = Stopwatch.StartNew();
            while (elapsed.Elapsed.TotalSeconds < 2.8)
            {
                intermediate |= companion.Expansion is > 8 and < 100;
                await Task.Delay(20);
            }
            Metrics[level + "SceneInvalidations"] = scenes.Count;
            Check(scenes.Count >= 6 && mascot.IsEffectivelyVisible && mascot.Opacity > .99,
                $"{level}: the real mascot callback loop continuously invalidates the native scene");
            Check(level == "info" ? companion.Expansion == 0 : intermediate && companion.Expansion > 127,
                $"{level}: companion geometry follows its intended gradual arrival/pull");
        }

        mascot.Stop(); companion.SetActive(false, false);
        await Task.Delay(200);
        scenes.Reset(); await Task.Delay(250);
        Check(scenes.Count <= 1 && !mascot.IsVisible, "stopping a shout leaves no continuous native repaint loop");
        Begin("urgent", animate: false);
        await Task.Delay(200);
        scenes.Reset(); await Task.Delay(250);
        Check(scenes.Count <= 1 && mascot.IsVisible && mascot.Opacity == 1 && companion.Expansion == 128,
            "reduced motion reproduces the static visible mascot and immediately expanded bar without a repaint loop");
        mascot.Stop(); companion.SetActive(false, false); window.Hide(); window.Show();
        Begin("urgent", animate: true);
        await Until(() => companion.Expansion > 120, "a newly shown native window did not resume its pull");
        Check(mascot.IsVisible && mascot.Opacity > .99, "hide/show and replay resume the native companion");
        mascot.Stop(); companion.SetActive(false, false);
        window.Close();
    }

    private static void Preview()
    {
        var mascot = new IslandBanbanMascot();
        var companion = new IslandShoutCompanion(new Border
        {
            Height = 48, Background = Brushes.MistyRose, CornerRadius = new CornerRadius(24),
            Child = new TextBlock { Text = "紧急喊话 · 本机隔离预览", Margin = new Thickness(20, 12) }
        }, mascot) { Width = 420, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Left };
        companion.GeometryChanged += () => companion.Width = 420 + companion.Expansion;
        var replay = new Button { Content = "重播紧急喊话" };
        var aboutButton = new Button { Content = "打开关于" };
        var window = new Window
        {
            Title = "原生动画诊断 · 本机隔离预览", Width = 760, Height = 250,
            Content = new StackPanel { Margin = new Thickness(24), Spacing = 16, Children =
            {
                new TextBlock { Text = $"Windows 动画：{(DesktopStyle.AnimationsEnabled() ? "开启" : "关闭")}；此窗口不连接任何班级。" },
                companion, new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 12, Children = { replay, aboutButton } }
            } }
        };
        long sequence = 0;
        void Replay()
        {
            mascot.Begin(new ClassroomIslandNotice("本机预览", "原生动画验收", "urgent", Sequence: ++sequence));
            companion.SetActive(true, DesktopStyle.AnimationsEnabled(), restart: true);
        }
        replay.Click += (_, _) => Replay();
        aboutButton.Click += (_, _) => new AboutWindow { Title = "原生动画诊断 · 关于（隔离预览）" }.Show(window);
        window.Opened += (_, _) => Replay();
        window.Closed += (_, _) =>
        {
            companion.Dispose(); mascot.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        };
        window.Show();
        new AboutWindow { Title = "原生动画诊断 · 关于（隔离预览）" }.Show(window);
    }

    // Avalonia 11.2.5 exposes this diagnostic event only on its internal API.
    // Observe it without adding instrumentation or artificial repaints to the product.
    private sealed class SceneCounter : IDisposable
    {
        private readonly IRenderer _renderer;
        private readonly EventInfo _event = typeof(IRenderer).GetEvent("SceneInvalidated", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
        private readonly EventHandler<SceneInvalidatedEventArgs> _handler;
        private int _count;
        internal int Count => Volatile.Read(ref _count);
        internal void Reset() => Interlocked.Exchange(ref _count, 0);
        internal SceneCounter(Window window)
        {
            _renderer = ((IRenderRoot)window).Renderer;
            _handler = (_, _) => Interlocked.Increment(ref _count);
            _event.GetAddMethod(true)!.Invoke(_renderer, [_handler]);
        }
        public void Dispose() => _event.GetRemoveMethod(true)!.Invoke(_renderer, [_handler]);
    }
}

internal sealed class AnimationHost : Application
{
    public override void Initialize()
    {
        Resources["ContentControlThemeFontFamily"] = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI");
        Styles.Add(new FluentTheme());
        Styles.Add(new StyleInclude(new Uri("avares://ICeClass/")) { Source = new Uri("avares://ICeClass/NativeControls.axaml") });
    }
}

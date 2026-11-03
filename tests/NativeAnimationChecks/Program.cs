using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Input;
using Avalonia.Markup.Xaml.Styling;
using Avalonia.Media;
using Avalonia.Media.Imaging;
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
        if (args.Any(a => a.StartsWith('-') && a is not ("--software" or "--preview" or "--updates" or "--about" or "--shout-lifecycle" or "--island-motion") && !a.StartsWith("--server=")))
        {
            Console.Error.WriteLine("Usage: NativeAnimationChecks [--software] [--preview] [--updates|--about|--shout-lifecycle|--island-motion] [--server=http://127.0.0.1:port] [output-directory]");
            return 2;
        }
        var previewServer = args.FirstOrDefault(a => a.StartsWith("--server="))?[9..] ?? "http://127.0.0.1:8870";
        if (!Uri.TryCreate(previewServer, UriKind.Absolute, out var previewUri) || !previewUri.IsLoopback || previewUri.Scheme is not ("http" or "https"))
        {
            Console.Error.WriteLine("The native preview server must use a loopback HTTP address.");
            return 2;
        }
        var software = args.Contains("--software");
        var output = Path.GetFullPath(args.FirstOrDefault(a => !a.StartsWith('-'))
            ?? $"output/native-animation-{(software ? "software" : "default")}");
        var builder = AppBuilder.Configure<AnimationHost>().UsePlatformDetect().WithInterFont();
        if (software) builder.With(new Win32PlatformOptions { RenderingMode = [Win32RenderingMode.Software] });
        builder.AfterSetup(configured => Dispatcher.UIThread.Post(() =>
        {
            if (args.Contains("--preview"))
            {
                if (args.Contains("--island-motion")) IslandMotionNativeChecks.Preview();
                else if (args.Contains("--updates")) UpdateProgressNativeChecks.Preview(previewServer);
                else Preview();
            }
            else _ = Run(output, software, args.Contains("--updates"), args.Contains("--about"), args.Contains("--shout-lifecycle"), args.Contains("--island-motion"));
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

    private static async Task Run(string output, bool software, bool updates, bool about, bool shoutLifecycle, bool islandMotion)
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
            if (islandMotion) await IslandMotionNativeChecks.RunAsync(output, Check);
            else if (about) await CheckAboutPages(output);
            else if (shoutLifecycle) await CheckShoutWindow();
            else if (updates) await UpdateProgressNativeChecks.RunAsync(output, Check);
            else { await CheckAbout(); await CheckShout(); await IslandMotionNativeChecks.RunAsync(output, Check); }
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
            Console.WriteLine($"{Checks.Count} native {(updates ? "update progress" : "animation")} checks passed; exit {Environment.ExitCode}. Report: {output}");
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private static async Task CheckAboutPages(string output)
    {
        var reads = 0;
        var pending = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var submission = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var submissions = 0;
        var window = new AboutWindow(async token =>
        {
            reads++;
            if (reads == 1) return await pending.Task.WaitAsync(token);
            throw new IOException("本地读取失败检查");
        }, (report, token) =>
        {
            submissions++;
            Check(!report.Contains("private-ui-token"), "Only the redacted preview is submitted to the school platform");
            return submission.Task.WaitAsync(token);
        });
        Windows.Add(window); window.Show();
        await Task.Delay(150);
        var buttons = window.GetVisualDescendants().OfType<Button>().ToArray();
        Check(buttons.Any(button => button.Content as string == "更新记录"), "About exposes locally readable release history");
        Check(buttons.Any(button => button.Content as string == "诊断日志"), "About exposes local support diagnostics");
        Check(buttons.Any(button => button.Content as string == "提交诊断"), "About offers an explicit manual server submission action");
        Check(reads == 0, "Opening About does not collect logs until the diagnostics page is selected");
        Click(buttons.Single(button => button.Content as string == "更新记录"));
        await Task.Delay(100);
        Check(window.GetVisualDescendants().OfType<SelectableTextBlock>().Any(text => text.IsEffectivelyVisible && text.Text?.Contains("2.5.5") == true),
            "Release history includes the installed lightweight baseline without a network request");
        Capture(window, output, "about-receiver-history");
        Click(buttons.Single(button => button.Content as string == "诊断日志"));
        var refresh = buttons.Single(button => button.Content as string == "刷新日志");
        var export = buttons.Single(button => button.Content as string == "导出诊断包");
        Check(reads == 1 && !refresh.IsEnabled && !export.IsEnabled, "Loading diagnostics disables repeated reads and export until the report is ready");
        Click(refresh);
        Check(reads == 1, "Repeated refresh cannot start a concurrent log read");
        pending.SetResult("教室端诊断\n版本：2.5.6\nWindows 动画：开启\ntoken=private-ui-token\n");
        await Until(() => export.IsEnabled, "Diagnostics report was not loaded");
        var text = window.GetVisualDescendants().OfType<TextBox>().Single(box => box.IsEffectivelyVisible);
        Check(text.Text?.Contains("Windows 动画：开启") == true && !text.Text.Contains("private-ui-token"), "The preview exposes useful state and hides credentials before copy or export");
        Check(export.IsEffectivelyVisible,
            "Diagnostics has an accessible export action");
        Check(!Find<AboutThankYouMascot>(window).IsPlaying, "Hidden acknowledgements stop their animation while reading diagnostics");
        var submit = buttons.Single(button => button.Content as string == "提交诊断");
        Click(submit); Click(submit);
        Check(submissions == 1 && !submit.IsEnabled, "Repeated submit clicks cannot upload the report twice");
        submission.SetResult("11111111-1111-1111-1111-111111111111");
        await Until(() => submit.IsEnabled, "Diagnostic submission did not finish");
        Check(window.GetVisualDescendants().OfType<TextBlock>().Any(block => block.Text?.Contains("诊断编号") == true),
            "A successful manual submission shows the server report ID");
        Capture(window, output, "about-receiver-diagnostics");
        window.Width = 600; window.Height = 500; await Task.Delay(150);
        Check(pageBoundsFit(window, buttons.Where(button => button.IsEffectivelyVisible)), "About navigation and diagnostic actions fit the 600 by 500 window");
        Capture(window, output, "about-receiver-narrow");
        Click(refresh); await Until(() => refresh.IsEnabled, "Failed refresh did not finish");
        Check(reads == 2 && (text.Text ?? "").Contains("Windows 动画：开启") && export.IsEnabled &&
            window.GetVisualDescendants().OfType<TextBlock>().Any(block => block.Text?.Contains("读取失败") == true),
            "A read error remains visible while preserving the previous report for export");
        var history = buttons.Single(button => button.Content as string == "更新记录");
        history.Focus(); history.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Home });
        Check(Avalonia.Automation.AutomationProperties.GetName(buttons.Single(button => button.Content as string == "致谢名单"))?.Contains("当前页面") == true,
            "The About pages support Home navigation and expose the selected page name");
        window.Close();
        var late = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var readToken = CancellationToken.None;
        var closing = new AboutWindow(token => { readToken = token; return late.Task.WaitAsync(token); });
        Windows.Add(closing); closing.Show();
        await Task.Delay(100);
        Click(closing.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "诊断日志"));
        closing.Close();
        Check(readToken.IsCancellationRequested, "Closing About cancels an unfinished diagnostic read");
        late.TrySetResult("late report");
        await Task.Delay(50);

        static bool pageBoundsFit(Window owner, IEnumerable<Button> controls) => controls.All(button =>
        {
            var position = button.TranslatePoint(default, owner);
            return position.HasValue && position.Value.X >= 0 && position.Value.Y >= 0 &&
                position.Value.X + button.Bounds.Width <= owner.ClientSize.Width + 1 &&
                position.Value.Y + button.Bounds.Height <= owner.ClientSize.Height + 1;
        });
    }

    private static void Capture(Window window, string output, string name)
    {
        Directory.CreateDirectory(output);
        using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(window.ClientSize.Width), (int)Math.Ceiling(window.ClientSize.Height)), new Vector(96, 96));
        bitmap.Render(window); bitmap.Save(Path.Combine(output, name + ".png"));
    }

    private static async Task CheckShoutWindow()
    {
        var window = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => { });
        Windows.Add(window);
        var normal = new ClassroomIslandView("本机隔离检查", "10:00", "11月03日", "课间", "早读", "", true, true, "已连接", null);
        var appearance = new IslandAppearance { Width = 560, Theme = "light", HideFullscreen = false };
        long sequence = 0;
        var opened = 0;
        window.Opened += (_, _) => opened++;
        foreach (var phase in new[] { "first-hidden", "reshown-hidden", "already-visible" })
        {
            window.Update(normal, false);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            if (phase != "already-visible") window.Hide();
            var notice = new ClassroomIslandNotice("本机检查", "动画生命周期检查", "warning", Sequence: ++sequence, DurationSeconds: 10);
            window.Update(normal with { Notice = notice }, false);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            if (!window.IsVisible) window.Show();
            var companion = Find<IslandShoutCompanion>(window);
            using var scenes = new SceneCounter(window);
            var elapsed = Stopwatch.StartNew();
            var intermediate = false;
            while (elapsed.Elapsed.TotalSeconds < 2.5)
            {
                intermediate |= companion.Expansion is > 8 and < 100;
                window.Update(normal with { Notice = notice with { AgeSeconds = elapsed.Elapsed.TotalSeconds } }, false);
                await Task.Delay(100);
            }
            Metrics[phase + "SceneInvalidations"] = scenes.Count;
            Metrics[phase + "OpenedEvents"] = opened;
            var mascot = Find<IslandBanbanMascot>(window);
            Metrics[phase + "FrameCallbacks"] = mascot.AnimationFrames;
            Metrics[phase + "RenderedFrames"] = mascot.RenderedFrames;
            Check(companion.Expansion > 127 && intermediate,
                phase + ": a real notification pulls the actual classroom window after hiding or replaying");
            Check(scenes.Count >= 6, phase + ": notification animation and timed content continue repainting");
        }
        window.DisposeWindow();
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
        Check(frames.Contains(7) && frames.Count >= 4 && scenes.Count >= 3,
            "About automatically bows through real timer/repaint frames regardless of the Windows motion preference");
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0,
            "About deliberately returns to static artwork after the finite 2.4-second greeting");

        Click(mascot);
        await Until(() => mascot.CurrentFrame > 0, "About replay never advanced");
        Check(mascot.IsPlaying, "clicking About's artwork replays the greeting");

        about.Hide();
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "hiding About stops and resets its timer");
        about.Show();
        await Until(() => mascot.CurrentFrame > 0, "About did not resume after showing");
        about.WindowState = WindowState.Minimized;
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "minimizing About stops its timer");
        about.WindowState = WindowState.Normal;
        await Until(() => mascot.CurrentFrame > 0, "About did not resume after restoring");
        Click(about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "许可与说明"));
        Check(!mascot.IsPlaying && mascot.CurrentFrame == 0, "the hidden acknowledgements page performs no animation work");
        Click(about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "致谢名单"));
        await Until(() => mascot.CurrentFrame > 0, "returning to acknowledgements did not replay");
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
        Check(mascot.Animate, "a fresh shout mascot animates by default");

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
            companion.SetActive(true, true, restart: true);
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

using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using ICeClass.Updates;
using Microsoft.Web.WebView2.Core;

internal static class ClassroomWebViewChecks
{
    internal static async Task UpgradeAsync(string endpoint, string previousVersion, string bindingFile)
    {
        if (!ReceiverConfig.TryRead(bindingFile, out var binding) || binding.Endpoint != endpoint || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("Use an isolated loopback binding for release checks.");
        var installation = AppContext.BaseDirectory;
        var program = Path.Combine(installation, "ICeClass.exe");
        if (new Version(FileVersionInfo.GetVersionInfo(program).FileVersion!).ToString(3) != previousVersion)
            throw new InvalidOperationException("The baseline executable does not match the previous release.");
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(4));
        var origin = new Uri(endpoint);
        var planUrl = $"api/receiver/update/plan?deviceId={Uri.EscapeDataString(binding.DeviceId)}&currentVersion={previousVersion}";
        var plan = await IncrementalUpdates.FetchPlanAsync(origin, planUrl, previousVersion, client, binding.DeviceToken, timeout.Token)
            ?? throw new InvalidOperationException("The packaged server did not offer the update.");
        var target = plan.Files.Single(file => file.Path == "ICeClass.exe");
        var runtime = plan.Files.Single(file => file.Path == ClassroomWebViewPackage.UpdatePath);
        var before = await IncrementalUpdates.HashAsync(program, timeout.Token);
        var prepared = await IncrementalUpdates.PrepareAsync(origin, plan, installation, "ICeClass.exe",
            client, binding.DeviceToken, null, null, timeout.Token);
        if (target.Sha256 == before || await IncrementalUpdates.HashAsync(program, timeout.Token) != before ||
            !prepared.Files.Any(file => file.Path == runtime.Path))
            throw new InvalidOperationException("Downloading the update changed the old installation or omitted WebView2.");
        if (!UpdateInstaller.TryLaunchPending(installation, "ICeClass.exe",
                UpdateInstaller.QuoteArguments([ICeClass.Receiver.Program.PaperClassroom, bindingFile]), previousVersion))
            throw new InvalidOperationException("The pending update did not start the installation helper.");
    }

    internal static void Run(string expected, string? installed, string cardVideo)
    {
        if (expected is not ("bundled" or "installed" or "recovery") || !File.Exists(cardVideo))
            throw new ArgumentException("Expected bundled, installed or recovery and a two-card Y4M file.");
        // Only the capture device is simulated. WebView2 must still ask the native host for permission.
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            $"--use-fake-device-for-media-stream --use-file-for-fake-video-capture=\"{Path.GetFullPath(cardVideo)}\"");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                try { await CheckAsync(expected, installed); }
                catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
                finally { ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Until(Func<bool> condition, string description)
    {
        var wait = Stopwatch.StartNew();
        while (!condition())
        {
            if (wait.Elapsed > TimeSpan.FromSeconds(35)) throw new TimeoutException(description);
            await Task.Delay(50);
        }
    }

    private static void VerifyRuntime(CoreWebView2 core, string expected, string? installed)
    {
        using var process = Process.GetProcessById((int)core.BrowserProcessId);
        var actual = process.MainModule!.FileName!;
        var bundled = Path.Combine(AppContext.BaseDirectory, "WebView2", ClassroomWebViewRuntime.BundledVersion, "msedgewebview2.exe");
        var version = core.Environment.BrowserVersionString;
        Console.WriteLine($"{core.Source} | {version} | {actual}");
        var fromBundle = actual.Equals(bundled, StringComparison.OrdinalIgnoreCase);
        if (expected == "bundled" ? !fromBundle || version != ClassroomWebViewRuntime.BundledVersion :
            fromBundle || version != CoreWebView2Environment.GetAvailableBrowserVersionString(installed))
            throw new InvalidOperationException("Unexpected WebView2 executable or version.");
    }

    private static bool IsRecovery(string? message) => message?.Contains("安装或升级.cmd") == true &&
        message.Contains("无需重新绑定") && !message.Contains("HRESULT") && !message.Contains("ICoreWebView2");

    private static async Task CheckHomeNavigation(CoreWebView2 core)
    {
        var source = core.Source;
        var target = new Uri(new Uri(source), "runtime-check.html").AbsoluteUri;
        // The home can finish its first navigation after sending the ready message.
        ulong? targetNavigation = null;
        var navigation = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        core.NavigationStarting += (_, e) => { if (e.Uri == target) targetNavigation = e.NavigationId; };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.NavigationId == targetNavigation)
                navigation.TrySetResult(!e.IsSuccess && e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled);
        };
        core.Navigate(target);
        if (!await navigation.Task.WaitAsync(TimeSpan.FromSeconds(8)) || core.Source != source)
            throw new InvalidOperationException("Home did not cancel navigation outside the allowed page.");
        bool? frame = null, popup = null;
        core.FrameNavigationStarting += (_, e) => { if (e.Uri == target) frame = e.Cancel; };
        core.NewWindowRequested += (_, e) => { popup = e.Handled; e.Handled = true; };
        await core.ExecuteScriptAsync("""
            const frame = document.createElement('iframe');
            frame.src = 'runtime-check.html'; document.body.append(frame);
            window.open('runtime-check.html', '_blank');
            """);
        await Until(() => frame.HasValue && popup.HasValue, "Frame and popup guards");
        if (frame != true || popup != true)
            throw new InvalidOperationException("Home allowed a frame or popup.");
        Console.WriteLine("Home rejected same-origin frame, popup and top-level navigation outside the allowed page.");
    }

    private static async Task CheckReadingFrame(ReceiverConfig config, string? installed)
    {
        var reading = new ReadingCompanionWindow(config) { Opacity = 0, ShowActivated = false, ShowInTaskbar = false };
        try
        {
            var browser = ((Control)reading.Content!).GetVisualDescendants().OfType<ClassroomBrowser>().Single();
            browser.InstalledBrowserFolder = installed;
            reading.Show(); await reading.LoadAsync();
            if (!browser.IsVisible || browser.Core is not { } core) throw new InvalidOperationException("Reading home did not open.");
            await core.ExecuteScriptAsync("document.getElementById('open-classic').click()");
            var deadline = Stopwatch.StartNew();
            while (await core.ExecuteScriptAsync("!!document.querySelector('#classic-frame-holder iframe')?.contentDocument?.documentElement.classList.contains('reading-game')") != "true")
            {
                if (deadline.Elapsed > TimeSpan.FromSeconds(10)) throw new TimeoutException("Bundled reading game frame");
                await Task.Delay(50);
            }
            Console.WriteLine("The bundled reading game opened in its srcdoc frame.");
        }
        finally { await reading.ReturnHomeAsync(false); ReadingOfflineService.Stop(); }
    }

    private static async Task CheckAsync(string expected, string? installed)
    {
        try { Console.WriteLine("Installed candidate: " + CoreWebView2Environment.GetAvailableBrowserVersionString(installed)); }
        catch (WebView2RuntimeNotFoundException) { Console.WriteLine("Installed candidate missing."); }
        var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:9", ClassId = Guid.NewGuid().ToString(),
            DeviceId = Guid.NewGuid().ToString(), DeviceToken = "isolated", ClassName = "兼容性测试" };
        var home = new StudentVoiceWindow(config, _ => Task.CompletedTask) { Opacity = 0, ShowActivated = false, ShowInTaskbar = false };
        var homeBrowser = ((Control)home.Content!).GetVisualDescendants().OfType<ClassroomBrowser>().Single();
        homeBrowser.InstalledBrowserFolder = installed;
        var quizWindow = new Window { Opacity = 0, ShowActivated = false, ShowInTaskbar = false };
        var quiz = new CardQuizHost(config);
        try
        {
            home.Show();
            bool HomeRecovery() => home.GetVisualDescendants().OfType<TextBlock>().Any(t => t.IsEffectivelyVisible && IsRecovery(t.Text));
            await Until(() => homeBrowser.IsVisible || HomeRecovery(), "Classroom home handshake or recovery");
            if (expected == "recovery")
            {
                if (!HomeRecovery() || homeBrowser.Core is not null) throw new InvalidOperationException("Home loaded an unsuitable runtime.");
            }
            else
            {
                if (homeBrowser.Core is not { } homeCore || !homeCore.Source.EndsWith("/homework/classroom/index.html"))
                    throw new InvalidOperationException("Classroom home did not open.");
                VerifyRuntime(homeCore, expected, installed);
                await CheckHomeNavigation(homeCore);
            }
            home.Close();

            CardQuizService.For(config).Store.SaveCache("context", new JsonObject { ["classId"] = config.ClassId,
                ["deviceId"] = config.DeviceId, ["className"] = config.ClassName, ["students"] = new JsonArray(), ["publications"] = new JsonArray() });
            CardQuizWheelState? state = null;
            string? failure = null;
            quiz.CompanionStateChanged += update => state = update;
            quiz.FailedToLoad += message => failure = message;
            quiz.Browser.InstalledBrowserFolder = installed;
            quizWindow.Content = quiz.Browser; quizWindow.Show();
            quiz.SetVisible(true);
            await quiz.InitializeAsync();
            if (expected == "recovery")
            {
                if (quiz.Browser.Core is not null || !IsRecovery(failure)) throw new InvalidOperationException("Paper recovery: " + failure);
                Console.WriteLine("Home and paper stopped before navigation. " + failure);
                return;
            }
            if (failure is not null) throw new InvalidOperationException(failure);
            await Until(() => state?.Lesson is { Phase: "home", Enabled: true }, "Paper home handshake");
            var core = quiz.Browser.Core!;
            VerifyRuntime(core, expected, installed);
            var cameraDecisions = new List<(CoreWebView2PermissionState State, bool Saved)>();
            core.PermissionRequested += (_, e) =>
            {
                if (e.PermissionKind == CoreWebView2PermissionKind.Camera) cameraDecisions.Add((e.State, e.SavesInProfile));
            };
            quiz.ActivateCompanionAction(new("setup-start", state!.Setup!.Selection, Key: state.Lesson.Key));
            await Until(() => state.Lesson is { Phase: "ready", Enabled: true }, "Open lesson");
            quiz.ActivateCompanionAction(new("collect", Key: state.Lesson.Key));
            await Until(() => state is { CameraRunning: true, Preview: not null, Lesson.Received: 2, Lesson.Busy: false }, "Collect two cards");
            var firstRequests = cameraDecisions.Count;
            quiz.ActivateCompanionAction(new("preview-stop", Key: state.Preview!.Key));
            await Until(() => state is { CameraRunning: false, Lesson.Primary: "open-camera", Lesson.Enabled: true }, "Release camera");
            quiz.ActivateCompanionAction(new("open-camera", Key: state.Lesson.Key));
            await Until(() => state.CameraRunning, "Reopen camera");
            if (firstRequests == 0 || cameraDecisions.Count <= firstRequests ||
                cameraDecisions.Any(d => d != (CoreWebView2PermissionState.Allow, false)))
                throw new InvalidOperationException("Camera authorization was not requested separately on reopen.");
            Console.WriteLine($"Collected two cards. Camera authorizations before and after reopen: {firstRequests}, {cameraDecisions.Count}; none saved.");
            quiz.SetVisible(false);
            await CheckReadingFrame(config, installed);
        }
        finally
        {
            if (home.IsVisible) home.Close();
            quiz.Dispose(); quizWindow.Close(); CardQuizService.Stop();
        }
    }
}

#if BANBAN_VOICE_WINDOW_CHECKS
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using Microsoft.Web.WebView2.Core;

var arguments = args;
var thread = new Thread(() => AppBuilder.Configure<BanbanWindowCheckApp>().UsePlatformDetect()
    .AfterSetup(_ => BanbanWindowCheckApp.Arguments = arguments)
    .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();

// Uses only fictional loopback responses, a fresh WebView profile and disabled audio.
// App.Initialize loads styles; the installed client's App lifetime is never started.
public sealed class BanbanWindowCheckApp : Application
{
    internal static string[] Arguments = [];
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    private readonly List<object> _results = [];
    private int _failures;
    public override void Initialize()
    {
        var product = new App(); product.Initialize();
        foreach (var resource in product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = product.Styles.ToArray(); product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted();
        Dispatcher.UIThread.Post(() => _ = Check());
    }
    private void Assert(bool passed, string name)
    {
        _results.Add(new { name, passed });
        Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
        if (!passed) _failures++;
    }
    private static async Task Until(Func<Task<bool>> ready, string description, int seconds = 15)
    {
        var clock = Stopwatch.StartNew();
        while (!await ready())
        {
            if (clock.Elapsed.TotalSeconds > seconds) throw new TimeoutException(description);
            await Task.Delay(50);
        }
    }
    private static Button Retry(BanbanVoiceWindow window) => Field<Border>(window, "_notice")
        .GetVisualDescendants().OfType<Button>().Single();
    private static bool NoticeExposed(BanbanVoiceWindow window)
    {
        var retry = Retry(window);
        var at = retry.PointToScreen(new Point(retry.Bounds.Width / 2, retry.Bounds.Height / 2));
        var handle = window.TryGetPlatformHandle()!.Handle;
        var point = new NativePoint { X = at.X, Y = at.Y };
        ScreenToClient(handle, ref point);
        // Inspect this window's native airspace even when another test or the
        // reviewer has focus. A global hit test also sees unrelated windows.
        return Field<Border>(window, "_notice").IsVisible
            && ChildWindowFromPointEx(handle, point, 1 /* CWP_SKIPINVISIBLE */) == handle;
    }
    private async Task Check()
    {
        var root = FindRoot();
        var output = Path.GetFullPath(Arguments.FirstOrDefault(a => !a.StartsWith("--"))
            ?? Path.Combine(root, ".tools", "banban-voice-window", "results"));
        Directory.CreateDirectory(output);
        var manual = Arguments.Contains("--review");
        var selected = Arguments.FirstOrDefault(a => a.StartsWith("--case="))?[7..];
        using var server = new FixtureServer(root);
        var binding = new ReceiverConfig { Endpoint = server.Endpoint, DeviceId = "voice-window-check-" + Guid.NewGuid().ToString("N"),
            ClassId = "fixture-class", ClassName = "隔离验收班级", DeviceToken = "fixture-token-not-an-account" };
        var preference = Path.Combine(output, "pet-preferences.json");
        File.WriteAllText(preference, "{\"Visible\":false}");
        BanbanVoiceWindow? window = null;
        var dispatcherErrors = new List<string>();
        Dispatcher.UIThread.UnhandledException += (_, e) => { dispatcherErrors.Add(e.Exception.ToString()); e.Handled = true; };
        async Task Run(string name, Func<Task> check)
        {
            if (selected is not null && selected != name) return;
            try { await check(); }
            catch (Exception error)
            {
                Assert(false, name + ": " + error.Message); Console.Error.WriteLine(error);
                if (window is not null)
                {
                    Console.WriteLine("Native status: " + Field<TextBlock>(window, "_status").Text);
                    try
                    {
                        var core = Field<ReadingBrowser>(window, "_browser").Core;
                        if (core is not null) Console.WriteLine(await core.ExecuteScriptAsync("JSON.stringify({errors:window.__fixtureErrors,state:window.ICeClass?.state,ready:document.readyState})"));
                    }
                    catch (InvalidOperationException) { }
                }
            }
            finally { window?.Shutdown(); window = null; await Task.Delay(100); }
        }
        async Task Open(bool background = false)
        {
            window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
            await window.StartAsync(background);
        }
        Task<bool> Authorized() => Task.FromResult(window is not null && Field<bool>(window, "_authorized"));
        async Task<bool> Script(string script) => Field<ReadingBrowser>(window!, "_browser").Core is { } core
            && await core.ExecuteScriptAsync(script) == "true";
        try
        {
            await Run("loading", async () =>
            {
                server.DelayPage();
                await Open();
                await Until(() => Task.FromResult(server.PageRequested), "delayed page not requested");
                await Task.Delay(250);
                Assert(NoticeExposed(window!), "loading notice and reconnect button are above native airspace before page response");
                server.ReleasePage();
                await Until(Authorized, "delayed voice bridge not authorized");
                Assert(await Script("!document.getElementById('bbPanel').hidden && getComputedStyle(document.getElementById('bbPanel')).display !== 'none'"),
                    "delayed page opens real voice controls after the bridge authorizes");
            });
            await Run("identity", async () =>
            {
                server.Mode = "identity";
                await Open();
                await Until(() => Task.FromResult(Field<bool>(window!, "_connectionFailed")), "identity error not received");
                await Task.Delay(200);
                Assert(NoticeExposed(window!), "identity error and reconnect action are visible over the native host");
                server.Mode = "healthy";
                Retry(window!).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "identity retry did not authorize");
                Assert(!Field<Border>(window!, "_notice").IsVisible && Field<ReadingBrowser>(window!, "_browser").IsVisible,
                    "reconnect restores usable voice UI after an identity error");
            });
            await Run("unassigned", async () =>
            {
                server.Mode = "unassigned";
                await Open();
                await Until(() => Task.FromResult(Field<bool>(window!, "_connectionFailed")), "unassigned teacher identity error not received");
                await Task.Delay(100);
                Assert(NoticeExposed(window!) && Retry(window!).IsEnabled
                    && Field<TextBlock>(window!, "_status").Text == FixtureServer.UnassignedMessage,
                    "a classroom without an assigned teacher exposes the exact assignment error and reconnect action");
                Assert(!Field<bool>(window!, "_authorized") && await Script("window.ICeClass.state.user === null && document.getElementById('authPage').classList.contains('hidden') && document.getElementById('appShell').classList.contains('hidden')"),
                    "an unassigned classroom stays unauthorized and does not request a teacher login");
                server.Mode = "real-page";
                Retry(window!).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "assignment recovery did not authorize", 25);
                await Until(() => Script("document.getElementById('bbRestore').hidden"), "assignment recovery conversation initialization");
                Assert(!Field<Border>(window!, "_notice").IsVisible && Field<ReadingBrowser>(window!, "_browser").IsVisible
                    && await Script("(() => { const input=document.getElementById('bbInput'); input.value='隔离输入检查'; input.dispatchEvent(new Event('input')); return !document.getElementById('bbPanel').hidden && !document.getElementById('bbSend').disabled; })()"),
                    "after teacher assignment reconnect restores the actual usable voice conversation");
            });
            await Run("initialization", async () =>
            {
                server.Mode = "healthy";
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                // Interrupt this fixture's native host before initialization; a
                // retry must create a fresh host rather than reuse the failed one.
                var failed = Field<ReadingBrowser>(window, "_browser");
                failed.DisposeBrowser();
                await window.StartAsync();
                Assert(Field<bool>(window, "_connectionFailed") && Retry(window).IsEnabled,
                    "interrupted native initialization enables a recoverable failure");
                Retry(window).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "initialization retry did not authorize");
                Assert(!ReferenceEquals(failed, Field<ReadingBrowser>(window, "_browser"))
                    && await Script("!document.getElementById('bbPanel').hidden"), "initialization retry creates a fully configured voice host");
            });
            await Run("navigation", async () =>
            {
                server.Mode = "navigation-error";
                await Open();
                await Until(() => Task.FromResult(Field<bool>(window!, "_connectionFailed")), "failed navigation not reported");
                await Task.Delay(100);
                Assert(NoticeExposed(window!), "failed navigation exposes the network failure and reconnect button");
                server.Mode = "healthy";
                Retry(window!).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "navigation retry did not authorize");
                Assert(await Script("!document.getElementById('bbPanel').hidden"), "navigation retry restores the authorized voice panel");
            });
            await Run("bootstrap", async () =>
            {
                server.Mode = "no-bridge";
                await Open();
                await Until(() => Task.FromResult(Field<ReadingBrowser>(window!, "_browser").Core!.Source == server.Endpoint + "/"), "bootstrap navigation");
                await Until(() => Task.FromResult(Field<bool>(window!, "_connectionFailed")), "successful navigation without a ready bridge stayed pending", 37);
                Assert(NoticeExposed(window!), "missing page initialization reaches a visible bounded failure");
                server.Mode = "healthy";
                Retry(window!).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "bootstrap retry did not authorize");
                Assert(await Script("!document.getElementById('bbPanel').hidden"), "bootstrap retry restores the voice panel");
            });
            await Run("crash", async () =>
            {
                server.Mode = "healthy";
                await Open();
                await Until(Authorized, "pre-crash authorization");
                var old = Field<ReadingBrowser>(window!, "_browser").Core!;
                Assert(old.Environment.UserDataFolder.Contains("BanbanVoice", StringComparison.Ordinal)
                    && new Uri(old.Source).IsLoopback, "browser crash fixture owns a separate loopback voice profile");
                using (var browserProcess = Process.GetProcessById((int)old.BrowserProcessId)) browserProcess.Kill(entireProcessTree: true);
                await Until(() => Task.FromResult(Field<bool>(window!, "_connectionFailed")), "crash not reported");
                await Task.Delay(200);
                Assert(NoticeExposed(window!), "browser process exit exposes an actionable failure");
                Retry(window!).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "reconnect did not recreate the crashed browser");
                Assert(!ReferenceEquals(old, Field<ReadingBrowser>(window!, "_browser").Core)
                    && await Script("!document.getElementById('bbPanel').hidden"), "reconnect recreates and configures the failed voice browser");
            });
            await Run("background", async () =>
            {
                server.DelayPage();
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                using var visibility = new NativeVisibility(window);
                await window.StartAsync(background: true);
                Console.WriteLine($"Native voice scale={window!.RenderScaling}");
                await Until(() => Task.FromResult(server.PageRequested), "background page not requested");
                await Task.Delay(250);
                Assert(!window.IsVisible && !IsWindowVisible(window.TryGetPlatformHandle()!.Handle),
                    "background startup keeps the native window hidden while the page is loading");
                server.ReleasePage();
                await Until(Authorized, "background authorization");
                await Until(() => Task.FromResult(!window!.IsVisible), "background host did not hide");
                await Task.Delay(100);
                Assert(visibility.ShowEvents == 0, "background initialization never shows the native top-level window");
                window!.BringForward();
                await Task.Delay(250);
                Assert(window.IsVisible && window.Opacity == 1 && NoticeExposed(window) == false,
                    "a background voice host reopens with authorized content");
                window.Width = 380; window.Height = 500;
                await Until(() => Script("innerWidth >= 375 && innerWidth <= 385 && innerHeight > 400"), "narrow native browser bounds");
                Assert(await Script("(() => { const r=document.getElementById('bbPanel').getBoundingClientRect(); return r.width >= 375 && r.width <= innerWidth + 1 && r.height > 400 && r.height <= innerHeight + 1; })()"),
                    "native voice CSS fills the narrow viewport without zero or double DPI scaling");
                window.Hide(); window.BringForward();
                await Until(Authorized, "show/hide lost authorization");
                Assert(await Script("document.documentElement.classList.contains('bb-native-voice-page') && !document.getElementById('bbPanel').hidden"),
                    "hide and reopen preserve the voice bridge and visible panel");
            });
            await Run("background-open", async () =>
            {
                server.DelayPage();
                await Open(background: true);
                await Until(() => Task.FromResult(server.PageRequested), "background page not requested before opening");
                window!.BringForward();
                await Task.Delay(150);
                Assert(window.IsVisible && IsWindowVisible(window.TryGetPlatformHandle()!.Handle) && NoticeExposed(window),
                    "opening during background initialization exposes the loading notice");
                server.ReleasePage();
                await Until(Authorized, "opened background host did not authorize");
                await Task.Delay(100);
                Assert(window.IsVisible && await Script("!document.getElementById('bbPanel').hidden"),
                    "authorization preserves an explicitly opened window and restores its content");
            });
            await Run("background-error", async () =>
            {
                server.Mode = "identity";
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                using var visibility = new NativeVisibility(window);
                await window.StartAsync(background: true);
                await Until(() => Task.FromResult(Field<bool>(window, "_connectionFailed")), "background identity failure not received");
                await Task.Delay(100);
                Assert(!window.IsVisible && !IsWindowVisible(window.TryGetPlatformHandle()!.Handle) && visibility.ShowEvents == 0,
                    "background connection failure stays hidden without flashing a native window");
                window.BringForward();
                await Task.Delay(150);
                Assert(NoticeExposed(window) && Retry(window).IsEnabled,
                    "explicitly opening a failed background host exposes its error and retry action");
                server.Mode = "healthy";
                Retry(window).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Until(Authorized, "background failure retry did not authorize");
                Assert(window.IsVisible && await Script("!document.getElementById('bbPanel').hidden"),
                    "retry after a hidden startup failure restores the visible authorized panel");
            });
            await Run("background-call-error", async () =>
            {
                server.Mode = "identity";
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                window.StartConversation();
                await window.StartAsync(background: true);
                await Until(() => Task.FromResult(Field<bool>(window, "_connectionFailed")), "queued call identity failure not received");
                await Task.Delay(150);
                Assert(window.IsVisible && NoticeExposed(window) && Retry(window).IsEnabled
                    && !Field<BanbanVoiceService>(window, "_voice").Enabled,
                    "an explicit call exposes a startup failure without enabling audio capture");
            });
            await Run("background-shutdown", async () =>
            {
                server.Mode = "healthy";
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                using var visibility = new NativeVisibility(window);
                var startup = window.StartAsync(background: true);
                window.Shutdown();
                await startup;
                await Task.Delay(100);
                Assert(!window.IsVisible && Field<ReadingBrowser>(window, "_browser").Core is null && visibility.ShowEvents == 0,
                    "shutdown during hidden initialization releases the browser without displaying a window");
            });
            await Run("real-page", async () =>
            {
                server.Mode = "real-page";
                window = new BanbanVoiceWindow(binding, () => { }, enabled: false, petPreferencePath: preference);
                using var visibility = new NativeVisibility(window);
                await window.StartAsync(background: true);
                await Until(Authorized, "real classroom page did not authorize", 25);
                await Task.Delay(100);
                Assert(!window.IsVisible && !IsWindowVisible(window.TryGetPlatformHandle()!.Handle) && visibility.ShowEvents == 0,
                    "actual classroom scripts authorize in the background without displaying the native window");
                window.BringForward();
                Assert(await Script("!!window.ICeClass.state.user && !document.getElementById('bbPanel').hidden && getComputedStyle(document.getElementById('bbPanel')).display !== 'none'"),
                    "actual classroom scripts and CSS initialize the authorized voice window");
                await Until(() => Script("document.getElementById('bbRestore').hidden"), "real voice conversation did not initialize");
                Assert(await Script("(() => { const input=document.getElementById('bbInput'); input.value='隔离输入检查'; input.dispatchEvent(new Event('input')); const ready=!document.getElementById('bbSend').disabled; input.value=''; input.dispatchEvent(new Event('input')); return ready; })()"),
                    "the actual voice conversation accepts input after initialization");
                Assert(server.AuthorizedRequests > 0 && await Script("!JSON.stringify(window.ICeClass.state).includes('fixture-token-not-an-account')"),
                    "device authentication stays in native request headers");
            });
            await Run("reading", async () =>
            {
                var gaps = new List<double>();
                var heartbeat = Stopwatch.StartNew();
                var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(10) };
                timer.Tick += (_, _) => { gaps.Add(heartbeat.Elapsed.TotalMilliseconds); heartbeat.Restart(); };
                timer.Start();
                var startup = Stopwatch.StartNew();
                ReadingCompanionWindow? reading = null;
                try
                {
                    reading = new ReadingCompanionWindow(binding);
                    var constructorMs = startup.Elapsed.TotalMilliseconds;
                    reading.Show();
                    var load = reading.LoadAsync();
                    var firstYieldMs = startup.Elapsed.TotalMilliseconds;
                    await load;
                    var readyMs = startup.Elapsed.TotalMilliseconds;
                    var readingBrowser = Field<ReadingBrowser>(reading, "_browser");
                    Assert(!Field<Border>(reading, "_notice").IsVisible && readingBrowser.IsVisible,
                        "reading startup reaches its local homepage without a network dependency");
                    Assert(await readingBrowser.Core!.ExecuteScriptAsync("document.readyState === 'complete' && !document.body.classList.contains('reading-loading')") == "true",
                        "the real reading homepage completes its native bootstrap");
                    var metrics = new { constructorMs, firstYieldMs, readyMs, heartbeatTicks = gaps.Count,
                        maxUiGapMs = gaps.DefaultIfEmpty().Max(), scaling = reading.RenderScaling,
                        webView2 = readingBrowser.Core.Environment.BrowserVersionString };
                    Console.WriteLine("Reading startup: " + JsonSerializer.Serialize(metrics));
                    File.WriteAllText(Path.Combine(output, "reading-startup.json"), JsonSerializer.Serialize(metrics, new JsonSerializerOptions { WriteIndented = true }));
                }
                finally
                {
                    timer.Stop();
                    if (reading is not null) await reading.ReturnHomeAsync(false);
                    ReadingOfflineService.Stop();
                }
            });
            Assert(dispatcherErrors.Count == 0, "reconnect and disposal produce no unhandled dispatcher errors");
            File.WriteAllText(Path.Combine(output, "dispatcher-errors.json"), JsonSerializer.Serialize(dispatcherErrors));
            File.WriteAllText(Path.Combine(output, "requests.json"), JsonSerializer.Serialize(server.Requests));
            if (manual && _failures == 0)
            {
                server.Mode = "real-page";
                await Open(); await Until(Authorized, "manual review initialization", 25);
                var voiceWindow = window!;
                voiceWindow.Title += " · 本地隔离验收";
                // The installed client's voice preference is intentionally never
                // toggled by this fixture. Acoustic testing is outside its scope.
                await Field<ReadingBrowser>(voiceWindow, "_browser").Core!.ExecuteScriptAsync("document.querySelector('.bb-voice-button').disabled=true");
                var reading = new ReadingCompanionWindow(binding) { Title = "早读陪伴 · 本地隔离验收" };
                reading.Show(); await reading.LoadAsync();
                voiceWindow.BringForward();
                var openVoice = ClassroomStyle.Button("语音助手"); openVoice.Click += (_, _) => voiceWindow.BringForward();
                var openReading = ClassroomStyle.Button("早读陪伴"); openReading.Click += (_, _) => { reading.Show(); reading.Activate(); };
                var exit = ClassroomStyle.Button("结束验收");
                var controls = new Window { Title = "班班 · 本地隔离验收", Width = 440, Height = 170,
                    Content = new StackPanel { Margin = new Thickness(20), Spacing = 16, Children = {
                        ClassroomStyle.Text("虚构本机账号 · 语音采集已关闭"),
                        new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 12,
                            Children = { openVoice, openReading, exit } } } } };
                var ending = false;
                async void End()
                {
                    if (ending) return; ending = true;
                    voiceWindow.Shutdown(); await reading.ReturnHomeAsync(false); ReadingOfflineService.Stop();
                    ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown();
                }
                exit.Click += (_, _) => End(); controls.Closed += (_, _) => End();
                controls.Show(); voiceWindow.Activate();
                await Task.Delay(200);
                await using (var image = File.Create(Path.Combine(output, "voice-page.png")))
                    await Field<ReadingBrowser>(voiceWindow, "_browser").Core!.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                await using (var image = File.Create(Path.Combine(output, "reading-page.png")))
                    await Field<ReadingBrowser>(reading, "_browser").Core!.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);
                Console.WriteLine("REVIEW ready: fictional loopback account, disabled audio, fresh browser profile.");
                File.WriteAllText(Path.Combine(output, "review.json"), JsonSerializer.Serialize(new {
                    pid = Environment.ProcessId, server.Endpoint, voiceHandle = voiceWindow.TryGetPlatformHandle()!.Handle.ToInt64(),
                    readingHandle = reading.TryGetPlatformHandle()!.Handle.ToInt64(), scaling = voiceWindow.RenderScaling,
                    assembly = typeof(BanbanVoiceWindow).Assembly.Location }));
                await Task.Delay(Timeout.Infinite);
            }
        }
        catch (Exception error) { Assert(false, error.Message); Console.Error.WriteLine(error); }
        finally
        {
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(_results, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Banban voice window checks: {_results.Count - _failures}/{_results.Count} passed; scaling={window?.RenderScaling}");
            if (!manual || _failures != 0)
            {
                window?.Shutdown();
                Environment.ExitCode = _failures == 0 ? 0 : 1;
                ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
            }
        }
    }
    private static string FindRoot()
    {
        var directory = new DirectoryInfo(Environment.CurrentDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Receiver", "BanbanVoiceWindow.cs"))) directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Run from the ICeClass workspace.");
    }
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, NativePoint point, uint flags);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);

    private sealed class NativeVisibility : IDisposable
    {
        private delegate void WinEventCallback(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time);
        private readonly WinEventCallback _callback;
        private readonly IntPtr _hook;
        internal int ShowEvents { get; private set; }
        internal NativeVisibility(Window window)
        {
            var handle = window.TryGetPlatformHandle()!.Handle;
            _callback = (_, _, shown, objectId, childId, _, _) =>
            {
                if (shown == handle && objectId == 0 && childId == 0) ShowEvents++;
            };
            _hook = SetWinEventHook(0x8002 /* EVENT_OBJECT_SHOW */, 0x8002, IntPtr.Zero, _callback, (uint)Environment.ProcessId, 0, 0);
            if (_hook == IntPtr.Zero) throw new InvalidOperationException("Cannot observe native window visibility.");
        }
        public void Dispose() { UnhookWinEvent(_hook); GC.KeepAlive(_callback); }
        [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventCallback callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    }
}

internal sealed class FixtureServer : IDisposable
{
    internal const string UnassignedMessage = "此班级尚未分配可用的班主任账号，请联系管理员。";
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly string _root;
    private TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal string Mode = "healthy";
    internal bool PageRequested;
    internal int AuthorizedRequests;
    internal ConcurrentQueue<string> Requests { get; } = new();
    internal string Endpoint { get; }
    internal FixtureServer(string root)
    {
        _root = root;
        using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
        Endpoint = "http://127.0.0.1:" + ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        _listener.Prefixes.Add(Endpoint + "/"); _listener.Start();
        _ = Serve();
    }
    internal void ReleasePage() => _release.TrySetResult();
    internal void DelayPage()
    {
        Mode = "delayed"; PageRequested = false;
        _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private async Task Serve()
    {
        try { while (!_lifetime.IsCancellationRequested) { var context = await _listener.GetContextAsync().WaitAsync(_lifetime.Token); _ = Reply(context); } }
        catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
    }
    private async Task Reply(HttpListenerContext context)
    {
        try
        {
            var route = context.Request.Url!.AbsolutePath;
            Requests.Enqueue(Mode + " " + context.Request.HttpMethod + " " + route);
            var text = ""; var contentType = "text/html; charset=utf-8";
            byte[]? bytes = null;
            if (route == "/")
            {
                PageRequested = true;
                if (Mode == "navigation-error") { context.Response.Abort(); return; }
                if (Mode == "delayed") await _release.Task.WaitAsync(_lifetime.Token);
                if (Mode is "real-page" or "unassigned") text = (await File.ReadAllTextAsync(Path.Combine(_root, "web_controller", "index.html"))).Replace("<head>",
                    "<head><script>window.__fixtureErrors=[];addEventListener('error',e=>__fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>__fixtureErrors.push(String(e.reason)));</script>");
                else if (Mode == "identity") text = "<script>chrome.webview.postMessage({type:'banban-voice',kind:'identity-error',text:'隔离测试：账号关联失败，请重新连接。'});</script>";
                else text = """
                    <!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/banban.css"><link rel="stylesheet" href="/banban-voice.css"></head>
                    <body><div id="banbanRoot" class="banban-root"><section id="bbPanel" class="bb-panel" hidden><h2>班班 · 隔离语音验收</h2>
                    <form><textarea id="bbInput" placeholder="问问班班…"></textarea><span class="bb-privacy"></span></form></section></div>
                    <script src="/banban-voice.js"></script><script>
                    window.ICeClassBanbanOperations={cancelVoice:async()=>[]};
                    if (!location.hash && REPLACE_MOUNT) window.ICeClassBanbanVoice.mount({root:document.getElementById('banbanRoot'),open(){document.getElementById('bbPanel').hidden=false;},
                    setBinding(b){return b.classId==='fixture-class';},interrupt:async()=>{},ask:async()=>{}});
                    </script></body></html>
                    """.Replace("REPLACE_MOUNT", Mode == "no-bridge" ? "false" : "true");
            }
            else if (route.StartsWith("/api/", StringComparison.Ordinal))
            {
                contentType = "application/json";
                if (context.Request.Headers["Authorization"] == "Bearer fixture-token-not-an-account"
                    && context.Request.Headers["X-ICeClass-Class"] == "fixture-class") Interlocked.Increment(ref AuthorizedRequests);
                if (route == "/api/session" && Mode == "unassigned")
                {
                    context.Response.StatusCode = 401;
                    text = JsonSerializer.Serialize(new { authenticated = false, error = UnassignedMessage });
                }
                else
                text = route switch
                {
                    "/api/session" => """{"authenticated":true,"user":{"id":"fixture-teacher","username":"fixture-teacher","displayName":"隔离验收教师","role":"teacher","csrfToken":"fixture-csrf","permissions":{"receiveClassroomVoice":false,"assignableRoles":[]}}}""",
                    "/api/classes" => """{"classes":[{"id":"fixture-class","name":"隔离验收班级","enabled":1}]}""",
                    "/api/history" => """{"history":[],"hasMore":false}""",
                    "/api/quiet-hours" => """{"periods":[],"activePeriod":null}""",
                    "/api/presence" => """{"devices":[]}""",
                    "/api/banban/conversation" => """{"id":"fixture-conversation","messages":[],"hasMore":false}""",
                    "/api/banban/conversations" => """{"conversations":[],"nextCursor":null}""",
                    "/api/reading/offline/context" => ReadingContext(),
                    _ => "{}"
                };
            }
            else
            {
                var relative = Uri.UnescapeDataString(route).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                var assetRoot = Path.GetFullPath(Path.Combine(_root, "web_controller")) + Path.DirectorySeparatorChar;
                var file = Path.GetFullPath(Path.Combine(assetRoot, relative));
                if (!file.StartsWith(assetRoot, StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) { context.Response.StatusCode = 404; return; }
                bytes = await File.ReadAllBytesAsync(file);
                contentType = Path.GetExtension(file) switch { ".js" => "application/javascript", ".css" => "text/css", ".svg" => "image/svg+xml", ".webp" => "image/webp", ".woff2" => "font/woff2", _ => "application/octet-stream" };
            }
            bytes ??= Encoding.UTF8.GetBytes(text);
            context.Response.ContentType = contentType;
            context.Response.ContentLength64 = bytes.Length;
            context.Response.Headers["Cache-Control"] = "no-store";
            await context.Response.OutputStream.WriteAsync(bytes, _lifetime.Token);
        }
        catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException or IOException) { }
        finally { context.Response.Close(); }
    }
    private static string ReadingContext() => new JsonObject
    {
        ["classId"] = "fixture-class", ["className"] = "隔离验收班级", ["serverTime"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ["contextId"] = "fixture-context", ["config"] = JsonNode.Parse("""{"enabled":false,"reminderEnabled":false,"threshold":30,"periods":[],"classic":{"duration":15,"targetCount":10},"rocket":{"duration":15,"targetCount":10},"carving":{"speed":1},"particle":{"speed":1}}""")
    }.ToJsonString();
    public void Dispose() { _lifetime.Cancel(); _listener.Close(); _lifetime.Dispose(); }
}
#endif

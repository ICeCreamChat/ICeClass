#if TEACHER_ACTION_UI_CHECKS
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Desktop;
using ICeClass.Receiver;
using ICeClass.Updates;

var thread = new Thread(() => AppBuilder.Configure<TeacherActionsCheckApp>().UsePlatformDetect()
    .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();

public sealed class TeacherActionsCheckApp : Application
{
    private readonly App _product = new();
    public override void Initialize()
    {
        _product.Initialize(); RequestedThemeVariant = Avalonia.Styling.ThemeVariant.Light;
        foreach (var resource in _product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = _product.Styles.ToArray(); _product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted();
        Dispatcher.UIThread.Post(() => _ = Check());
    }
    private async Task Check()
    {
        var checks = 0;
        void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks++; }
        using var lifetime = new CancellationTokenSource();
        using var listener = new HttpListener();
        var signedIn = 1; var feedbackSent = 0; var pages = 0; var updateRequests = 0;
        var updateAvailable = 0; var downloaded = 0;
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-TeacherActions-" + Guid.NewGuid().ToString("N"));
        DesktopWindow? window = null;
        try
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
            var endpoint = "http://127.0.0.1:" + ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            listener.Prefixes.Add(endpoint + "/"); listener.Start();
            async Task Reply(HttpListenerContext context)
            {
                try
                {
                    var route = context.Request.Url!.AbsolutePath;
                    var json = route.StartsWith("/api/");
                    if (route == "/api/feedback") Interlocked.Increment(ref feedbackSent);
                    if (route.StartsWith("/api/desktop/update")) Interlocked.Increment(ref updateRequests);
                    if (route == "/api/desktop/update/payload") Interlocked.Increment(ref downloaded);
                    if (!json) Interlocked.Increment(ref pages);
                    var text = route == "/api/session" ? (Volatile.Read(ref signedIn) == 1
                        ? """{"authenticated":true,"user":{"username":"bridge-check","displayName":"本机桥检查","csrfToken":"test-csrf"}}"""
                        : """{"authenticated":false}""")
                        : route == "/api/desktop/update/plan" && Volatile.Read(ref updateAvailable) == 1
                        ? JsonSerializer.Serialize(new UpdatePlan { Available = true, Version = "9.9.9", Files = [new UpdateFile {
                            Path = "ICeClass.Desktop.exe", Size = 100, Sha256 = new string('a', 64), DownloadUrl = "/api/desktop/update/payload" }] }, TeacherActions.Json)
                        : json ? """{"available":false}"""
                        : "<!doctype html><html><head><title>Teacher bridge check</title></head><body>本机桥隔离检查</body></html>";
                    var bytes = Encoding.UTF8.GetBytes(text);
                    context.Response.ContentType = json ? "application/json" : "text/html";
                    context.Response.ContentLength64 = bytes.Length;
                    await context.Response.OutputStream.WriteAsync(bytes, lifetime.Token);
                }
                catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
                finally { context.Response.Close(); }
            }
            var serving = Task.Run(async () =>
            {
                try { while (!lifetime.IsCancellationRequested) { var context = await listener.GetContextAsync().WaitAsync(lifetime.Token); _ = Reply(context); } }
                catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
            });
            typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!.GetProperty("Options", BindingFlags.Static | BindingFlags.NonPublic)!
                .SetValue(null, LaunchOptions.Parse(["--server", endpoint, "--data-dir", directory]));
            typeof(App).GetProperty("Settings", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(_product, new DesktopSettings { Endpoint = endpoint, CloseToTray = false });
            typeof(App).GetField("_desktop", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_product, ApplicationLifetime);
            window = new DesktopWindow(_product, endpoint, false);
            typeof(App).GetField("_window", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_product, window);
            window.Show();
            var browser = (ReadingBrowser)typeof(DesktopWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            async Task Until(Func<Task<bool>> ready, string label)
            {
                for (var attempt = 0; attempt < 200; attempt++) { if (await ready()) return; await Task.Delay(50); }
                throw new Exception("Timed out: " + label);
            }
            await Until(() => Task.FromResult(browser.Core is not null), "WebView2 initialization");
            var core = browser.Core!;
            await Until(async () => await core.ExecuteScriptAsync("!!window.ICeClassTeacherHost && document.readyState === 'complete'") == "true", "embedded bridge injection");
            var toolbar = (Border)typeof(DesktopWindow).GetField("_toolbar", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            Assert(toolbar.IsVisible, "Loading and sign-in keep the native recovery tools available");
            await core.ExecuteScriptAsync("window.ICeClassTeacherHost.setWorkbenchHeader(true)");
            await Until(() => Task.FromResult(!toolbar.IsVisible), "unified workbench header");
            Assert(!toolbar.IsVisible, "A ready workbench replaces the duplicate native toolbar");
            await core.ExecuteScriptAsync("window.ICeClassTeacherHost.setWorkbenchHeader(false)");
            await Until(() => Task.FromResult(toolbar.IsVisible), "native recovery toolbar");
            async Task<JsonElement> Result(string expression)
            {
                await core.ExecuteScriptAsync("window.teacherActionTestResult = undefined; Promise.resolve(" + expression + ")" +
                    ".then(value => window.teacherActionTestResult = value, () => window.teacherActionTestResult = {thrown: true});");
                await Until(async () => await core.ExecuteScriptAsync("window.teacherActionTestResult !== undefined") == "true", "bridge receipt");
                return JsonSerializer.Deserialize<JsonElement>(await core.ExecuteScriptAsync("window.teacherActionTestResult"));
            }
            string Execute(string action, string id) => "window.ICeClassTeacherHost.execute(" + JsonSerializer.Serialize(action) + ", {}, " + JsonSerializer.Serialize(id) + ")";
            var catalog = await Result("window.ICeClassTeacherHost.catalog()");
            Assert(catalog.GetProperty("actions").GetArrayLength() == 0, "A real window without a login cookie advertises no native capabilities");
            var noLogin = await Result(Execute("teacher.about", "before-login"));
            Assert(!noLogin.GetProperty("success").GetBoolean() && noLogin.GetProperty("code").GetString() == "sign-in-required", "A real signed-out document cannot open native windows");
            var cookie = core.CookieManager.CreateCookie("iceclass_session", "test-bridge-session", "127.0.0.1", "/");
            cookie.IsSecure = false; cookie.IsHttpOnly = true; core.CookieManager.AddOrUpdateCookie(cookie);
            catalog = await Result("window.ICeClassTeacherHost.catalog()");
            var clientId = catalog.GetProperty("clientId").GetString();
            var ids = catalog.GetProperty("actions").EnumerateArray().Select(item => item.GetProperty("id").GetString()).ToArray();
            Assert(ids.SequenceEqual(new[] { "teacher.settings.open", "teacher.about", "teacher.feedback", "teacher.refresh", "teacher.updates.check", "teacher.voice.download" }), "The real embedded script receives exactly the six registered actions, including local voice preparation");
            Assert(catalog.GetProperty("actions").EnumerateArray().All(item => item.GetProperty("fields").GetArrayLength() == 0), "The real catalog advertises only empty payload fields");
            Assert(!catalog.GetProperty("actions").EnumerateArray().Single(item => item.GetProperty("id").GetString() == "teacher.refresh")
                .GetProperty("confirmation").GetBoolean(), "Refresh catalog avoids a server confirmation card while retaining the native confirmation");
            Assert((await Result("window.ICeClassTeacherHost.execute('teacher.about', {password: 'never-logged'}, 'invalid-fields')")).GetProperty("code").GetString() == "invalid-fields", "Native field validation survives the WebView transport");
            Assert((await Result(Execute("teacher.unknown", "unknown"))).GetProperty("code").GetString() == "unknown-action", "Unknown native actions fail through the real bridge");

            // The harness uses a secondary window as the app's main window. Give
            // its settings the normal voice preparation without starting downloads.
            typeof(DesktopWindow).GetMethod("InitializeVoiceResources", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(window, null);
            var settings = await Result(Execute("teacher.settings.open", "settings"));
            Assert(settings.GetProperty("state").GetString() == "opened" && window.OwnedWindows.OfType<SettingsWindow>().Count() == 1,
                "Settings reports opened while the real unsaved settings dialog is visible");
            window.OwnedWindows.OfType<SettingsWindow>().Single().Close(null);
            Assert(!File.Exists(Path.Combine(directory, "settings.json")), "Opening and cancelling settings never saves settings");
            var about = await Result(Execute("teacher.about", "about-once"));
            Assert(about.GetProperty("verified").GetBoolean() && about.GetProperty("state").GetString() == "opened" && window.OwnedWindows.Count() == 1,
                "About receipts verify an actual opened window");
            await Result(Execute("teacher.about", "about-once"));
            Assert(window.OwnedWindows.Count() == 1, "Repeated operations do not open another about dialog");
            window.OwnedWindows.Single().Close();
            var feedback = await Result(Execute("teacher.feedback", "feedback"));
            Assert(feedback.GetProperty("state").GetString() == "opened" && window.OwnedWindows.OfType<TeacherFeedbackWindow>().Count() == 1 && feedbackSent == 0,
                "Feedback opens the original form without sending feedback");
            window.OwnedWindows.OfType<TeacherFeedbackWindow>().Single().Close();
            var update = await Result(Execute("teacher.updates.check", "update"));
            Assert(update.GetProperty("state").GetString() == "checked" && !update.GetProperty("updateAvailable").GetBoolean() && updateRequests > 0 && !window.OwnedWindows.Any(),
                "Update check reuses the native checker without prompting download or installation");
            Volatile.Write(ref updateAvailable, 1);
            update = await Result(Execute("teacher.updates.check", "update-available"));
            Assert(update.GetProperty("updateAvailable").GetBoolean() && update.GetProperty("version").GetString() == "9.9.9" &&
                downloaded == 0 && !window.OwnedWindows.Any(), "Finding an update never downloads, installs, restarts, or opens an install confirmation");

            await core.ExecuteScriptAsync("const frame = document.createElement('iframe'); frame.id = 'bridge-child'; frame.src = '/child'; document.body.appendChild(frame);");
            await Until(async () => await core.ExecuteScriptAsync("document.querySelector('#bridge-child').contentDocument?.readyState === 'complete'") == "true", "same-origin iframe");
            Assert(await core.ExecuteScriptAsync("typeof document.querySelector('#bridge-child').contentWindow.ICeClassTeacherHost") == "\"undefined\"", "The bridge is not injected into a same-origin iframe");
            await core.ExecuteScriptAsync("document.querySelector('#bridge-child').contentWindow.chrome.webview.postMessage({type:'iceclass-teacher-action',requestId:crypto.randomUUID(),clientId:window.ICeClassTeacherHost.clientId,method:'execute',action:'teacher.about',payload:{},operationId:'iframe-spoof'});");
            await Task.Delay(200);
            Assert(!window.OwnedWindows.Any(), "Frame WebView messages cannot invoke the main-frame native bridge");
            await core.ExecuteScriptAsync("window.ICeClassTeacherHost.setWorkbenchHeader(true)");
            await Until(() => Task.FromResult(!toolbar.IsVisible), "unified header before frame message");
            await core.ExecuteScriptAsync("document.querySelector('#bridge-child').contentWindow.chrome.webview.postMessage({type:'iceclass-teacher-shell',ready:false});");
            await Task.Delay(200);
            Assert(!toolbar.IsVisible, "A child frame cannot change the main workbench toolbar");
            await core.ExecuteScriptAsync("window.ICeClassTeacherHost.setWorkbenchHeader(false)");
            await Until(() => Task.FromResult(toolbar.IsVisible), "recovery toolbar after frame check");
            Volatile.Write(ref signedIn, 0);
            Assert((await Result("window.ICeClassTeacherHost.catalog()")).GetProperty("actions").GetArrayLength() == 0, "Server-side logout hides native capabilities even while the old cookie remains");
            Assert(!(await Result(Execute("teacher.about", "about-once"))).GetProperty("success").GetBoolean() && !window.OwnedWindows.Any(),
                "Receipt dedup cannot bypass server-side logout");
            Volatile.Write(ref signedIn, 1);
            var beforeCancel = Volatile.Read(ref pages);
            var cancelling = Result(Execute("teacher.refresh", "refresh-cancelled"));
            await Until(() => Task.FromResult(window.OwnedWindows.Any()), "cancel refresh confirmation");
            window.OwnedWindows.Single().GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "取消")
                .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            var cancelled = await cancelling;
            Assert(cancelled.GetProperty("state").GetString() == "cancelled" && cancelled.GetProperty("verified").GetBoolean() && pages == beforeCancel,
                "Cancelling the original refresh confirmation leaves the document unchanged");
            var logoutRefresh = Result(Execute("teacher.refresh", "logout-during-refresh"));
            await Until(() => Task.FromResult(window.OwnedWindows.Any()), "refresh logout confirmation");
            Volatile.Write(ref signedIn, 0);
            window.OwnedWindows.Single().GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "刷新")
                .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert(!(await logoutRefresh).GetProperty("success").GetBoolean() && pages == beforeCancel,
                "Logout while a refresh confirmation is open prevents navigation");
            Volatile.Write(ref signedIn, 1);
            var before = Volatile.Read(ref pages);
            await core.ExecuteScriptAsync("window.chrome.webview.addEventListener('message', event => { if(event.data.result?.state === 'started') sessionStorage.setItem('refreshReceipt', JSON.stringify(event.data.result)); });" +
                Execute("teacher.refresh", "refresh") + ";");
            await Until(() => Task.FromResult(window.OwnedWindows.Any()), "refresh confirmation");
            var confirm = window.OwnedWindows.Single();
            confirm.GetVisualDescendants().OfType<Button>().Single(button => button.Content as string == "刷新").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Until(async () => Volatile.Read(ref pages) > before && await core.ExecuteScriptAsync("!!window.ICeClassTeacherHost && document.readyState === 'complete'") == "true", "confirmed refresh");
            Assert(await core.ExecuteScriptAsync("JSON.parse(sessionStorage.getItem('refreshReceipt'))?.verified === false") == "true", "Refresh receipt is delivered as started and unverified before navigation");
            catalog = await Result("window.ICeClassTeacherHost.catalog()");
            Assert(catalog.GetProperty("clientId").GetString() != clientId, "Actual reload creates a fresh bridge document ID");
            Assert((await Result(Execute("teacher.about", "about-once"))).GetProperty("code").GetString() == "operation-conflict" && !window.OwnedWindows.Any(),
                "The window retains operation dedup across real document navigation");
            await _product.Diagnostics.FlushAsync(default);
            Assert(!DesktopDiagnostics.ActivityReport(directory).Contains("never-logged"), "Bridge payloads do not fall through to diagnostic logging");
            Assert(feedbackSent == 0, "No bridge check sent feedback mail");
            lifetime.Cancel(); listener.Close(); await serving;
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            lifetime.Cancel(); listener.Close(); window?.Close(); _product.Diagnostics.Dispose();
            Console.WriteLine($"Teacher action WebView2 checks: {checks}; exit={Environment.ExitCode}");
            ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}
#endif

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
        TaskCompletionSource? holdNextSession = null;
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-TeacherActions-" + Guid.NewGuid().ToString("N"));
        DesktopWindow? window = null;
        try
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
            var endpoint = "http://127.0.0.1:" + ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            DirectoryInfo? source = new DirectoryInfo(AppContext.BaseDirectory);
            while (source is not null && !File.Exists(Path.Combine(source.FullName, "web_controller", "index.html"))) source = source.Parent;
            var webRoot = Path.Combine(source?.FullName ?? throw new DirectoryNotFoundException("web_controller"), "web_controller");
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
                    if (route is "/" or "/workbench") Interlocked.Increment(ref pages);
                    if (route == "/api/session" && Interlocked.Exchange(ref holdNextSession, null) is { } pending)
                        await pending.Task.WaitAsync(lifetime.Token);
                    if (route == "/api/refresh-check/expired") context.Response.StatusCode = 401;
                    if (!json && route != "/")
                    {
                        var asset = Path.GetFullPath(Path.Combine(webRoot, route == "/workbench" ? "index.html" : route.TrimStart('/')));
                        if (!asset.StartsWith(webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(asset))
                        { context.Response.StatusCode = 404; return; }
                        context.Response.ContentType = Path.GetExtension(asset) switch
                        {
                            ".html" => "text/html; charset=utf-8", ".js" => "text/javascript", ".css" => "text/css", ".json" => "application/json",
                            ".svg" => "image/svg+xml", ".png" => "image/png", ".webp" => "image/webp", ".woff2" => "font/woff2", _ => "application/octet-stream"
                        };
                        context.Response.Headers["Cache-Control"] = "no-store";
                        await using var content = File.OpenRead(asset);
                        context.Response.ContentLength64 = content.Length;
                        await content.CopyToAsync(context.Response.OutputStream, lifetime.Token);
                        return;
                    }
                    var text = route == "/api/session" ? (Volatile.Read(ref signedIn) == 1
                        ? """{"authenticated":true,"user":{"id":"test-teacher","username":"bridge-check","displayName":"本机桥检查","csrfToken":"test-csrf","role":"superadmin","permissions":{"receiveClassroomVoice":true,"assignableRoles":[]}}}"""
                        : """{"authenticated":false}""")
                        : route == "/api/desktop/update/plan" && Volatile.Read(ref updateAvailable) == 1
                        ? JsonSerializer.Serialize(new UpdatePlan { Available = true, Version = "9.9.9", Files = [new UpdateFile {
                            Path = "ICeClass.Desktop.exe", Size = 100, Sha256 = new string('a', 64), DownloadUrl = "/api/desktop/update/payload" }] }, TeacherActions.Json)
                        : route switch
                        {
                            "/api/classes" => """{"classes":[{"id":"c1","name":"隔离验收班级","enabled":1}]}""",
                            "/api/teachers" => """{"teachers":[]}""", "/api/devices" or "/api/classroom-controls" => """{"devices":[]}""",
                            "/api/history" => """{"history":[]}""", "/api/classroom-voice" => """{"messages":[]}""",
                            "/api/quiet-hours" => """{"periods":[],"activePeriod":null}""",
                            "/api/reading/settings" => """{"config":{"enabled":true,"threshold":30,"reminderEnabled":true,"periods":[]}}""",
                            "/api/reading/report" => """{"grades":[],"rows":[],"daily":[]}""",
                            "/api/refresh-check/expired" => """{"error":"登录已过期"}""",
                            "/" => "<!doctype html><html><head><title>Teacher bridge check</title></head><body>本机桥隔离检查</body></html>",
                            _ => """{"available":false}"""
                        };
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
            // Use the real workbench scripts and markup for the desktop header and confirmation flow.
            bool NoNativeDialog() => !window.OwnedWindows.Any();
            Task<string> JavaScript(string script) => core.ExecuteScriptAsync(script);
            Task WaitForPage(string label) => Until(async () => await JavaScript(
                "document.readyState === 'complete' && !!window.ICeClass?.state.user && !!window.ICeClassUI && !document.getElementById('appShell').classList.contains('hidden')") == "true", label);
            Task WaitForConfirm(string label) => Until(async () => await JavaScript("!!document.getElementById('workbenchConfirm')?.open") == "true", label);
            Task<string> Click(string id) => JavaScript("document.getElementById(" + JsonSerializer.Serialize(id) + ").click()");
            const string changeDraft = "const field = document.getElementById('shoutText'); field.focus(); field.value = text; field.dispatchEvent(new Event('input', {bubbles:true}));";
            Task<string> Draft(string value) => JavaScript("((text) => { " + changeDraft + " })(" + JsonSerializer.Serialize(value) + ")");
            await Until(() => Task.FromResult(core.Source.StartsWith(endpoint, StringComparison.Ordinal)), "ready to open workbench");
            core.Navigate(endpoint + "/workbench");
            await WaitForPage("production workbench");
            await Until(() => Task.FromResult(!toolbar.IsVisible), "production header replaces the native fallback");
            await ClickInView("console");
            await Draft("保留的通知草稿");
            var productionPages = Volatile.Read(ref pages);
            await JavaScript("""
                (() => {
                  const direct = document.getElementById('teacherRefresh');
                  if (direct.getClientRects().length) { direct.focus(); direct.click(); }
                  else { document.getElementById('headerToolsToggle').click(); document.querySelector('.compact-refresh').click(); }
                })()
                """);
            await WaitForConfirm("production refresh confirmation");
            Assert(NoNativeDialog() && await JavaScript("document.getElementById('workbenchConfirmText').textContent.includes('待发送通知')") == "true",
                "The desktop refresh action uses the web confirmation with the actual notification draft");
            await Click("workbenchConfirmCancel");
            await Until(async () => await JavaScript("!document.querySelector('[data-header-native][aria-disabled=true]')") == "true", "production cancellation receipt");
            Assert(await JavaScript("""
                (() => {
                  const direct = document.getElementById('teacherRefresh');
                  return document.activeElement === (direct.getClientRects().length ? direct : document.getElementById('headerToolsToggle'));
                })()
                """) == "true", "Cancelled desktop refresh restores the header trigger for keyboard users");
            await Draft("取消后继续编辑");
            Assert(await JavaScript("document.getElementById('shoutText').value === '取消后继续编辑'") == "true" && pages == productionPages,
                "Cancelling the production confirmation keeps the draft editable in the same document");

            var duringCheck = Result(Execute("teacher.refresh", "edit-after-refresh-consent"));
            await WaitForConfirm("confirmation before desktop session recheck");
            var releaseSession = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Volatile.Write(ref holdNextSession, releaseSession);
            await Click("workbenchConfirmAccept");
            try
            {
                await Until(() => Task.FromResult(Volatile.Read(ref holdNextSession) is null), "desktop session recheck after confirmation");
                await Draft("确认后新增的草稿");
            }
            finally { releaseSession.TrySetResult(); }
            Assert((await duringCheck).GetProperty("state").GetString() == "started", "The desktop reports acceptance while the reload still needs execution");
            await Until(async () => await JavaScript("document.getElementById('toastRegion').textContent.includes('刷新未执行')") == "true", "new edits invalidate refresh consent");
            Assert(await JavaScript("document.getElementById('shoutText').value === '确认后新增的草稿'") == "true" && pages == productionPages,
                "A change made while the desktop checks the account blocks stale consent and preserves the new draft");

            var expiring = Result(Execute("teacher.refresh", "expired-production-session"));
            await WaitForConfirm("confirmation before session expiry");
            await JavaScript("void ICeClass.api('/api/refresh-check/expired').catch(() => {});");
            await Until(async () => await JavaScript("!document.getElementById('sessionExpired').hidden") == "true", "production 401 response");
            await Click("workbenchConfirmAccept");
            Assert((await expiring).GetProperty("state").GetString() == "cancelled" && pages == productionPages && NoNativeDialog(),
                "A session expiry during the web confirmation prevents desktop reload without a second prompt");

            await JavaScript("document.getElementById('shoutText').value = ''; document.getElementById('shoutText').dispatchEvent(new Event('input', {bubbles:true}));");
            var currentId = await JavaScript("ICeClassTeacherHost.clientId");
            await JavaScript(Execute("teacher.refresh", "replace-production-document") + ";");
            await WaitForConfirm("confirmation before loading a different document");
            core.Navigate(endpoint + "/workbench?document=second");
            await Until(async () => await JavaScript("ICeClassTeacherHost.clientId") != currentId && core.Source.EndsWith("document=second", StringComparison.Ordinal), "replacement workbench document");
            await WaitForPage("replacement workbench ready");
            Assert(pages == productionPages + 1 && NoNativeDialog() && await JavaScript("!document.getElementById('workbenchConfirm').open") == "true",
                "Replacing the workbench abandons the old refresh confirmation");

            await ClickInView("console");
            await Draft("已确认放弃的草稿");
            currentId = await JavaScript("ICeClassTeacherHost.clientId");
            var beforeProductionReload = Volatile.Read(ref pages);
            await JavaScript(Execute("teacher.refresh", "confirm-production-document") + ";");
            await WaitForConfirm("one production confirmation");
            await Click("workbenchConfirmAccept");
            await Until(async () => Volatile.Read(ref pages) > beforeProductionReload && await JavaScript("ICeClassTeacherHost.clientId") != currentId, "confirmed production reload");
            await WaitForPage("reloaded production workbench ready");
            Assert(pages == beforeProductionReload + 1 && NoNativeDialog() && await JavaScript("!document.getElementById('workbenchConfirm').open") == "true",
                "Confirming the production dialog reloads exactly once and bypasses the beforeunload prompt");
            Assert(await JavaScript("document.getElementById('shoutText').value === ''") == "true", "The confirmed reload clears the old draft");

            Task<string> ClickInView(string view) => JavaScript("document.querySelector('#mainNav [data-view=' + " + JsonSerializer.Serialize(view) + " + ']').click()");
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

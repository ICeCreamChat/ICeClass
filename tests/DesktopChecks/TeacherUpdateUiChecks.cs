using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
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

internal static class TeacherUpdateUiChecks
{
    internal static string Output = "";
    internal static void Run(string output)
    {
        Output = Path.GetFullPath(output);
        var thread = new Thread(() => AppBuilder.Configure<TeacherUpdateCheckApp>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

public sealed class TeacherUpdateCheckApp : Application
{
    private readonly App _product = new();
    public override void Initialize()
    {
        _product.Initialize();
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
        var checks = new List<string>();
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks.Add(label); }
        static void Set(object instance, string field, object value) => instance.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(instance, value);
        static T Field<T>(object instance, string field) => (T)instance.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(instance)!;
        static void Click(Window dialog, string label) => dialog.GetVisualDescendants().OfType<Button>()
            .Single(button => button.Content as string == label).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        async Task Until(Func<bool> ready)
        {
            for (var attempt = 0; attempt < 200 && !ready(); attempt++) await Task.Delay(50);
            Assert(ready(), "Teacher window operation completed within its deadline");
        }
        using var lifetime = new CancellationTokenSource();
        using var listener = new HttpListener();
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-TeacherUpdateUi-" + Guid.NewGuid().ToString("N"));
        var pending = Path.Combine(AppContext.BaseDirectory, ".updates", "pending.json");
        var ownsPending = false;
        DesktopWindow? window = null;
        try
        {
            if (File.Exists(pending)) throw new Exception("UI checks require an isolated output directory without pending updates");
            ownsPending = true;
            using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
            var endpoint = "http://127.0.0.1:" + ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            listener.Prefixes.Add(endpoint + "/"); listener.Start();
            var bytes = Encoding.UTF8.GetBytes("teacher UI fixture; never installed");
            var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            var known = 0; var payloads = 0; var activityReads = 0; var retired = 0;
            var releaseVersion = "9.9.9";
            async Task Reply(HttpListenerContext context)
            {
                try
                {
                    var path = context.Request.Url!.AbsolutePath;
                    var serverTime = DateTimeOffset.UtcNow;
                    object body = new { available = false };
                    var content = "application/json";
                    if (path == "/api/desktop/update/plan") body = new { available = true, version = Volatile.Read(ref releaseVersion), files = new[] {
                        new { path = "ICeClass.Desktop.exe", size = bytes.Length, sha256 = hash, downloadUrl = "/api/desktop/update/payload?sha256=" + hash } } };
                    else if (path == "/api/desktop/update/activity")
                    {
                        Interlocked.Increment(ref activityReads);
                        if (context.Request.Cookies["iceclass_session"]?.Value != "local-ui-session") context.Response.StatusCode = 401;
                        // HTTP.sys caches its automatic Date header. A shorter
                        // valid lease keeps this fixture within the protocol cap.
                        body = new { known = Volatile.Read(ref known) != 0, inClass = false, validUntil = serverTime.AddSeconds(10).ToUnixTimeMilliseconds() };
                    }
                    else if (path == "/api/desktop/update/payload")
                    { Interlocked.Increment(ref payloads); if (Volatile.Read(ref retired) != 0) context.Response.StatusCode = 404; }
                    else { content = "text/html"; body = "<!doctype html><html><head><title>教师更新本地检查</title></head><body>仅本机测试</body></html>"; }
                    var data = path == "/api/desktop/update/payload" ? bytes : Encoding.UTF8.GetBytes(content == "text/html" ? (string)body : JsonSerializer.Serialize(body));
                    context.Response.ContentType = content; context.Response.ContentLength64 = data.Length;
                    await context.Response.OutputStream.WriteAsync(data, lifetime.Token);
                }
                catch (Exception error) when (error is HttpListenerException or OperationCanceledException or ObjectDisposedException) { }
                finally { context.Response.Close(); }
            }
            var serving = Task.Run(async () =>
            {
                try { while (!lifetime.IsCancellationRequested) { var context = await listener.GetContextAsync().WaitAsync(lifetime.Token); _ = Reply(context); } }
                catch (Exception error) when (error is HttpListenerException or OperationCanceledException or ObjectDisposedException) { }
            });
            typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!.GetProperty("Options", BindingFlags.Static | BindingFlags.NonPublic)!
                .SetValue(null, LaunchOptions.Parse(["--server", endpoint, "--data-dir", directory]));
            window = new DesktopWindow(_product, endpoint, main: false); window.Show();
            var action = new NativeMenuItem { Header = "检查桌面更新" };
            Set(_product, "_desktop", ApplicationLifetime!); Set(_product, "_window", window); Set(_product, "_updateAction", action);
            var browser = Field<ReadingBrowser>(window, "_browser");
            await Until(() => Field<bool>(window, "_navigated"));
            var cookie = browser.Core!.CookieManager.CreateCookie("iceclass_session", "local-ui-session", "127.0.0.1", "/");
            cookie.IsSecure = false; cookie.IsHttpOnly = true; browser.Core.CookieManager.AddOrUpdateCookie(cookie);
            await Task.Delay(100);
            Assert(_product.UpdateBusy(true), "A visible main window prevents automatic downloads");
            window.Hide(); Assert(!_product.UpdateBusy(true), "A hidden idle window can become eligible for an automatic download"); window.Show();

            async Task StartDownload()
            {
                var check = window.CheckUpdatesAsync();
                await Until(() => window.OwnedWindows.Any());
                var dialog = window.OwnedWindows.Single();
                Assert(dialog.GetVisualDescendants().OfType<Button>().Any(button => button.Content as string == "下载"), "A new update prompts Download");
                Assert(_product.UpdateBusy(false), "An open native dialog blocks update preparation");
                Click(dialog, "下载"); await check.WaitAsync(TimeSpan.FromSeconds(10));
            }
            await StartDownload();
            Assert(Field<TextBlock>(window, "_status").Text!.Contains("课表状态不可用") && payloads == 0,
                "An unknown schedule is explicitly shown and no payload starts");
            Volatile.Write(ref releaseVersion, "9.9.10");
            window.Hide();
            using (var watchLifetime = new CancellationTokenSource())
            {
                var watching = (Task)typeof(DesktopWindow).GetMethod("WatchDesktopUpdatesAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(window, [watchLifetime.Token])!;
                try { await Until(() => Volatile.Read(ref activityReads) >= 2); }
                finally { watchLifetime.Cancel(); await watching.WaitAsync(TimeSpan.FromSeconds(3)); window.Show(); }
            }
            Assert(Field<DesktopUpdate>(window, "_offeredUpdate").Version == "9.9.10", "Automatic checks refresh a cached offer before retrying after a pause");
            Volatile.Write(ref known, 1);
            Volatile.Write(ref retired, 1);
            var cached = Path.Combine(AppContext.BaseDirectory, ".updates", "resume-ui-check.download");
            File.WriteAllText(cached, "retained partial download");
            var failed = (Task)typeof(DesktopWindow).GetMethod("PrepareUpdateAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(window, [Field<DesktopUpdate>(window, "_offeredUpdate"), false])!;
            try { await failed; throw new Exception("A retired payload unexpectedly downloaded"); }
            catch (HttpRequestException error) when (error.StatusCode == HttpStatusCode.NotFound) { }
            Assert(Field<DesktopUpdate?>(window, "_offeredUpdate") is null, "Retired payload hashes invalidate the cached offer for the next check");
            Assert(File.ReadAllText(cached) == "retained partial download", "Invalidating a retired plan retains resumable download files"); File.Delete(cached);
            Volatile.Write(ref retired, 0); Volatile.Write(ref releaseVersion, "9.9.11");
            var installed = Path.Combine(AppContext.BaseDirectory, "ICeClass.Desktop.exe");
            var before = File.ReadAllBytes(installed);
            await StartDownload();
            Assert(UpdateInstaller.LoadPending(AppContext.BaseDirectory, "ICeClass.Desktop.exe")?.Version == "9.9.11", "Download persists a prepared pending update from the latest offer; status=" + Field<TextBlock>(window, "_status").Text);
            Assert(File.ReadAllBytes(installed).SequenceEqual(before) && !File.Exists(Path.Combine(AppContext.BaseDirectory, ".updates", "apply-incremental-update.ps1")),
                "Completing the download leaves the running program intact and does not start installation");
            Assert(action.Header as string == "立即更新", "The ready tray action becomes Update now");
            var ready = window.CheckUpdatesAsync();
            await Until(() => window.OwnedWindows.Any());
            var readyDialog = window.OwnedWindows.Single();
            Assert(readyDialog.GetVisualDescendants().OfType<Button>().Any(button => button.Content as string == "立即更新"), "Already-ready checks prompt Update now");
            Click(readyDialog, "取消"); await ready;
            Assert(window.IsVisible && !_product.ExitRequested, "Cancelling Update now keeps the teacher window open");
            lifetime.Cancel(); listener.Close(); await serving;
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            lifetime.Cancel(); listener.Close(); window?.Close();
            if (ownsPending && File.Exists(pending)) File.Delete(pending);
            Directory.CreateDirectory(TeacherUpdateUiChecks.Output);
            File.WriteAllText(Path.Combine(TeacherUpdateUiChecks.Output, "teacher-update-ui.json"), JsonSerializer.Serialize(new { passed = Environment.ExitCode == 0, checks }));
            Console.WriteLine($"{checks.Count} teacher update UI checks passed; exit={Environment.ExitCode}.");
            ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

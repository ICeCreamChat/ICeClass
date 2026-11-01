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

internal static class FeedbackOpeningChecks
{
    internal static string Output = "";
    internal static void Run(string output)
    {
        Output = Path.GetFullPath(output);
        var thread = new Thread(() => AppBuilder.Configure<FeedbackOpeningCheckApp>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

public sealed class FeedbackOpeningCheckApp : Application
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
        var checks = new List<string>();
        void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        var releaseAccount = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var lifetime = new CancellationTokenSource();
        using var listener = new HttpListener();
        DesktopWindow? window = null;
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-FeedbackOpening-" + Guid.NewGuid().ToString("N"));
        var requests = 0;
        string? sentBody = null;
        try
        {
            using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
            var endpoint = "http://127.0.0.1:" + ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            listener.Prefixes.Add(endpoint + "/"); listener.Start();
            async Task Reply(HttpListenerContext context)
            {
                try
                {
                    var session = context.Request.Url!.AbsolutePath == "/api/session";
                    if (session) { Interlocked.Increment(ref requests); await releaseAccount.Task.WaitAsync(lifetime.Token); }
                    var send = context.Request.Url!.AbsolutePath == "/api/feedback";
                    var diagnosticRequest = context.Request.Url!.AbsolutePath.StartsWith("/api/diagnostic-check");
                    if (send)
                    {
                        using var reader = new StreamReader(context.Request.InputStream);
                        Volatile.Write(ref sentBody, await reader.ReadToEndAsync(lifetime.Token));
                    }
                    if (context.Request.Url.AbsolutePath.EndsWith("/fail")) context.Response.StatusCode = 503;
                    var text = diagnosticRequest ? "{\"value\":\"preserved-response\"}"
                        : send ? JsonSerializer.Serialize(new { id = Guid.NewGuid().ToString(), status = "sent" })
                        : session ? """{"authenticated":true,"user":{"username":"feedback-check","displayName":"本地检查","csrfToken":"check-csrf"}}"""
                        : "<!doctype html><html><head><title>Feedback opening check</title></head><body>Local check</body></html>";
                    var bytes = Encoding.UTF8.GetBytes(text);
                    context.Response.ContentType = diagnosticRequest || session || send ? "application/json" : "text/html";
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
            window = new DesktopWindow(_product, endpoint, false); window.Show();
            var browser = (ReadingBrowser)typeof(DesktopWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            async Task Until(Func<bool> ready)
            {
                for (var attempt = 0; attempt < 100 && !ready(); attempt++) await Task.Delay(50);
                if (!ready()) throw new Exception("Feedback opening state timed out");
            }
            await Until(() => browser.Core is not null);
            await Until(() => (bool)typeof(DesktopWindow).GetField("_navigated", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!);
            await browser.Core!.ExecuteScriptAsync("""
                (async () => {
                  const response = await fetch('/api/diagnostic-check?token=private-query');
                  window.diagnosticResponse = (await response.json()).value;
                  await fetch('/api/diagnostic-check?token=private-second-query');
                  await fetch('/api/diagnostic-check/fail?password=private-password');
                  const cancelled = new AbortController(); cancelled.abort();
                  try { await fetch('/api/diagnostic-check/cancelled', {signal: cancelled.signal}); }
                  catch (error) { window.diagnosticRejection = error.name; }
                  const button = document.createElement('button'); button.textContent = '查询';
                  document.body.appendChild(button); button.click();
                  const privateButton = document.createElement('button'); privateButton.textContent = 'private-button';
                  document.body.appendChild(privateButton); privateButton.click();
                  location.hash = 'island';
                  window.dispatchEvent(new ErrorEvent('error', {filename: location.origin + '/app.js?token=private-script', lineno: 12, colno: 3, error: new TypeError('private-message')}));
                  window.diagnosticCheckDone = true;
                })();
                """);
            for (var attempt = 0; attempt < 100 && await browser.Core.ExecuteScriptAsync("window.diagnosticCheckDone === true") != "true"; attempt++) await Task.Delay(50);
            Assert(await browser.Core.ExecuteScriptAsync("window.diagnosticResponse") == "\"preserved-response\"",
                "Injected diagnostics preserve the fetch response and body for the application");
            Assert(await browser.Core.ExecuteScriptAsync("window.diagnosticRejection") == "\"AbortError\"",
                "Injected diagnostics preserve fetch cancellation instead of swallowing or changing the rejection");
            await Task.Delay(100); await _product.Diagnostics.FlushAsync(default);
            var journal = DesktopDiagnostics.ActivityReport(directory);
            Assert(journal.Contains("diagnostic-check/fail") && journal.Contains("HTTP 503") && journal.Contains(" ms") && journal.Contains("action / 查询"),
                "The real WebView bridge records actions, request failures and timings");
            Assert(journal.Contains("TypeError") && journal.Contains("/app.js:12:3") && !journal.Contains("private-"),
                "Browser errors include their type and source without request queries or arbitrary input text");
            Assert(journal.Split('\n').Count(line => line.Contains("/api/diagnostic-check | HTTP 200")) == 1,
                "Repeated successful polling requests are coalesced");
            var cookie = browser.Core!.CookieManager.CreateCookie("iceclass_session", "check-session", "127.0.0.1", "/");
            cookie.IsSecure = false; cookie.IsHttpOnly = true; browser.Core.CookieManager.AddOrUpdateCookie(cookie);
            await Task.Delay(100);
            var button = window.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "反馈");
            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert(!button.IsEnabled, "The feedback action acknowledges the click before account validation finishes");
            await Until(() => Volatile.Read(ref requests) == 1);
            Assert(!window.OwnedWindows.OfType<TeacherFeedbackWindow>().Any(), "The feedback form stays closed until login is validated");
            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Task.Delay(100);
            Assert(Volatile.Read(ref requests) == 1, "Repeated clicks cannot start concurrent account requests");
            releaseAccount.SetResult();
            await Until(() => window.OwnedWindows.OfType<TeacherFeedbackWindow>().Any());
            Assert(button.IsEnabled && button.Content as string == "反馈", "The action returns to its normal state after opening");
            var feedback = window.OwnedWindows.OfType<TeacherFeedbackWindow>().Single();
            feedback.Close();
            Assert(!window.OwnedWindows.OfType<TeacherFeedbackWindow>().Any(), "Closing feedback leaves the workbench available");

            TeacherFeedbackWindow Form(Func<CancellationToken, Task<string>> collect)
            {
                var client = new TeacherFeedbackClient(endpoint, () => Task.FromResult<string?>("check-session"));
                var account = new FeedbackAccount("check-session", "check-csrf", "feedback-check", "本地检查");
                var form = new TeacherFeedbackWindow(client, account,
                    () => throw new NotImplementedException(), () => endpoint, collect);
                form.Show(window); return form;
            }
            static Button Action(Window form, string name) => form.GetVisualDescendants().OfType<Button>()
                .Single(action => action.Content as string == name);
            static void Click(Button action) => action.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));

            var logReads = 0;
            var releaseLogs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            feedback = Form(token => { logReads++; return releaseLogs.Task.WaitAsync(token); });
            Assert(logReads == 0, "Opening the form does not read diagnostic logs");
            var preview = Action(feedback, "预览日志");
            Click(preview);
            Assert(!preview.IsEnabled, "Log preview acknowledges the click while logs are loading");
            Click(preview);
            var description = feedback.GetVisualDescendants().OfType<TextBox>().Single(box => box.AcceptsReturn);
            description.Text = "本地自动检查，不发送真实邮件。";
            await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);
            Assert(description.IsEffectivelyEnabled && Action(feedback, "取消").IsEnabled,
                "The draft and cancel action remain usable while logs are loading");
            releaseLogs.SetResult("feedback-check diagnostic log");
            await Until(() => feedback.OwnedWindows.Any());
            Assert(logReads == 1 && feedback.OwnedWindows.Count() == 1,
                "Repeated preview clicks share one log read and open one preview");
            feedback.OwnedWindows.Single().Close();
            await Until(() => preview.IsEnabled);
            Click(Action(feedback, "发送反馈"));
            await Until(() => feedback.GetVisualDescendants().OfType<Button>().Any(b => b.Content as string == "完成"));
            Assert(logReads == 1 && Volatile.Read(ref sentBody)?.Contains("feedback-check diagnostic log") == true,
                "Preview and send reuse the same diagnostic logs");
            feedback.Close();

            feedback = Form(_ => { logReads++; throw new Exception("Unchecked logs must not be collected"); });
            feedback.GetVisualDescendants().OfType<CheckBox>().Single().IsChecked = false;
            feedback.GetVisualDescendants().OfType<TextBox>().Single(box => box.AcceptsReturn).Text = "不附日志的本地检查。";
            Click(Action(feedback, "发送反馈"));
            await Until(() => feedback.GetVisualDescendants().OfType<Button>().Any(b => b.Content as string == "完成"));
            Assert(logReads == 1 && Volatile.Read(ref sentBody)?.Contains("desktop.txt") == false,
                "Sending with logs unchecked does not read or attach logs");
            feedback.Close();

            var lateLogs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var logToken = CancellationToken.None;
            feedback = Form(token => { logToken = token; return lateLogs.Task; });
            Click(Action(feedback, "预览日志")); feedback.Close();
            Assert(logToken.IsCancellationRequested, "Closing the form cancels diagnostic collection");
            lateLogs.SetResult("late log result");
            await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);
            Assert(!feedback.OwnedWindows.Any(), "Finishing a log read after closing cannot reopen the preview");
            lifetime.Cancel(); listener.Close(); await serving;
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            releaseAccount.TrySetResult(); lifetime.Cancel(); listener.Close(); window?.Close();
            Directory.CreateDirectory(FeedbackOpeningChecks.Output);
            File.WriteAllText(Path.Combine(FeedbackOpeningChecks.Output, "opening-checks.json"), JsonSerializer.Serialize(new { passed = Environment.ExitCode == 0, checks }));
            Console.WriteLine($"{checks.Count} feedback opening checks passed; exit={Environment.ExitCode}.");
            ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

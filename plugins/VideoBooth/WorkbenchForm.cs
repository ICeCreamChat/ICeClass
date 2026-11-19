using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using ICeClass.VideoBooth.Transport;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ICeClass.VideoBooth;

internal sealed class WorkbenchForm : Form
{
    private readonly BoothServer server;
    private readonly IceClassPipeClient? client;
    private readonly CancellationTokenSource lifetime = new();
    private readonly HashSet<string> requests = new(StringComparer.Ordinal);
    private readonly TaskCompletionSource initialized = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Rectangle workbenchBounds;
    private bool closing, closingAllowed, preparingPhone;
    private double videoAspect = 16d / 9;
    private string DesktopUrl => server.DesktopUrl + (client is not null ? "&managed=1" : "");
    internal WebView2 Browser { get; } = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(229, 240, 248) };
    internal bool IsFloating { get; private set; }
    internal Task Initialized => initialized.Task;

    internal WorkbenchForm(BoothServer server, IceClassPipeClient? client = null)
    {
        this.server = server;
        this.client = client;
        Text = "视频展台";
        using var iconStream = typeof(WorkbenchForm).Assembly.GetManifestResourceStream("ICeClass.VideoBooth.Assets.app.ico");
        if (iconStream is not null) Icon = new Icon(iconStream);
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(1200, 780);
        MinimumSize = new Size(900, 620);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.None;
        Controls.Add(Browser);
        Shown += async (_, _) => await InitializeBrowser();
        FormClosing += OnClosing;
        FormClosed += (_, _) => lifetime.Cancel();
        _ = Handle;
        // The borderless WebView uses CSS pixels; size the client area after the
        // actual monitor DPI is known so 360px never becomes 240 CSS pixels.
        ClientSize = LogicalSize(1200, 780);
        MinimumSize = LogicalSize(900, 620);
        CenterToScreen();
        if (client is not null)
            _ = client.Run(message => InvokeAsync((Func<CancellationToken, ValueTask>)(async _ => await HandleCommand(message))),
                () => { if (IsHandleCreated && !IsDisposed) BeginInvoke(Close); });
    }

    private async Task InitializeBrowser()
    {
        try
        {
            var bundled = Path.Combine(AppContext.BaseDirectory, "browser");
            var runtime = File.Exists(Path.Combine(bundled, "msedgewebview2.exe")) ? bundled : null;
            var environment = await CoreWebView2Environment.CreateAsync(runtime, Path.Combine(server.DataDirectory, "browser-profile"));
            await Browser.EnsureCoreWebView2Async(environment);
            if (closing) return;
            var core = Browser.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.ServerCertificateErrorDetected += (_, e) =>
            {
                e.Action = CoreWebView2ServerCertificateErrorAction.Cancel;
                if (Uri.TryCreate(e.RequestUri, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host == "127.0.0.1" && uri.Port == server.HttpsPort
                    && server.Certificates.MatchesServerCertificatePem(e.ServerCertificate.ToPemEncoding()))
                    e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
            };
            core.PermissionRequested += (_, e) =>
            {
                e.SavesInProfile = false;
                e.State = IsCameraPermissionAllowed(e.Uri, e.PermissionKind)
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            core.NavigationStarting += (_, e) => { if (!IsTrustedDesktop(e.Uri)) e.Cancel = true; };
            core.FrameNavigationStarting += (_, e) => e.Cancel = true;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.ProcessFailed += (_, _) => Close();
            core.WebMessageReceived += OnWebMessage;
            // Older builds persisted an incorrect camera denial. Reset only this booth's
            // camera origin so the request reaches the application policy again.
            await core.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Camera,
                new Uri(DesktopUrl).GetLeftPart(UriPartial.Authority), CoreWebView2PermissionState.Default);
            if (closing) return;
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.nativeBooth = Object.freeze({managed:" + (client is not null ? "true" : "false") + "});");
            var navigation = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            core.NavigationCompleted += (_, e) => navigation.TrySetResult(e.IsSuccess);
            core.Navigate(DesktopUrl);
            if (!await navigation.Task.WaitAsync(TimeSpan.FromSeconds(20), lifetime.Token)) throw new InvalidOperationException("展台页面未能加载。");
            for (var attempt = 0; attempt < 100; attempt++)
            {
                lifetime.Token.ThrowIfCancellationRequested();
                if (await core.ExecuteScriptAsync("window.booth?.ready === true && ['freezeFrame','resumeReview','setReviewState','stop','setFloating','setNativeStatus'].every(name=>typeof window.booth[name]==='function') && Array.from(document.styleSheets).some(sheet=>sheet.href?.endsWith('/assets/styles.css') && sheet.cssRules.length>0)") == "true")
                {
                    initialized.TrySetResult();
                    if (client is not null) await client.Send("ready", new { });
                    return;
                }
                await Task.Delay(100, lifetime.Token);
            }
            throw new InvalidOperationException("展台页面尚未准备完成。");
        }
        catch (Exception error)
        {
            if (closing || lifetime.IsCancellationRequested || client?.Disconnected.IsCancellationRequested == true)
            {
                initialized.TrySetCanceled();
                Close();
                return;
            }
            initialized.TrySetException(error);
            Environment.ExitCode = 1;
            try { File.WriteAllText(Path.Combine(server.DataDirectory, "last-error.txt"), error.ToString()); } catch (IOException) { }
            await ReportStatus("展台启动失败：" + error.Message);
            Close();
        }
    }

    internal bool IsTrustedDesktop(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.GetLeftPart(UriPartial.Path) == new Uri(DesktopUrl).GetLeftPart(UriPartial.Path)
        && uri.Query == new Uri(DesktopUrl).Query && uri.UserInfo.Length == 0;

    internal bool IsCameraPermissionAllowed(string origin, CoreWebView2PermissionKind kind) => !closing
        && kind == CoreWebView2PermissionKind.Camera
        && Browser.Source is { } source && IsTrustedDesktop(source.AbsoluteUri)
        // PermissionRequested.Uri contains an origin, not the full desktop path/query.
        && Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.UserInfo.Length == 0
        && uri.GetLeftPart(UriPartial.Authority) == new Uri(DesktopUrl).GetLeftPart(UriPartial.Authority);

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (closing || !IsTrustedDesktop(e.Source)) return;
        try
        {
            using var json = JsonDocument.Parse(e.WebMessageAsJson, new JsonDocumentOptions { MaxDepth = 16 });
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeValue) || typeValue.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return;
            var type = typeValue.GetString();
            switch (type)
            {
                case "review_requested": case "resume_requested": case "review_invalidated": case "question_requested": case "open_workshop":
                    var values = ProtocolValidation.EventPayload(type, payload);
                    if (client is not null) await client.Send(type, values);
                    break;
                case "window":
                    if (!payload.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String) return;
                    switch (action.GetString())
                    {
                        case "float": await SetFloating(true); break;
                        case "restore": await SetFloating(false); break;
                        case "minimize": WindowState = FormWindowState.Minimized; break;
                        case "close": Close(); break;
                        case "drag": ReleaseCapture(); SendMessage(Handle, 0xA1, 2, 0); break;
                    }
                    break;
                case "video_aspect":
                    if (payload.TryGetProperty("aspect", out var aspect) && aspect.TryGetDouble(out var number) && double.IsFinite(number) && number is >= 0.1 and <= 10) videoAspect = number;
                    break;
                case "prepare_phone": await PreparePhone(); break;
            }
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or InvalidDataException or KeyNotFoundException or IOException or OperationCanceledException or ArgumentException or CryptographicException)
        { if (!closing) await ReportStatus(error.Message); }
    }

    private async Task PreparePhone()
    {
        if (preparingPhone) return;
        preparingPhone = true;
        try
        {
            await ReportStatus("正在准备手机连接…");
            await server.RefreshNetworks(lifetime.Token);
            if (!server.UsesPublicPhone && server.PhonePreparation is null && ManagedPreparation.ReadSettings(AppContext.BaseDirectory) is { CameraDomain: not null } settings)
                await server.EnablePhonePreparation(settings, cancellation: lifetime.Token);
            var status = server.Address == "127.0.0.1" ? "请先让手机与电脑连接同一网络。"
                : server.UsesPublicPhone || server.TrustedEndpoint.IsReady || server.PhonePreparation is not null ? "手机连接已准备，请扫码。"
                : "请扫码，按手机提示信任本机连接后打开摄像头。";
            await ReportStatus(status);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or HttpRequestException or JsonException or ArgumentException or CryptographicException)
        { await ReportStatus("手机连接准备失败：" + error.Message); }
        finally { preparingPhone = false; }
    }

    private async Task ReportStatus(string message)
    {
        if (client is not null && !client.Disconnected.IsCancellationRequested)
            try { await client.Send("state", new { message }); } catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { Close(); }
        if (Browser.CoreWebView2 is not null && !closing)
            try { await Browser.CoreWebView2.ExecuteScriptAsync("window.booth?.setNativeStatus(" + JsonSerializer.Serialize(message) + ")"); }
            catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException or COMException) { }
    }

    internal async Task SetFloating(bool floating)
    {
        if (IsFloating != floating)
        {
            if (floating)
            {
                if (WindowState == FormWindowState.Normal) workbenchBounds = Bounds;
                WindowState = FormWindowState.Normal;
                MinimumSize = LogicalSize(360, 280);
                ClientSize = LogicalSize(580, Math.Clamp((int)(580 / videoAspect) + 112, 360, 620));
                TopMost = true;
            }
            else
            {
                TopMost = false;
                WindowState = FormWindowState.Normal;
                MinimumSize = LogicalSize(900, 620);
                if (workbenchBounds.Width >= MinimumSize.Width) Bounds = workbenchBounds;
            }
            IsFloating = floating;
        }
        await InvokePage("setFloating", floating);
    }

    private Size LogicalSize(int width, int height) => new((int)Math.Round(width * DeviceDpi / 96d), (int)Math.Round(height * DeviceDpi / 96d));

    internal async Task<JsonElement> InvokePage(string method, object? payload = null)
    {
        if (method is not ("freezeFrame" or "resumeReview" or "setReviewState" or "stop" or "setFloating")) throw new InvalidOperationException("不支持的页面操作。");
        if (Browser.CoreWebView2 is null || !IsTrustedDesktop(Browser.Source.AbsoluteUri)) throw new InvalidOperationException("展台页面尚未准备好。");
        var script = "(() => { try { if (!window.booth?.ready) throw new Error('展台页面尚未准备好。'); const value=window.booth."
            + method + "(" + JsonSerializer.Serialize(payload) + "); if(value && typeof value.then==='function') throw new Error('展台页面操作必须同步完成。'); return {ok:true,value:value??{}}; } catch(error) { return {ok:false,message:error.message}; } })()";
        using var document = JsonDocument.Parse(await Browser.CoreWebView2.ExecuteScriptAsync(script));
        var result = document.RootElement;
        if (!result.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
            throw new InvalidOperationException(result.TryGetProperty("message", out var error) ? error.GetString() : "展台页面未返回结果。");
        return result.GetProperty("value").Clone();
    }

    private async Task HandleCommand(JsonElement message)
    {
        if (client is null) return;
        var id = message.GetProperty("requestId").GetString()!;
        try
        {
            if (!requests.Add(id)) throw new InvalidOperationException("重复的展台请求。");
            if (closing) throw new InvalidOperationException("展台正在退出。");
            var payload = message.GetProperty("payload");
            switch (message.GetProperty("type").GetString())
            {
                case "activate": await SetFloating(false); WindowState = FormWindowState.Normal; Show(); Activate(); break;
                case "freeze_frame":
                    ProtocolValidation.Integer(payload.GetProperty("generation"));
                    var frame = await InvokePage("freezeFrame", payload);
                    await client.Send("frame", ProtocolValidation.Frame(frame), id);
                    return;
                case "resume": ProtocolValidation.Integer(payload.GetProperty("generation")); await InvokePage("resumeReview", payload); break;
                case "review_state": ProtocolValidation.Integer(payload.GetProperty("generation")); await InvokePage("setReviewState", payload); break;
                case "stop": await InvokePage("stop"); break;
                case "exit":
                    if (Browser.CoreWebView2 is not null)
                        try { await InvokePage("stop"); } catch (InvalidOperationException) { }
                    await client.Send("ack", new { }, id); BeginInvoke(Close); return;
                default: throw new InvalidOperationException("不支持的展台命令。");
            }
            await client.Send("ack", new { }, id);
        }
        catch (Exception error)
        {
            if (client.Disconnected.IsCancellationRequested) { Close(); return; }
            try { await client.Send("error", new { message = error.Message }, id); }
            catch (Exception failure) when (failure is IOException or OperationCanceledException or ObjectDisposedException) { Close(); }
        }
    }

    private async void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (closingAllowed) return;
        e.Cancel = true;
        if (closing) return;
        closing = true;
        lifetime.Cancel();
        try { if (Browser.CoreWebView2 is not null) await InvokePage("stop").WaitAsync(TimeSpan.FromSeconds(2)); }
        catch (Exception) { /* Disposing WebView also releases every capture track on engine failure. */ }
        finally { closingAllowed = true; Browser.Dispose(); Close(); }
    }

    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if (message.Msg != 0x84 || (int)message.Result != 1 || WindowState != FormWindowState.Normal) return;
        var point = PointToClient(new Point((short)((long)message.LParam & 0xffff), (short)(((long)message.LParam >> 16) & 0xffff)));
        const int edge = 6;
        var left = point.X < edge; var right = point.X >= ClientSize.Width - edge;
        var top = point.Y < edge; var bottom = point.Y >= ClientSize.Height - edge;
        message.Result = (IntPtr)(top ? left ? 13 : right ? 14 : 12 : bottom ? left ? 16 : right ? 17 : 15 : left ? 10 : right ? 11 : 1);
    }

    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}

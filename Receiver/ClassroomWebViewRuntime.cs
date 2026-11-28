using Avalonia.Threading;
using ICeClass.Updates;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

internal sealed class ClassroomBrowser : ReadingBrowser
{
    internal string? InstalledBrowserFolder { private get; set; }
    internal bool AllowReadingFrames { private get; init; }

    protected override Task<CoreWebView2Controller> CreateControllerAsync(IntPtr handle, string profileDirectory, CancellationToken token) =>
        ClassroomWebViewRuntime.CreateControllerAsync(handle, profileDirectory, token, InstalledBrowserFolder, AllowReadingFrames);
}

internal static class ClassroomWebViewRuntime
{
    internal static string BundledVersion => ClassroomWebViewPackage.Version;
    private static readonly Version MinimumVersion = new(122, 0, 2365, 46); // ICoreWebView2_22: document-source request filters.
    private const string Repair = "请从托盘退出班伴，完整解压教室端安装包，双击“安装或升级.cmd”修复运行组件，再打开班伴。无需重新绑定。";
    private const string CheckPolicy = "若仍无法打开，请让学校管理员检查 WebView2 运行路径策略和组件的读取、执行权限。";

    private sealed class RuntimeException(string message, Exception? cause = null) : Exception(message, cause) { }

    private static bool Suitable(string version) =>
        Version.TryParse(version.Split(' ', 2)[0], out var actual) && actual >= MinimumVersion;

    private static bool MissingInterface(Exception error) => error is NotImplementedException or InvalidCastException ||
        error.HResult is unchecked((int)0x80004002) or unchecked((int)0x80004001); // E_NOINTERFACE / E_NOTIMPL

    internal static string? Recovery(Exception error) => error is RuntimeException ? error.Message :
        error is WebView2RuntimeNotFoundException || MissingInterface(error) ? Repair : null;

    internal static void PrepareAfterUpdate()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var root = AppContext.BaseDirectory;
                if (!File.Exists(IncrementalUpdates.SafePath(root, ClassroomWebViewPackage.UpdatePath))) return;
                try { if (Suitable(CoreWebView2Environment.GetAvailableBrowserVersionString())) return; }
                catch (WebView2RuntimeNotFoundException) { }
                await ClassroomWebViewPackage.EnsureAsync(root, null, CancellationToken.None);
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            { AppLog.Error("Could not prepare the updated classroom WebView2 runtime", error); }
        });
    }

    internal static async Task<CoreWebView2Controller> CreateControllerAsync(IntPtr parent, string profile,
        CancellationToken token, string? installedBrowserFolder = null, bool allowReadingFrames = false)
    {
        async Task<CoreWebView2Controller> OpenAsync(string? folder)
        {
            var environment = await CoreWebView2Environment.CreateAsync(folder, profile);
            token.ThrowIfCancellationRequested();
            // The loader can replace even an explicit folder through machine policy.
            if (!Suitable(environment.BrowserVersionString))
                throw new NotSupportedException("WebView2 " + environment.BrowserVersionString);
            var controller = await environment.CreateCoreWebView2ControllerAsync(parent);
            try
            {
                token.ThrowIfCancellationRequested();
                var core = controller.CoreWebView2;
                // Exercise the same overload used for credentials, before any page or bridge is loaded.
                const string probe = "https://webview-check.invalid/";
                core.AddWebResourceRequestedFilter(probe, CoreWebView2WebResourceContext.Document, CoreWebView2WebResourceRequestSourceKinds.Document);
                core.RemoveWebResourceRequestedFilter(probe, CoreWebView2WebResourceContext.Document, CoreWebView2WebResourceRequestSourceKinds.Document);
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.DownloadStarting += (_, e) => e.Cancel = true;
                core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
                core.FrameNavigationStarting += (_, e) =>
                {
                    if (!allowReadingFrames || e.Uri is not ("about:srcdoc" or "about:blank")) e.Cancel = true;
                };
                return controller;
            }
            catch { controller.Close(); throw; }
        }

        try
        {
            token.ThrowIfCancellationRequested();
            try
            {
                if (Suitable(CoreWebView2Environment.GetAvailableBrowserVersionString(installedBrowserFolder)))
                    return await OpenAsync(installedBrowserFolder);
            }
            catch (Exception error) when (error is not (OperationCanceledException or OutOfMemoryException))
            { AppLog.Error("Installed WebView2 initialization failed", error); }

            token.ThrowIfCancellationRequested();
            var bundled = await Task.Run(() => ClassroomWebViewPackage.EnsureAsync(AppContext.BaseDirectory, null, token), token);
            token.ThrowIfCancellationRequested();
            return await OpenAsync(bundled);
        }
        catch (Exception error) when (error is not (OperationCanceledException or OutOfMemoryException or RuntimeException))
        { throw new RuntimeException("教室端无法使用所需的 WebView2 运行组件。" + Repair + CheckPolicy, error); }
    }

    internal static bool PermissionForThisRequest(CoreWebView2PermissionRequestedEventArgs args, Action<string> unavailable)
    {
        args.State = CoreWebView2PermissionState.Deny;
        try { args.SavesInProfile = false; return true; }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            AppLog.Error("WebView2 per-request permission unavailable", error);
            Dispatcher.UIThread.Post(() => unavailable(Repair + CheckPolicy));
            return false;
        }
    }
}

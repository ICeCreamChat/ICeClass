using Avalonia.Threading;
using ICeClass.Diagnostics;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

internal sealed partial class DesktopWindow
{
    private ClientErrorReporter? _clientErrors;
    private int _diagnosticGeneration;

    private void InitializeClientDiagnostics()
    {
        if (!_main) return;
        DesktopLog.ErrorRecorded += QueueClientError;
        _app.Diagnostics.ErrorRecorded += QueueClientError;
        _app.Diagnostics.AuthenticationChanged += OnDiagnosticAuthenticationChanged;
    }

    private void QueueClientError(string message) => _clientErrors?.Record(message);
    private void OnDiagnosticAuthenticationChanged() => Dispatcher.UIThread.Post(async () => await RefreshClientDiagnosticSessionAsync());

    private async Task RefreshClientDiagnosticSessionAsync()
    {
        if (!_main || _disposed) return;
        var generation = ++_diagnosticGeneration;
        _clientErrors?.Dispose(); _clientErrors = null;
        string? session;
        try { session = await ReadSessionAsync(); } catch { return; }
        if (_disposed || generation != _diagnosticGeneration || string.IsNullOrEmpty(session)) return;
        _clientErrors = new(async (id, report, token) =>
        {
            await Dispatcher.UIThread.InvokeAsync(() => SubmitClientDiagnosticsAsync("error",
                $"版本：{DesktopUpdates.CurrentVersion}\nWindows 动画：{DesktopStyle.AnimationsEnabled()}\n" + report, token, session, id));
        }, Path.Combine(App.DataDirectory, "diagnostic-outbox.json"), ClientDiagnostics.Identity(_endpoint, session));
    }

    private async Task<string> SubmitClientDiagnosticsAsync(string kind, string report, CancellationToken token, string? expectedSession, string? reportId = null)
    {
        if (await ReadSessionAsync() != expectedSession)
        {
            if (kind == "error") await RefreshClientDiagnosticSessionAsync();
            throw new InvalidOperationException("登录已变化，请重新打开“关于”并读取诊断后提交。");
        }
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(15) };
        using var accountClient = new TeacherFeedbackClient(_endpoint, ReadSessionAsync, http);
        var account = await accountClient.AccountAsync(token);
        if (account.Session != expectedSession) throw new InvalidOperationException("登录已变化，请重新打开“关于”后重试。");
        using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint + "/api/client-diagnostics");
        request.Headers.Add("Cookie", "iceclass_session=" + account.Session);
        request.Headers.Add("X-CSRF-Token", account.Csrf);
        return await ClientDiagnostics.UploadAsync(http, request, "teacher", kind, DesktopUpdates.CurrentVersion,
            ClientDiagnostics.InstallationId(App.DataDirectory), report, token, reportId);
    }

    private void DisposeClientDiagnostics()
    {
        if (!_main) return;
        _diagnosticGeneration++;
        DesktopLog.ErrorRecorded -= QueueClientError;
        _app.Diagnostics.ErrorRecorded -= QueueClientError;
        _app.Diagnostics.AuthenticationChanged -= OnDiagnosticAuthenticationChanged;
        _clientErrors?.Dispose();
    }
}

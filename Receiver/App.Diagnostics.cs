using System.Net.Http.Headers;
using ICeClass.Diagnostics;

namespace ICeClass.Receiver;

public sealed partial class App
{
    private ClientErrorReporter? _clientErrors;
    private string? _clientDiagnosticIdentity;

    private void InitializeClientDiagnostics()
    {
        AppLog.ErrorRecorded += QueueClientError;
        ResetClientDiagnosticBinding();
    }

    private void QueueClientError(string message) => _clientErrors?.Record(message);
    private void ResetClientDiagnosticBinding()
    {
        var bound = ReceiverConfig.TryLoad(out var binding);
        var identity = bound ? ClientDiagnostics.Identity(ReceiverConfig.NormalizeEndpoint(binding.Endpoint), binding.DeviceId,
            binding.DeviceToken, binding.ClassId) : null;
        if (identity == _clientDiagnosticIdentity && _clientErrors is not null) return;
        _clientErrors?.Dispose(); _clientErrors = null;
        _clientDiagnosticIdentity = identity;
        if (bound)
        {
            var directory = ReceiverConfig.IsPreview(binding) ? AppContext.BaseDirectory : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver");
            _clientErrors = new(async (id, report, token) => { await SubmitClientDiagnosticsAsync("error", report, token, binding, id); },
                Path.Combine(directory, "diagnostic-outbox.json"), identity!);
        }
    }

    private async Task<string> SubmitClientDiagnosticsAsync(string kind, string report, CancellationToken token, ReceiverConfig? expectedBinding, string? reportId = null)
    {
        if (!ReceiverConfig.TryLoad(out var config)) throw new InvalidOperationException("请先绑定教室，再提交诊断。");
        if (expectedBinding is null || config.Endpoint != expectedBinding.Endpoint || config.DeviceId != expectedBinding.DeviceId ||
            config.DeviceToken != expectedBinding.DeviceToken || config.ClassId != expectedBinding.ClassId)
            throw new InvalidOperationException("教室绑定已变化，请重新打开“关于”并读取诊断后提交。");
        if (!Uri.TryCreate(config.Endpoint, UriKind.Absolute, out var endpoint) ||
            !(endpoint.Scheme == Uri.UriSchemeHttps || endpoint.Scheme == Uri.UriSchemeHttp && endpoint.IsLoopback) ||
            !string.IsNullOrEmpty(endpoint.UserInfo)) throw new InvalidOperationException("学校平台地址不正确，请检查教室设置。");
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(15) };
        using var request = new HttpRequestMessage(HttpMethod.Post, config.Endpoint.TrimEnd('/') + "/api/client-diagnostics");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        request.Headers.Add("X-ICeClass-Device", config.DeviceId);
        return await ClientDiagnostics.UploadAsync(http, request, "classroom", kind, ReceiverUpdateService.CurrentVersionText,
            config.DeviceId, report, token, reportId);
    }
}

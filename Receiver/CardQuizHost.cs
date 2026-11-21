using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

/// <summary>Dedicated camera origin. Device credentials and durable writes remain outside the page.</summary>
internal sealed class CardQuizHost : IDisposable
{
    private const string Host = "cardquiz.iceclass.local";
    private const string Page = "https://" + Host + "/card-quiz/classroom.html#banban";
    private readonly CardQuizService _service;
    private readonly ReceiverConfig _config;
    internal ReadingBrowser Browser { get; } = new() { Width = 1, Height = 1, Focusable = false,
        IsHitTestVisible = false, HandleEscapeKey = false, HandleFullscreenKey = false };
    private readonly CancellationTokenSource _lifetime = new();
    private TaskCompletionSource<bool>? _leave;
    private bool _closed, _ready, _visible;
    private bool _failed;
    internal event Action<CardQuizWheelState>? CompanionStateChanged;
    internal event Action<string>? FailedToLoad;
    internal event Action? CollapseRequested;
    internal bool IsBusy { get; private set; }

    internal CardQuizHost(ReceiverConfig config)
    {
        _config = new ReceiverConfig { Endpoint = ReceiverConfig.NormalizeEndpoint(config.Endpoint), DeviceId = config.DeviceId, ClassId = config.ClassId, ClassName = config.ClassName };
        _service = CardQuizService.For(config); _service.AuthorizationRevoked += OnAuthorizationRevoked;
    }

    private static bool AllowedPage(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.Host == Host && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) &&
        uri.AbsolutePath == "/card-quiz/classroom.html" && uri.Query.Length == 0;
    internal void ActivateCompanionAction(CardQuizWheelCommand command)
    {
        var action = command.Action;
        if (!_ready) return;
        Post(new
        {
            type = "companion-action", action, sessionId = command.SessionId, key = command.Key,
            selection = command.Selection is { } value ? new { publication = value.Publication, subject = value.Subject, template = value.Template } : null,
        });
    }
    internal async Task InitializeAsync()
    {
        try
        {
            var assets = await ReadingLocalAssets.EnsureAsync(_lifetime.Token);
            var root = ReceiverConfig.IsPreview(_config) ? AppContext.BaseDirectory :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass");
            var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_config.Endpoint + "\n" + _config.ClassId + "\n" + _config.DeviceId)))[..24];
            await Browser.InitializeAsync(Path.Combine(root, "CardQuizBrowser", key), _lifetime.Token);
            var core = Browser.Core!;
            core.SetVirtualHostNameToFolderMapping(Host, assets, CoreWebView2HostResourceAccessKind.DenyCors);
            core.Settings.AreDefaultContextMenusEnabled = false; core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.NavigationStarting += (_, args) => { if (!AllowedPage(args.Uri)) args.Cancel = true; };
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.DownloadStarting += (_, args) => args.Cancel = true;
            core.LaunchingExternalUriScheme += (_, args) => args.Cancel = true;
            core.PermissionRequested += (_, args) =>
            {
                var origin = Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Scheme == "https" &&
                    uri.Host == Host && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo);
                args.State = _visible && !_service.IsRevoked && origin && AllowedPage(core.Source) && args.PermissionKind == CoreWebView2PermissionKind.Camera
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                args.SavesInProfile = false;
            };
            core.WebMessageReceived += async (_, args) => await ReceiveAsync(core, args);
            core.ProcessFailed += (_, _) =>
            {
                Fail("纸卡页面已中断，请重新读取本机记录。");
            };
            core.Navigate(Page);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { Fail("无法打开纸卡答题：" + error.Message); AppLog.Error("Open card quiz failed", error); }
    }

    private void Post(object value)
    {
        if (!_closed && !_failed && Browser.Core is { } core) core.PostWebMessageAsJson(JsonSerializer.Serialize(value));
    }

    internal void SetVisible(bool visible)
    {
        _visible = visible;
        Browser.SetPageVisible(visible && _ready);
        if (_ready) Post(new { type = "visibility", visible });
    }
    private async Task ReceiveAsync(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_closed || _failed || !ReferenceEquals(core, Browser.Core) || !AllowedPage(args.Source) || args.WebMessageAsJson.Length > 20 * 1024 * 1024) return;
        var id = 0;
        try
        {
            var message = JsonNode.Parse(args.WebMessageAsJson)!.AsObject();
            if (message["type"]?.GetValue<string>() is string type)
            {
                switch (type)
                {
                    case "ready":
                        _ready = true; SetVisible(_visible);
                        if (_service.IsRevoked) OnAuthorizationRevoked("设备授权已失效，请联网核对绑定。");
                        break;
                    case "activity": IsBusy = message["busy"]?.GetValue<bool>() == true; break;
                    case "collapse": CollapseRequested?.Invoke(); break;
                    case "suspended": _leave?.TrySetResult(message["saved"]?.GetValue<bool>() == true); break;
                    case "companion-state":
                        var state = message["state"]?.Deserialize<CardQuizWheelState>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        if (state?.Lesson is not null)
                        { CompanionStateChanged?.Invoke(state); }
                        break;
                }
                return;
            }
            id = message["id"]!.GetValue<int>(); if (id <= 0) return;
            var body = message["body"] as JsonObject ?? new JsonObject();
            object? result;
            switch (message["action"]?.GetValue<string>())
            {
                case "load": result = await Task.Run(_service.Load, _lifetime.Token); break;
                case "bootstrap": result = await _service.BootstrapAsync(_lifetime.Token); break;
                case "publication": result = await _service.PublicationAsync(body["id"]!.GetValue<string>(), _lifetime.Token, body["sessionId"]?.GetValue<string>()); break;
                case "commit":
                    result = await Task.Run(() => _service.Commit(body["journal"]!.AsObject()), _lifetime.Token);
                    IsBusy = ((JsonObject)result)["session"]!["endedAt"] is null; break;
                case "sync": result = await _service.SyncAsync(body["retry"]?.GetValue<bool>() == true, _lifetime.Token); break;
                case "pair": result = await _service.PairAsync(body["sessionId"]!.GetValue<string>(), _lifetime.Token); break;
                case "relay": result = await _service.RelayAsync(body, _lifetime.Token); break;
                default: throw new InvalidDataException("纸卡操作不支持。");
            }
            if (!_closed) Post(new { type = "response", id, value = result });
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            if (!_closed && id > 0) Post(new { type = "response", id, error = error is OperationCanceledException ? "操作已中断，请核对本机记录。" : error.Message });
        }
    }
    private void Fail(string message)
    {
        if (_closed || _failed) return;
        _failed = true; _ready = false; _leave?.TrySetResult(false);
        Browser.DisposeBrowser(); FailedToLoad?.Invoke(message);
    }
    internal async Task<bool> PrepareToCloseAsync()
    {
        if (!_ready || _closed) return true;
        if (_leave is null || _leave.Task.IsCompleted) { _leave = new(TaskCreationOptions.RunContinuationsAsynchronously); Post(new { type = "suspend" }); }
        var leave = _leave;
        try { return await leave.Task.WaitAsync(TimeSpan.FromSeconds(8)); }
        catch (TimeoutException) { return false; }
    }
    private void OnAuthorizationRevoked(string message) => Dispatcher.UIThread.Post(async () =>
    {
        if (_closed || !_ready) return;
        Post(new { type = "authorization", revoked = true, message });
        if (await PrepareToCloseAsync() || _closed) return;
        Fail("设备授权已失效，摄像头已关闭。请重新绑定后核对本机记录。");
    });
    public void Dispose()
    {
        if (_closed) return;
        _closed = true; IsBusy = false; _service.AuthorizationRevoked -= OnAuthorizationRevoked;
        _leave?.TrySetResult(false); _lifetime.Cancel(); Browser.DisposeBrowser(); _lifetime.Dispose();
    }
}

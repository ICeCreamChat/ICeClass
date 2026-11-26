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
    private int _suspendId;
    private bool _closed, _ready, _visible;
    private bool _failed;
    private string? _previewKey, _bufferId;
    private const int VideoSlotCount = 3;
    private readonly CoreWebView2SharedBuffer?[] _videoBuffers = new CoreWebView2SharedBuffer?[VideoSlotCount];
    private long _lastVideoFrame;
    internal event Action<CardQuizWheelState>? CompanionStateChanged;
    internal event Action<string,string>? PreviewFrame;
    internal event Action<string,Stream>? PreviewPixels;
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
            type = "companion-action", action, sessionId = command.SessionId, key = command.Key, cardNumber = command.CardNumber, pageKey = command.PageKey,
            questionIndex = command.QuestionIndex,
            selection = command.Selection is { } value ? new { publication = value.Publication, subject = value.Subject, template = value.Template, cardMode = value.CardMode } : null,
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
        if (!visible) SetPreviewKey(null);
        Browser.SetPageVisible(visible && _ready);
        if (_ready) Post(new { type = "visibility", visible, nativeDisc = true });
    }
    private async Task ReceiveAsync(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_closed || _failed || !ReferenceEquals(core, Browser.Core) || !AllowedPage(args.Source)) return;
        var json = args.WebMessageAsJson;
        if (json.Length > 20 * 1024 * 1024) return;
        var id = 0;
        try
        {
            var message = JsonNode.Parse(json)!.AsObject();
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
                    case "preview-frame":
                        if (_visible && !_service.IsRevoked && json.Length < 67000 &&
                            message["key"]?.GetValue<string>() is { } key && message["frame"]?.GetValue<string>() is { } frame)
                            PreviewFrame?.Invoke(key,frame);
                        break;
                    case "preview-buffer":
                    case "preview-pixels":
                    case "preview-release":
                        if (_visible && !_service.IsRevoked && _previewKey is { } currentKey &&
                            message["key"]?.GetValue<string>() == currentKey &&
                            message["id"]?.GetValue<string>() is { } runId && Guid.TryParseExact(runId, "D", out _))
                        {
                            if (type == "preview-buffer") OpenVideoBuffers(core, currentKey, runId);
                            else if (_bufferId != runId) break;
                            else if (type == "preview-release") CloseVideoBuffers();
                            else if (message["slot"]?.GetValue<int>() is { } slot && slot is >= 0 and < VideoSlotCount &&
                                message["frame"]?.GetValue<long>() is { } frameNumber && frameNumber > _lastVideoFrame &&
                                _videoBuffers[slot] is { } buffer)
                            {
                                try
                                {
                                    // WebView2 exposes a forward-only stream. Each view starts at the first pixel.
                                    using var pixels = buffer.OpenStream();
                                    PreviewPixels?.Invoke(currentKey, pixels);
                                    _lastVideoFrame = frameNumber;
                                    Post(new { type = "preview-consumed", id = runId, slot, frame = frameNumber });
                                }
                                catch (Exception error) when (error is not OutOfMemoryException)
                                {
                                    CloseVideoBuffers();
                                    AppLog.Error("Read classroom video buffer", error);
                                    Post(new { type = "preview-buffer-unavailable", id = runId });
                                }
                            }
                        }
                        break;
                    case "suspended":
                        if (message["suspendId"]?.GetValue<int>() == _suspendId)
                            _leave?.TrySetResult(message["saved"]?.GetValue<bool>() == true);
                        break;
                    case "companion-state":
                        var state = message["state"]?.Deserialize<CardQuizWheelState>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        if (state?.Lesson is not null)
                        {
                            SetPreviewKey(_visible && state.Lesson.Phase == "collect" && state.Preview is { Folded:false } view ? view.Key : null);
                            CompanionStateChanged?.Invoke(state);
                        }
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
                    // The first write can outlive the page before it reports an active classroom.
                    IsBusy = true;
                    result = await Task.Run(() => _service.Commit(body["journal"]!.AsObject()), _lifetime.Token);
                    IsBusy = ((JsonObject)result)["session"]!["endedAt"] is null; break;
                case "sync": result = await Task.Run(() => _service.SyncAsync(body["retry"]?.GetValue<bool>() == true, _lifetime.Token), _lifetime.Token); break;
                case "sync-session": result = await Task.Run(() => _service.SyncSessionAsync(body["sessionId"]!.GetValue<string>(), _lifetime.Token), _lifetime.Token); break;
                case "pair": result = await Task.Run(() => _service.PairAsync(body["sessionId"]!.GetValue<string>(), _lifetime.Token), _lifetime.Token); break;
                // A cancel sent just before the window closes still needs to reach the school.
                case "cancel-pair": result = await _service.CancelPairAsync(body["sessionId"]!.GetValue<string>(), body["pairId"]!.GetValue<string>(), CancellationToken.None); break;
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
    private void OpenVideoBuffers(CoreWebView2 core, string key, string runId)
    {
        CloseVideoBuffers();
        try
        {
            _bufferId = runId;
            for (var slot = 0; slot < _videoBuffers.Length; slot++)
            {
                var buffer = core.Environment.CreateSharedBuffer(BanbanCameraLens.PixelBytes);
                _videoBuffers[slot] = buffer;
                core.PostSharedBufferToScript(buffer, CoreWebView2SharedBufferAccess.ReadWrite,
                    JsonSerializer.Serialize(new { type = "preview-buffer", key, id = runId, slot }));
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            CloseVideoBuffers();
            Post(new { type = "preview-buffer-unavailable", id = runId });
        }
    }
    private void CloseVideoBuffers()
    {
        _bufferId = null;
        _lastVideoFrame = 0;
        for (var slot = 0; slot < _videoBuffers.Length; slot++)
        {
            _videoBuffers[slot]?.Close();
            _videoBuffers[slot] = null;
        }
    }
    private void SetPreviewKey(string? key)
    {
        if (_previewKey == key) return;
        CloseVideoBuffers(); _previewKey = key;
    }
    private void Fail(string message)
    {
        if (_closed || _failed) return;
        _failed = true; _ready = false; _leave?.TrySetResult(false);
        SetPreviewKey(null); Browser.DisposeBrowser(); FailedToLoad?.Invoke(message);
    }
    internal async Task<bool> PrepareToCloseAsync()
    {
        if (!_ready || _closed) return !IsBusy;
        if (_leave is null || _leave.Task.IsCompleted)
        {
            _leave = new(TaskCreationOptions.RunContinuationsAsynchronously);
            Post(new { type = "suspend", suspendId = ++_suspendId });
        }
        var leave = _leave;
        try { return await leave.Task.WaitAsync(TimeSpan.FromSeconds(8)); }
        catch (TimeoutException) { leave.TrySetResult(false); return false; }
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
        _leave?.TrySetResult(false); _lifetime.Cancel(); SetPreviewKey(null); Browser.DisposeBrowser(); _lifetime.Dispose();
    }
}

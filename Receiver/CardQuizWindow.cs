using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

/// <summary>Dedicated camera origin. Device credentials and durable writes remain outside the page.</summary>
internal sealed class CardQuizWindow : Window
{
    private const string Host = "cardquiz.iceclass.local";
    private const string Page = "https://" + Host + "/card-quiz/classroom.html";
    private readonly CardQuizService _service;
    private readonly ReceiverConfig _config;
    private readonly ReadingBrowser _browser = new() { HandleEscapeKey = false, HandleFullscreenKey = false };
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBlock _message = ClassroomStyle.Caption("正在打开纸卡答题…");
    private readonly Border _notice;
    private TaskCompletionSource<bool>? _leave;
    private Task? _closeTask;
    private bool _closed, _forceClose, _ready, _companionWanted;
    private Task? _initialization;
    internal CardQuizWheelState? CompanionState { get; private set; }
    internal event Action<CardQuizWheelState>? CompanionStateChanged;
    internal event Action<bool, bool>? CompanionModeRequested;
    internal bool IsBusy { get; private set; }
    internal bool Matches(ReceiverConfig config) => _service.Matches(config);

    internal CardQuizWindow(ReceiverConfig config)
    {
        _config = new ReceiverConfig { Endpoint = ReceiverConfig.NormalizeEndpoint(config.Endpoint), DeviceId = config.DeviceId, ClassId = config.ClassId, ClassName = config.ClassName };
        _service = CardQuizService.For(config); _service.AuthorizationRevoked += OnAuthorizationRevoked;
        Title = "纸卡答题 · " + config.ClassName;
        Width = 1120; Height = 780; MinWidth = 360; MinHeight = 280;
        Background = DesktopStyle.Brush("#E5F0F8");
        _notice = new Border { Padding = new Thickness(28), Child = _message,
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        var surface = new Grid(); surface.Children.Add(_browser); surface.Children.Add(_notice); Content = surface;
        _browser.FocusOutside += next => _browser.FocusPage(next ? CoreWebView2MoveFocusReason.Next : CoreWebView2MoveFocusReason.Previous);
        Opened += async (_, _) => await EnsurePageAsync();
        Closing += (_, args) =>
        {
            if (_forceClose || args.CloseReason is WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown) return;
            args.Cancel = true;
            _closeTask ??= CloseSafelyAsync();
        };
        PropertyChanged += (_, args) =>
        {
            if (args.Property != WindowStateProperty && args.Property != IsVisibleProperty) return;
            var visible = IsVisible && WindowState != WindowState.Minimized;
            if (!visible) Post(new { type = "suspend" });
            _browser.SetPageVisible(visible && _ready);
        };
        Closed += (_, _) => { _closed = true; IsBusy = false; _service.AuthorizationRevoked -= OnAuthorizationRevoked; _leave?.TrySetResult(false); _lifetime.Cancel(); _browser.DisposeBrowser(); };
    }

    private static bool AllowedPage(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.Host == Host && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) &&
        uri.AbsolutePath == "/card-quiz/classroom.html" && uri.Query.Length == 0;
    private Task EnsurePageAsync() => _initialization ??= InitializeAsync();
    internal Task StartInBackgroundAsync()
    {
        _companionWanted = true;
        // Use the same background-host attachment as the existing voice window.
        // No second pet or visible workbench is needed to read the current state.
        if (_initialization is null) { EnsureInitialized(); ApplyStyling(); ApplyTemplate(); Presenter!.UpdateChild(); }
        if (_ready) Post(new { type = "compact", value = true, expanded = true });
        return EnsurePageAsync();
    }
    internal void ActivateCompanionAction(string action)
    {
        if (action == "workbench") { SetCompanionMode(false, false); return; }
        if (_ready)
        {
            if (!IsVisible || WindowState == WindowState.Minimized) BringForward();
            Post(new { type = "companion-action", action });
        }
    }
    internal void BringForward() { Show(); WindowState = WindowState.Normal; Activate(); }
    private async Task InitializeAsync()
    {
        try
        {
            var assets = await ReadingLocalAssets.EnsureAsync(_lifetime.Token);
            var root = ReceiverConfig.IsPreview(_config) ? AppContext.BaseDirectory :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass");
            var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_config.Endpoint + "\n" + _config.ClassId + "\n" + _config.DeviceId)))[..24];
            await _browser.InitializeAsync(Path.Combine(root, "CardQuizBrowser", key), _lifetime.Token);
            var core = _browser.Core!;
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
                args.State = !_service.IsRevoked && origin && AllowedPage(core.Source) && args.PermissionKind == CoreWebView2PermissionKind.Camera
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                args.SavesInProfile = false;
            };
            core.WebMessageReceived += async (_, args) => await ReceiveAsync(core, args);
            core.ProcessFailed += (_, _) =>
            {
                _ready = false; _browser.SetPageVisible(false); _notice.IsVisible = true;
                _message.Text = "纸卡页面已中断。本机已确认的记录仍保留，请关闭后重新打开，核对并恢复收答。";
                MarkCompanionUnavailable(_message.Text);
                _leave?.TrySetResult(false);
            };
            core.Navigate(Page);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { _message.Text = "无法打开纸卡答题：" + error.Message; MarkCompanionUnavailable(_message.Text); AppLog.Error("Open card quiz failed", error); }
    }

    private void Post(object value)
    {
        if (!_closed && _browser.Core is { } core) core.PostWebMessageAsJson(JsonSerializer.Serialize(value));
    }
    private async Task ReceiveAsync(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_closed || !ReferenceEquals(core, _browser.Core) || !AllowedPage(args.Source) || args.WebMessageAsJson.Length > 20 * 1024 * 1024) return;
        var id = 0;
        try
        {
            var message = JsonNode.Parse(args.WebMessageAsJson)!.AsObject();
            if (message["type"]?.GetValue<string>() is string type)
            {
                switch (type)
                {
                    case "ready":
                        _ready = true; _notice.IsVisible = false; _browser.SetPageVisible(IsVisible && WindowState != WindowState.Minimized);
                        if (_companionWanted) Post(new { type = "compact", value = true, expanded = true });
                        if (_service.IsRevoked) OnAuthorizationRevoked("设备授权已失效，请联网核对绑定。");
                        break;
                    case "activity": IsBusy = message["busy"]?.GetValue<bool>() == true; break;
                    case "suspended": _leave?.TrySetResult(message["saved"]?.GetValue<bool>() == true); break;
                    case "companion-state":
                        var state = message["state"]?.Deserialize<CardQuizWheelState>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        if (state is not null && state.Actions.Length == 8)
                        { CompanionState = state; CompanionStateChanged?.Invoke(state); }
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
                case "compact":
                    SetCompanionMode(body["enabled"]?.GetValue<bool>() == true, body["expanded"]?.GetValue<bool>() == true);
                    result = null; break;
                case "close": result = null; _closeTask ??= CloseSafelyAsync(); break;
                default: throw new InvalidDataException("纸卡操作不支持。");
            }
            if (!_closed) Post(new { type = "response", id, value = result });
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            if (!_closed && id > 0) Post(new { type = "response", id, error = error is OperationCanceledException ? "操作已中断，请核对本机记录。" : error.Message });
        }
    }
    private void SetCompanionMode(bool enabled, bool expanded)
    {
        _companionWanted = enabled;
        CompanionModeRequested?.Invoke(enabled, expanded);
        if (!enabled) BringForward();
        Post(new { type = "compact", value = enabled, expanded });
    }
    private void MarkCompanionUnavailable(string message)
    {
        if (CompanionState is not { } state)
        {
            CompanionState = new CardQuizWheelState(false, [], message, "", message, true, false, false, false);
            CompanionStateChanged?.Invoke(CompanionState); return;
        }
        CompanionState = state with { Actions = state.Actions.Select(action => action with { Enabled = false }).ToArray(),
            Feedback = message, Error = true, MultiEnabled = false, CameraRunning = false };
        CompanionStateChanged?.Invoke(CompanionState);
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
        _ready = false; _browser.DisposeBrowser(); _notice.IsVisible = true;
        _message.Text = "设备授权已失效，摄像头已关闭。本机记录保留，请重新绑定后核对。";
    });
    private async Task CloseSafelyAsync()
    {
        if (!await PrepareToCloseAsync())
        {
            _closeTask = null; _notice.IsVisible = true;
            _message.Text = "暂停尚未确认，请稍后再关闭。已确认的本机记录保留。"; return;
        }
        CloseWithoutPrompt();
    }
    internal void CloseWithoutPrompt() { _forceClose = true; Close(); }
}

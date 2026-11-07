using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

/// <summary>A class-scoped ideas page. Device credentials stay in the native host.</summary>
public sealed class CreativeIdeasWindow : Window
{
    private readonly ReceiverConfig _config;
    private readonly Uri _origin;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly IdeasVoiceTranscriber _voiceTranscriber = new();
    private CancellationTokenSource? _transcriptionCancellation;
    private string? _transcriptionRequestId;
    private int _transcriptionGeneration;
    private ulong _pageNavigationId;
    private bool _pageNavigating;
    private readonly Grid _surface = new();
    private ReadingBrowser _browser;
    private readonly Border _notice;
    private readonly TextBlock _message = ClassroomStyle.Text("正在连接创意计划…", 16, muted: true);
    private readonly Button _retry = ClassroomStyle.Button("重新打开", true);
    private readonly HashSet<CoreWebView2PermissionKind> _allowedDevices = [];
    private Window? _permissionDialog;
    private Window? _closeDialog;
    private TaskCompletionSource<bool>? _navigation;
    private ulong? _navigationId;
    private string? _navigationTarget;
    private TaskCompletionSource<bool>? _leaveReady;
    private bool _initialized, _loading, _closed, _closing, _canClose, _forceClose, _browserFailed;

    public CreativeIdeasWindow(ReceiverConfig config)
    {
        _config = config;
        _origin = new Uri(config.Endpoint.TrimEnd('/') + "/");
        _browser = CreateBrowser();
        ClassroomStyle.Apply(this);
        Title = $"创意计划 · {config.ClassName}";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 720; Height = 620; MinWidth = 600; MinHeight = 480;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        DesktopStyle.KeepWindowInWorkingArea(this);
        Background = DesktopStyle.Brush("#F4F9FF");
        var home = ClassroomStyle.Button("关闭");
        home.Click += (_, _) => Close();
        _retry.Click += async (_, _) => await LoadAsync();
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12,
            HorizontalAlignment = HorizontalAlignment.Center, Children = { home, _retry } };
        _notice = new Border { Classes = { "classroom-glass" }, CornerRadius = new CornerRadius(24), Background = Brushes.Transparent, Padding = new Thickness(28),
            Child = new StackPanel { Spacing = 18, MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center, Children = {
                    ClassroomStyle.Title("创意计划"), _message, actions } } };
        _surface.Children.Add(_browser); _surface.Children.Add(_notice); Content = _surface;
        PropertyChanged += (_, args) =>
        {
            if (args.Property != WindowStateProperty || _closed) return;
            var visible = WindowState != WindowState.Minimized;
            _browser.SetPageVisible(visible && !_notice.IsVisible);
            if (!visible)
            {
                _allowedDevices.Clear(); _permissionDialog?.Close(false);
                _ = SuspendCaptureAsync();
            }
        };
        Closing += (_, args) =>
        {
            if (_canClose || args.CloseReason is WindowCloseReason.ApplicationShutdown or WindowCloseReason.OSShutdown) return;
            args.Cancel = true; _ = CloseSafelyAsync();
        };
        Closed += (_, _) =>
        {
            CancelTranscription();
            _closed = true; _lifetime.Cancel(); _navigation?.TrySetCanceled(); _leaveReady?.TrySetCanceled();
            _permissionDialog?.Close(false); _closeDialog?.Close(true); _allowedDevices.Clear();
            // Closing the controller releases camera/microphone even if the renderer stopped responding.
            _browser.DisposeBrowser(); _lifetime.Dispose();
        };
    }

    public bool Matches(ReceiverConfig config) =>
        string.Equals(_config.Endpoint.TrimEnd('/'), config.Endpoint.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
        && _config.DeviceId == config.DeviceId && _config.DeviceToken == config.DeviceToken && _config.ClassId == config.ClassId;

    private ReadingBrowser CreateBrowser()
    {
        var browser = new ReadingBrowser { HandleEscapeKey = false, HandleFullscreenKey = false };
        browser.FocusOutside += next =>
        {
            if (!_closed && ReferenceEquals(browser, _browser))
                browser.FocusPage(next ? CoreWebView2MoveFocusReason.Next : CoreWebView2MoveFocusReason.Previous);
        };
        return browser;
    }

    public void BringForward(Window? owner = null)
    {
        if (!IsVisible)
        {
            if (Owner is null && owner?.IsVisible == true) Show(owner);
            else Show();
        }
        WindowState = WindowState.Normal; Activate(); _browser.FocusPage();
    }

    public void CloseWithoutPrompt()
    { _forceClose = true; _closeDialog?.Close(true); Close(); }

    public async Task LoadAsync(string view = "submit")
    {
        if (_loading || _closed || _closing) return;
        CancelTranscription();
        _loading = true; _retry.IsVisible = false;
        _message.Text = "正在连接创意计划…"; _notice.IsVisible = true;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        linked.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            if (_browserFailed)
            {
                _browser.DisposeBrowser(); _surface.Children.Remove(_browser);
                _browser = CreateBrowser();
                _surface.Children.Insert(0, _browser); _initialized = false; _browserFailed = false;
            }
            if (!_initialized)
            {
                var profileKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                    _origin.AbsoluteUri + "\n" + _config.DeviceId + "\n" + _config.ClassId)))[..24];
                var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ICeClass", "Ideas", profileKey);
                await _browser.InitializeAsync(profile, linked.Token).WaitAsync(linked.Token);
                if (_closed || _closing) return;
                var core = _browser.Core!;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.NavigationStarting += (_, args) =>
                {
                    if (!AllowedPage(args.Uri)) { args.Cancel = true; return; }
                    CancelTranscription(); _pageNavigating = true; _pageNavigationId = args.NavigationId;
                    if (_navigation is not null && _navigationId is null
                        && string.Equals(args.Uri, _navigationTarget, StringComparison.Ordinal))
                        _navigationId = args.NavigationId;
                };
                core.NewWindowRequested += (_, args) => args.Handled = true;
                core.DownloadStarting += (_, args) => args.Cancel = true;
                core.LaunchingExternalUriScheme += (_, args) => args.Cancel = true;
                core.AddWebResourceRequestedFilter(_origin.GetLeftPart(UriPartial.Authority) + "/api/ideas/*",
                    CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document);
                core.WebResourceRequested += (_, args) =>
                {
                    if (_closed || !SameOrigin(args.Request.Uri)
                        || !new Uri(args.Request.Uri).AbsolutePath.StartsWith("/api/ideas/", StringComparison.Ordinal)
                        || !AllowedPage(core.Source)) return;
                    args.Request.Headers.SetHeader("Authorization", "Bearer " + _config.DeviceToken);
                    args.Request.Headers.SetHeader("X-ICeClass-Device-Id", _config.DeviceId);
                };
                core.WebMessageReceived += (_, args) =>
                {
                    if (_closed || !ReferenceEquals(core, _browser.Core)
                        || !AllowedPage(args.Source) || !SameOrigin(args.Source)) return;
                    try
                    {
                        var json = args.WebMessageAsJson;
                        if (json.Length > IdeasVoiceTranscriber.MaximumEncodedLength + 1024) return;
                        using var message = JsonDocument.Parse(json);
                        if (message.RootElement.ValueKind == JsonValueKind.String)
                        { if (message.RootElement.GetString() == "close") Close(); }
                        else if (message.RootElement.ValueKind == JsonValueKind.Object
                            && message.RootElement.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String)
                        {
                            if (type.GetString() == "ideas-leave")
                                _leaveReady?.TrySetResult(message.RootElement.GetProperty("safe").GetBoolean());
                            else if (type.GetString() is "ideas-transcribe" or "ideas-transcribe-cancel"
                                && CanTranscribe(core, args.Source)
                                && message.RootElement.TryGetProperty("requestId", out var id) && id.ValueKind == JsonValueKind.String
                                && IdeasVoiceTranscriber.IsValidRequestId(id.GetString()))
                            {
                                var requestId = id.GetString()!;
                                if (type.GetString() == "ideas-transcribe-cancel")
                                {
                                    if (string.Equals(requestId, _transcriptionRequestId, StringComparison.OrdinalIgnoreCase)) CancelTranscription();
                                }
                                else
                                {
                                    var audio = message.RootElement.TryGetProperty("audioBase64", out var value)
                                        && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                                    _ = TranscribeIdeasAsync(core, args.Source, requestId, audio);
                                }
                            }
                        }
                    }
                    catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException) { }
                };
                core.PermissionRequested += PermissionRequested;
                core.NavigationCompleted += (_, args) =>
                {
                    if (_pageNavigationId == args.NavigationId) _pageNavigating = !args.IsSuccess;
                    if (_navigationId == args.NavigationId) _navigation?.TrySetResult(args.IsSuccess);
                };
                core.ProcessFailed += (_, _) =>
                {
                    _browserFailed = true; _navigation?.TrySetResult(false);
                    ShowError("页面已停止，请重新打开。未提交的草稿仍留在本机。");
                };
                await core.AddScriptToExecuteOnDocumentCreatedAsync("""
                    if (window === window.top) {
                      window.ICeClassIdeasDesktop = {send: action => window.chrome.webview.postMessage(action)};
                    }
                    """);
                _initialized = true;
            }
            var navigation = _navigation = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _navigationId = null;
            _navigationTarget = new Uri(_origin, "ideas/?view=" + (view is "class" or "showcase" ? view : "submit")).AbsoluteUri;
            _browser.Core!.Navigate(_navigationTarget);
            if (!await navigation.Task.WaitAsync(linked.Token))
            { ShowError("暂时无法连接，请检查网络后重新打开。"); return; }
            if (_closed || _closing) return;
            _notice.IsVisible = false; _browser.IsVisible = true;
            _browser.SetPageVisible(WindowState != WindowState.Minimized); _browser.FocusPage();
        }
        catch (OperationCanceledException) when (_closed) { }
        catch (Exception error)
        {
            if (!_initialized) _browserFailed = true;
            AppLog.Error("Open creative ideas failed", error);
            ShowError(error is WebView2RuntimeNotFoundException
                ? "请先安装 Microsoft Edge WebView2，再打开创意计划。"
                : "暂时无法打开，请检查网络后重试。");
        }
        finally { _loading = false; _navigation = null; _navigationId = null; _navigationTarget = null; }
    }

    private bool SameOrigin(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == _origin.Scheme && uri.Host == _origin.Host && uri.Port == _origin.Port;
    private bool AllowedPage(string value) => value == "about:blank" || SameOrigin(value)
        && new Uri(value).AbsolutePath is "/ideas/" or "/ideas/index.html";

    private bool CanTranscribe(CoreWebView2 core, string source) => !_closed && !_closing && !_loading
        && !_browserFailed && !_pageNavigating && IsVisible && WindowState != WindowState.Minimized && !_notice.IsVisible
        && ReferenceEquals(core, _browser.Core) && SameOrigin(source) && AllowedPage(source)
        && string.Equals(core.Source, source, StringComparison.Ordinal);

    private async Task TranscribeIdeasAsync(CoreWebView2 core, string source, string requestId, string? audioBase64)
    {
        if (_transcriptionCancellation is not null)
        {
            SendTranscription(core, source, _transcriptionGeneration, requestId, "", IdeasVoiceTranscriber.BusyMessage);
            return;
        }
        var generation = ++_transcriptionGeneration;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _transcriptionCancellation = cancellation; _transcriptionRequestId = requestId;
        try
        {
            var text = await _voiceTranscriber.TranscribeAsync(audioBase64, cancellation.Token);
            if (!cancellation.IsCancellationRequested) SendTranscription(core, source, generation, requestId, text, "");
        }
        catch (OperationCanceledException) { }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            var message = error is InvalidDataException ? error.Message
                : error is InvalidOperationException && error.Message == IdeasVoiceTranscriber.BusyMessage
                    ? IdeasVoiceTranscriber.BusyMessage : "本机语音转写暂时不可用，请稍后重试，也可以直接输入文字。";
            if (!cancellation.IsCancellationRequested) SendTranscription(core, source, generation, requestId, "", message);
        }
        finally
        {
            if (ReferenceEquals(_transcriptionCancellation, cancellation))
            { _transcriptionCancellation = null; _transcriptionRequestId = null; }
        }
    }

    private void SendTranscription(CoreWebView2 core, string source, int generation, string requestId, string text, string error)
    {
        if (generation != _transcriptionGeneration) return;
        try
        {
            if (CanTranscribe(core, source))
                core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "ideas-transcription", requestId, text, error }));
        }
        catch (Exception failure) when (failure is not OutOfMemoryException) { } // The page/controller may have closed.
    }

    private void CancelTranscription()
    {
        ++_transcriptionGeneration;
        var cancellation = _transcriptionCancellation;
        _transcriptionCancellation = null; _transcriptionRequestId = null;
        cancellation?.Cancel();
    }

    private void ShowError(string message)
    {
        if (_closed) return;
        _ = SuspendCaptureAsync(); _allowedDevices.Clear();
        _browser.SetPageVisible(false); _browser.IsVisible = false;
        _message.Text = message; _retry.IsVisible = true; _notice.IsVisible = true;
    }

    private async Task SuspendCaptureAsync()
    {
        CancelTranscription();
        try { if (_browser.Core is { } core) await core.ExecuteScriptAsync("window.ICeClassIdeas?.suspend?.();"); }
        catch (Exception error) when (error is not OutOfMemoryException) { AppLog.Error("Stop ideas capture", error); }
    }

    private async Task CloseSafelyAsync()
    {
        if (_closing || _closed) return;
        CancelTranscription();
        _closing = true; _permissionDialog?.Close(false); _allowedDevices.Clear();
        var safe = _browser.Core is null || _browserFailed || !SameOrigin(_browser.Core.Source);
        try
        {
            if (!safe)
            {
                _leaveReady = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                await _browser.Core!.ExecuteScriptAsync("""
                    (async()=>{
                      try {
                        const result = await window.ICeClassIdeas?.prepareToLeave?.();
                        window.chrome.webview.postMessage({type:'ideas-leave',safe:!result || result.saved || !result.hasDraft});
                      } catch { window.chrome.webview.postMessage({type:'ideas-leave',safe:false}); }
                    })();
                    """);
                safe = await _leaveReady.Task.WaitAsync(TimeSpan.FromSeconds(4));
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { AppLog.Error("Save ideas draft on close", error); }
        finally { _leaveReady = null; }
        if (_closed) return;
        if (!safe && !_closed && !_forceClose)
        {
            var dialog = new Window { Title = "草稿尚未保存", Width = 460, MinHeight = 230, SizeToContent = SizeToContent.Height, CanResize = false,
                WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brushes.White };
            ClassroomStyle.Apply(dialog); DesktopStyle.KeepWindowInWorkingArea(dialog);
            var keep = ClassroomStyle.Button("继续编辑", true); var discard = ClassroomStyle.Button("放弃并关闭");
            keep.Click += (_, _) => dialog.Close(false); discard.Click += (_, _) => dialog.Close(true);
            dialog.Content = new StackPanel { Margin = new Thickness(24), Spacing = 18, Children = {
                ClassroomStyle.SectionTitle("草稿暂时无法保存"), ClassroomStyle.Caption("继续编辑并提交，或放弃本次未保存的内容。"),
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { discard, keep } } } };
            _closeDialog = dialog;
            try { safe = await dialog.ShowDialog<bool>(this); }
            finally { _closeDialog = null; }
        }
        if (_closed) return;
        if (!safe && !_forceClose) { _closing = false; return; }
        _canClose = true; Close();
    }

    private async void PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        args.State = CoreWebView2PermissionState.Deny; args.SavesInProfile = false;
        if (_closed || _closing || !IsVisible || WindowState == WindowState.Minimized || !SameOrigin(args.Uri)
            || !AllowedPage(_browser.Core?.Source ?? "") || args.PermissionKind is not (CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Microphone)) return;
        if (_allowedDevices.Contains(args.PermissionKind)) { args.State = CoreWebView2PermissionState.Allow; return; }
        if (_permissionDialog is not null) return;
        using var deferral = args.GetDeferral();
        try
        {
            var camera = args.PermissionKind == CoreWebView2PermissionKind.Camera;
            var device = camera ? "摄像头" : "麦克风";
            var dialog = new Window { Title = $"允许{device} · 千人创意计划", Width = 480, Height = 250,
                CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brushes.White,
                Icon = new WindowIcon(AppIconFactory.CreateStream()) };
            ClassroomStyle.Apply(dialog); DesktopStyle.KeepWindowInWorkingArea(dialog);
            var allow = ClassroomStyle.Button($"允许{device}", true); var deny = ClassroomStyle.Button("暂不允许");
            allow.Click += (_, _) => dialog.Close(true); deny.Click += (_, _) => dialog.Close(false);
            var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
            deny.Margin = new Thickness(0, 0, 6, 0); allow.Margin = new Thickness(6, 0, 0, 0);
            actions.Children.Add(deny); Grid.SetColumn(allow, 1); actions.Children.Add(allow);
            var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
            root.Children.Add(new StackPanel { Margin = new Thickness(24, 20), Spacing = 10, Children = {
                ClassroomStyle.SectionTitle($"使用{device}"),
                ClassroomStyle.Text(camera ? "只用于拍下纸上的创意，确认提交后才上传照片。" : "只用于录制创意说明，确认提交后才上传录音。", 16, muted: true) } });
            var footer = DesktopStyle.DialogFooter(actions); Grid.SetRow(footer, 1); root.Children.Add(footer);
            dialog.Content = root; _permissionDialog = dialog;
            if (await dialog.ShowDialog<bool>(this) && !_closed && IsVisible && WindowState != WindowState.Minimized)
            { _allowedDevices.Add(args.PermissionKind); args.State = CoreWebView2PermissionState.Allow; }
        }
        catch (Exception error) { AppLog.Error("Ideas device permission failed", error); }
        finally { _permissionDialog = null; }
    }
}

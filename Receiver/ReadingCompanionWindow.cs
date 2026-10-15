using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

internal sealed class ReadingCompanionWindow : Window
{
    private readonly ReceiverConfig _config;
    private readonly Uri _origin;
    private ReadingBrowser _browser = new();
    private readonly Grid _surface = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBlock _classLabel = DesktopStyle.Text("", 15, true);
    private readonly TextBlock _errorTitle = DesktopStyle.Text("正在打开早读陪伴", 28, true);
    private readonly TextBlock _errorText = DesktopStyle.Text("稍候片刻，正在连接本班的早读空间。", 17, muted: true);
    private readonly Button _retry = DesktopStyle.Button("重新连接", true);
    private readonly Button _runtime = DesktopStyle.Button("安装运行组件");
    private readonly Button _fullscreen = ToolbarButton("全屏", true);
    private readonly Button _home = ToolbarButton("返回");
    private readonly Border _chrome;
    private readonly Border _notice;
    private Window? _permissionDialog;
    private TaskCompletionSource? _leaveReady;
    private TaskCompletionSource<bool>? _pageReady;
    private bool _initialized, _loading, _closing, _canClose, _browserFailed;
    public event Action? HomeRequested;

    public ReadingCompanionWindow(ReceiverConfig config)
    {
        _config = new ReceiverConfig { Endpoint = config.Endpoint, DeviceId = config.DeviceId, DeviceToken = config.DeviceToken, ClassId = config.ClassId, ClassName = config.ClassName };
        _origin = new Uri(config.Endpoint.TrimEnd('/') + "/");
        Title = "早读陪伴 · 班伴"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 1200; Height = 820; MinWidth = 640; MinHeight = 480;
        SystemDecorations = SystemDecorations.Full;
        DesktopStyle.KeepWindowInWorkingArea(this);
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F4F9FF");
        var root = new Grid { RowDefinitions = new RowDefinitions("Auto,*") };
        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,*"), Margin = new Thickness(12, 7) };
        _home.Click += async (_, _) => await ReturnHomeAsync();
        _home.HorizontalAlignment = HorizontalAlignment.Left;
        ToolTip.SetTip(_home, "返回教室首页，并结束本次早读");
        header.Children.Add(_home);
        _classLabel.Text = config.ClassName; _classLabel.MaxWidth = 360; _classLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        _classLabel.TextWrapping = TextWrapping.NoWrap; _classLabel.Foreground = DesktopStyle.Brush("#426182");
        _classLabel.VerticalAlignment = VerticalAlignment.Center;
        var classTag = new Border { Background = DesktopStyle.Brush("#EAF2FB"), CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 3), VerticalAlignment = VerticalAlignment.Center, Child = _classLabel };
        var title = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0), Children = { DesktopStyle.Logo(26), classTag } };
        Grid.SetColumn(title, 1); header.Children.Add(title);
        _fullscreen.HorizontalAlignment = HorizontalAlignment.Right;
        ToolTip.SetTip(_fullscreen, "全屏后，长按屏幕空白处 2 秒即可退出");
        _fullscreen.Click += (_, _) => ToggleFullscreen();
        Grid.SetColumn(_fullscreen, 2); header.Children.Add(_fullscreen);
        _chrome = new Border { Background = DesktopStyle.Brush("#F8FAFD"), BorderBrush = DesktopStyle.Brush("#E3E9F1"), BorderThickness = new Thickness(0, 0, 0, 1), Child = header };
        root.Children.Add(_chrome);
        _surface.Children.Add(_browser);
        _retry.IsVisible = false; _runtime.IsVisible = false;
        _retry.Click += async (_, _) => await LoadAsync();
        _runtime.Click += (_, _) => Process.Start(new ProcessStartInfo("https://go.microsoft.com/fwlink/p/?LinkId=2124703") { UseShellExecute = true });
        var message = new StackPanel { Spacing = 18, MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Children = { DesktopStyle.Logo(80), _errorTitle, _errorText, _retry, _runtime } };
        _notice = new Border { Background = DesktopStyle.Brush("#F4F9FF"), Padding = new Thickness(32), Child = message };
        _surface.Children.Add(_notice); Grid.SetRow(_surface, 1); root.Children.Add(_surface); Content = root;
        WireBrowser();
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { ExitFullscreen(); args.Handled = true; } };
        PropertyChanged += (_, args) =>
        {
            if (args.Property == WindowStateProperty)
            {
                SendFullscreenState();
                _browser.SetPageVisible(WindowState != WindowState.Minimized && !_notice.IsVisible);
            }
        };
        Closing += (_, args) =>
        {
            if (_canClose || args.CloseReason is WindowCloseReason.ApplicationShutdown or WindowCloseReason.OSShutdown) return;
            args.Cancel = true; _ = ReturnHomeAsync();
        };
        Closed += (_, _) => { _lifetime.Cancel(); _permissionDialog?.Close(false); _browser.DisposeBrowser(); _lifetime.Dispose(); };
    }

    private static Button ToolbarButton(string text, bool primary = false) => new()
    {
        Content = text, MinHeight = 40, MinWidth = 76, FontSize = 15,
        Padding = new Thickness(14, 7), CornerRadius = new CornerRadius(10),
        Background = primary ? DesktopStyle.Brush("#E5F0FF") : Brushes.Transparent,
        Foreground = primary ? DesktopStyle.Brush("#0969CE") : DesktopStyle.Brush("#4B5C70"),
        BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center, HorizontalContentAlignment = HorizontalAlignment.Center,
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    public bool Matches(ReceiverConfig config) => string.Equals(_config.Endpoint.TrimEnd('/'), config.Endpoint.TrimEnd('/'), StringComparison.OrdinalIgnoreCase) && _config.DeviceId == config.DeviceId && _config.DeviceToken == config.DeviceToken;
    public bool HasClass(string classId) => _config.ClassId == classId;
    public void SetClassName(string name) { _config.ClassName = name; _classLabel.Text = name; }
    public void BringForward() { Show(); WindowState = WindowState.FullScreen; Activate(); _browser.FocusPage(); }

    public async Task LoadAsync(CancellationToken token = default)
    {
        if (_loading || _closing) return;
        _loading = true; _retry.IsVisible = false; _runtime.IsVisible = false;
        _errorTitle.Text = "正在打开早读陪伴"; _errorText.Text = "稍候片刻，正在连接本班的早读空间。";
        _notice.IsVisible = true;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _lifetime.Token);
        linked.CancelAfter(TimeSpan.FromSeconds(30));
        _pageReady = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var elapsed = Stopwatch.StartNew();
        var launch = ClassroomControlService.CreateReadingLaunchAsync(_config, linked.Token);
        try
        {
            if (_browserFailed)
            {
                _browser.DisposeBrowser(); _surface.Children.Remove(_browser);
                _browser = new ReadingBrowser(); WireBrowser();
                _surface.Children.Insert(0, _browser); _initialized = false; _browserFailed = false;
            }
            _browser.SetPageVisible(false); SendFullscreenState();
            if (!_initialized)
            {
                Directory.CreateDirectory(ProfileDirectory());
                await _browser.InitializeAsync(ProfileDirectory(), linked.Token).WaitAsync(linked.Token);
                _browser.IsVisible = false;
                var core = _browser.Core!;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.NavigationStarting += (_, args) => { if (!AllowedPage(args.Uri)) args.Cancel = true; };
                core.NewWindowRequested += (_, args) => args.Handled = true;
                core.DownloadStarting += (_, args) => args.Cancel = true;
                core.LaunchingExternalUriScheme += (_, args) => args.Cancel = true;
                core.PermissionRequested += PermissionRequested;
                core.WebMessageReceived += (_, args) =>
                {
                    if (!AllowedPage(args.Source)) return;
                    try
                    {
                        switch (args.TryGetWebMessageAsString())
                        {
                            case "home": _ = ReturnHomeAsync(); break;
                            case "fullscreen": ToggleFullscreen(); break;
                            case "enter-fullscreen": WindowState = WindowState.FullScreen; break;
                            case "exit-fullscreen": ExitFullscreen(); break;
                            case "leave-ready": _leaveReady?.TrySetResult(); break;
                            case "reading-ready": _pageReady?.TrySetResult(true); break;
                            case "reading-error": _pageReady?.TrySetResult(false); break;
                            case "reading-retry": _ = LoadAsync(); break;
                        }
                    }
                    catch (ArgumentException) { }
                };
                core.ContainsFullScreenElementChanged += (_, _) => { if (core.ContainsFullScreenElement) WindowState = WindowState.FullScreen; };
                core.ProcessFailed += (_, _) => { if (_closing) return; _browserFailed = true; _pageReady?.TrySetException(new InvalidOperationException("Reading renderer stopped")); ShowError("早读页面需要重新连接", "本轮已停止。点击重新连接，即可重新选择陪伴模式。"); };
                core.NavigationCompleted += (_, args) =>
                {
                    if (_closing || core.Source == "about:blank") return;
                    if (!args.IsSuccess) { _pageReady?.TrySetException(new InvalidOperationException("Reading navigation failed: " + args.WebErrorStatus)); return; }
                    _errorText.Text = "页面已载入，正在确认班级连接…";
                    SendFullscreenState();
                };
                await core.AddScriptToExecuteOnDocumentCreatedAsync("""
                    if (window === window.top) {
                      window.ICeClassDesktop = { connectionHandshake: true, send: action => window.chrome.webview.postMessage(action) };
                      window.chrome.webview.addEventListener('message', event => {
                        if (event.data?.type !== 'fullscreen') return;
                        window.ICeClassDesktop.fullscreen = event.data.value;
                        document.documentElement.dataset.desktopFullscreen = String(event.data.value);
                        window.dispatchEvent(new Event('iceclass:fullscreenchange'));
                      });
                    }
                    """);
                _initialized = true;
            }
            linked.Token.ThrowIfCancellationRequested();
            var uri = await launch;
            linked.Token.ThrowIfCancellationRequested();
            _errorText.Text = "正在载入活动首页…";
            _browser.Core!.Navigate(uri.AbsoluteUri);
            if (!await _pageReady.Task.WaitAsync(linked.Token))
            {
                ShowError("班级连接未完成", "连接超时或绑定已失效。请检查网络，点击重新连接；仍无法打开时返回首页检查教室设置。");
                return;
            }
            _notice.IsVisible = false; _browser.IsVisible = true; _browser.SetPageVisible(true);
            SendFullscreenState(); _browser.FocusPage();
            AppLog.Info($"Reading ready in {elapsed.ElapsedMilliseconds} ms; WebView2 {_browser.Core.Environment.BrowserVersionString}");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested || _lifetime.IsCancellationRequested) { throw; }
        catch (OperationCanceledException) { if (!_initialized) _browserFailed = true; ShowError("连接等待超时", "请检查教室网络，点击重新连接。也可以返回首页，稍后再试。"); }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowError("还差一个运行组件", "这台电脑需要安装 Microsoft Edge WebView2。点击下方按钮安装，完成后重新打开班伴。");
            _runtime.IsVisible = true;
        }
        catch (Exception error)
        {
            AppLog.Error("Embedded reading failed", error);
            ShowError("暂时无法打开早读空间", "请检查教室网络和绑定设置，然后点击重新连接。");
        }
        finally
        {
            linked.Cancel();
            // Observe a parallel launch failure even when the browser initialization failed first.
            _ = launch.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
            _loading = false;
        }
    }

    private string ProfileDirectory()
    {
        static string Safe(string text) => string.Concat(text.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.' ? c : '_'));
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Reading", Safe(_origin.GetLeftPart(UriPartial.Authority)), Safe(_config.DeviceId));
    }
    private void WireBrowser()
    {
        _browser.EscapePressed += ExitFullscreen; _browser.FullscreenPressed += ToggleFullscreen;
        _browser.FocusOutside += next => { if (!_chrome.IsVisible) _browser.FocusPage(); else if (next) _home.Focus(); else _fullscreen.Focus(); };
    }
    private bool SameOrigin(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == _origin.Scheme && uri.Host == _origin.Host && uri.Port == _origin.Port;
    private bool AllowedPage(string value) => value == "about:blank" || SameOrigin(value) && new Uri(value).AbsolutePath.StartsWith("/reading/", StringComparison.Ordinal);
    private void ShowError(string title, string message)
    {
        if (_closing) return;
        _browser.SetPageVisible(false); _browser.IsVisible = false; _notice.IsVisible = true; _errorTitle.Text = title; _errorText.Text = message;
        _retry.IsVisible = true;
        _chrome.IsVisible = true;
        try { _browser.Core?.Stop(); if (!_browserFailed) _browser.Core?.Navigate("about:blank"); } catch { }
    }
    private void ToggleFullscreen() { if (WindowState == WindowState.FullScreen) ExitFullscreen(); else WindowState = WindowState.FullScreen; }
    private void ExitFullscreen()
    {
        if (_closing) return;
        if (WindowState == WindowState.FullScreen) WindowState = WindowState.Normal;
        _ = _browser.Core?.ExecuteScriptAsync("if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});");
    }
    private void SendFullscreenState()
    {
        var fullscreen = WindowState == WindowState.FullScreen;
        _chrome.IsVisible = !fullscreen || _notice.IsVisible;
        _fullscreen.Content = fullscreen ? "退出全屏" : "全屏";
        _browser.Core?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "fullscreen", value = fullscreen }));
    }

    private async void PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        args.State = CoreWebView2PermissionState.Deny;
        if (_closing || args.PermissionKind != CoreWebView2PermissionKind.Microphone || !SameOrigin(args.Uri) || _permissionDialog is not null) return;
        using var deferral = args.GetDeferral();
        args.SavesInProfile = false;
        try
        {
            var dialog = new Window { Title = "允许麦克风 · 班伴", Width = 500, Height = 340, CanResize = false, WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brushes.White, Icon = new WindowIcon(AppIconFactory.CreateStream()) };
            _permissionDialog = dialog;
            var allow = DesktopStyle.Button("允许麦克风", true); var deny = DesktopStyle.Button("暂不允许");
            var remember = new CheckBox { Content = "在这台教室电脑上记住选择", IsChecked = true, FontSize = 16 };
            allow.Click += (_, _) => dialog.Close(true); deny.Click += (_, _) => dialog.Close(false);
            dialog.Content = new StackPanel { Margin = new Thickness(28), Spacing = 16, Children = { DesktopStyle.Text("让朗读被看见", 25, true), DesktopStyle.Text("早读陪伴需要麦克风感知声量。声音在本机分析，不会上传录音。", 17, muted: true), remember, allow, deny } };
            var accepted = await dialog.ShowDialog<bool>(this);
            if (!_closing && accepted) { args.State = CoreWebView2PermissionState.Allow; args.SavesInProfile = remember.IsChecked == true; }
        }
        catch (Exception error) { AppLog.Error("Reading microphone permission failed", error); }
        finally { _permissionDialog = null; }
    }

    public async Task ReturnHomeAsync(bool showHome = true)
    {
        if (_closing) return;
        _closing = true; _lifetime.Cancel(); _permissionDialog?.Close(false);
        try
        {
            if (_browser.Core is { } core)
            {
                // Stop capture and flush the last statistics batch before destroying the view.
                _leaveReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                await core.ExecuteScriptAsync("(async()=>{try{if(window.ReadingDesktop)await window.ReadingDesktop.prepareToLeave();else window.dispatchEvent(new PageTransitionEvent('pagehide'));}finally{window.ICeClassDesktop?.send('leave-ready');}})();");
                await _leaveReady.Task.WaitAsync(TimeSpan.FromSeconds(3));
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { AppLog.Error("Reading page exit", error); }
        _canClose = true; Close();
        if (showHome) HomeRequested?.Invoke();
    }
}

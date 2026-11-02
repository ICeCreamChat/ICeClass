using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using ICeClass.Receiver;
using ICeClass.Updates;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Desktop;

internal sealed class DesktopWindow : Window
{
    private readonly App _app;
    private readonly string _endpoint;
    private readonly string _initialAddress;
    private readonly bool _main;
    private readonly ReadingBrowser _browser = new() { HandleEscapeKey = false, HandleFullscreenKey = false };
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBlock _status = DesktopStyle.Text("正在打开学校平台…", 12, muted: true);
    private readonly StackPanel _error = new() { MaxWidth = 460, Spacing = 16, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(32) };
    private readonly TextBlock _errorTitle = DesktopStyle.Text("正在准备工作台", 20, true);
    private readonly TextBlock _errorNote = DesktopStyle.Text("首次打开可能需要片刻，请稍候。", 14, muted: true);
    private readonly Button _retry = Dialogs.Button("重新连接", true);
    private readonly Button _runtime = Dialogs.Button("获取运行组件");
    private readonly Button _feedbackAction = ToolbarButton("反馈");
    private readonly ProgressBar _progress = new() { IsIndeterminate = true, Height = 2, IsVisible = true };
    private readonly Border _toolbar;
    private readonly List<DesktopWindow> _children = [];
    private bool _initialized, _disposed, _checkingUpdate, _navigated, _needsRestart;
    private WindowState _beforeFullscreen;
    private CancellationTokenSource? _navigationTimeout;
    private ClassroomVoiceInbox? _voiceInbox;
    private ClassroomVoiceNoticeWindow? _voiceNotice;
    private TeacherFeedbackWindow? _feedbackWindow;
    private bool _openingFeedback;
    private readonly Stopwatch _navigationWatch = new();
    private CancellationTokenSource? _updateDownload;
    private Task? _backgroundUpdateTask;
    private DesktopUpdate? _offeredUpdate;
    private PreparedUpdate? _readyUpdate;
    private bool _automaticDownload, _pickingFile;
    private readonly HashSet<Guid> _recordingFrames = [];
    private readonly HashSet<CoreWebView2DownloadOperation> _pageDownloads = [];
    private readonly TeacherActions _teacherActions;
    private bool _teacherDocumentActive;

    internal DesktopWindow(App app, string endpoint, bool main, string? address = null)
    {
        _app = app; _endpoint = endpoint; _main = main; _initialAddress = address ?? endpoint + "/";
        _teacherActions = new TeacherActions(endpoint, ReadTeacherActionContextAsync,
            new("teacher.settings.open", "打开桌面设置", false, "打开本机设置窗口，由老师自行保存。",
                _ => OpenTeacherDialogAsync(ShowSettingsAsync, "已打开桌面设置，请在窗口中保存；此回执不代表已保存。")),
            new("teacher.about", "查看教师端关于", false, "打开教师端版本与说明窗口。",
                _ => OpenTeacherDialogAsync(ShowAbout, "已打开教师端关于窗口。")),
            new("teacher.feedback", "打开反馈表单", false, "打开反馈表单，由老师填写并确认发送。",
                async context => await ShowFeedback(context) ? TeacherActionResult.Opened("已打开反馈表单，尚未发送反馈。")
                    : TeacherActionResult.Refused("feedback-unavailable", "反馈表单未打开，请检查教师端窗口。")),
            new("teacher.refresh", "刷新教师工作台", false, "重新加载当前页面，请先保存尚未提交的内容。", RefreshTeacherActionAsync),
            new("teacher.updates.check", "检查教师端更新", false, "仅检查可用更新，不下载、安装或重启。",
                _ => CheckUpdatesCoreAsync(checkOnly: true)));
        Title = main ? "ICeClass 班伴 · 教师端" : "ICeClass 班伴 · 教师端 · 新窗口";
        Width = 1280; Height = 820; MinWidth = 800; MinHeight = 560;
        Background = Brushes.White; SystemDecorations = SystemDecorations.Full;
        WindowStartupLocation = WindowStartupLocation.CenterScreen; Icon = new WindowIcon(AppIconFactory.CreateStream());
        DesktopStyle.KeepWindowInWorkingArea(this);
        _browser.EscapePressed += async () => await ExitFullscreen();
        KeyDown += async (_, args) =>
        {
            if (WindowState == WindowState.FullScreen && args.Key == Key.Escape)
            { args.Handled = true; await ExitFullscreen(); }
        };
        var refresh = ToolbarButton("刷新页面"); refresh.Click += async (_, _) =>
        {
            if (await ConfirmRefreshAsync()) Navigate();
        };
        var settings = ToolbarButton("桌面设置"); settings.Click += async (_, _) =>
        { await ShowSettingsAsync(); };
        var more = ToolbarButton("关于"); more.Click += async (_, _) =>
        { await ShowAbout(); };
        var feedback = _feedbackAction; feedback.Click += async (_, _) => await ShowFeedback();
        _browser.FocusOutside += forward => (forward ? refresh : feedback).Focus();
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { refresh, settings, more, feedback } };
        var toolbar = new Grid { ColumnDefinitions = new ColumnDefinitions("*,16,Auto"), Margin = new Thickness(16, 5) };
        _status.VerticalAlignment = VerticalAlignment.Center; _status.TextTrimming = TextTrimming.CharacterEllipsis; toolbar.Children.Add(_status);
        ToolTip.SetTip(_status, _endpoint);
        Grid.SetColumn(actions, 2); toolbar.Children.Add(actions);
        var surface = new Grid(); surface.Children.Add(_browser);
        _error.Children.Add(_errorTitle); _error.Children.Add(_errorNote); _error.Children.Add(_retry); _error.Children.Add(_runtime); surface.Children.Add(_error);
        _retry.IsVisible = false; _runtime.IsVisible = false;
        _retry.Click += async (_, _) =>
        {
            try { if (_needsRestart) _app.Restart(); else if (!_initialized) await InitializePage(); else Navigate(); }
            catch (Exception error) { DesktopLog.Write(error); ShowError("重新连接未完成", "请从托盘退出工作台，再重新打开。您的登录资料仍会保留。"); }
        };
        _runtime.Click += (_, _) => OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/#download-section");
        var layout = new Grid { RowDefinitions = new RowDefinitions("Auto,Auto,*") };
        _toolbar = new Border { Background = DesktopStyle.Brush("#F7FAFE"), BorderBrush = DesktopStyle.Brush("#E4ECF5"), BorderThickness = new Thickness(0, 0, 0, 1), Child = toolbar };
        layout.Children.Add(_toolbar);
        Grid.SetRow(_progress, 1); layout.Children.Add(_progress); Grid.SetRow(surface, 2); layout.Children.Add(surface); Content = layout;
        Opened += async (_, _) => { await InitializePage(); };
        Closing += (_, args) =>
        {
            if (_main && !_app.ExitRequested && _app.Settings.CloseToTray && _app.HasTray)
            { args.Cancel = true; _browser.SetPageVisible(false); Hide(); }
        };
        Closed += (_, _) => { DisposePage(); if (_main && !_app.ExitRequested) _app.Exit(); };
    }

    internal void SetStatus(string text) => _status.Text = text;
    internal void RestorePage() { if (!_disposed) _browser.SetPageVisible(_error.IsVisible == false); }
    private string ConnectedStatus => new Uri(_endpoint).IsLoopback ? "本地验收" : "已连接学校平台";
    private static Button ToolbarButton(string text)
    {
        var button = Dialogs.Button(text); button.Classes.Add("toolbar-action"); button.FontSize = 13;
        button.MinHeight = 32; button.Padding = new Thickness(12, 5); return button;
    }

    private async Task InitializePage()
    {
        if (_initialized || _disposed) return;
        _retry.IsVisible = false; _runtime.IsVisible = false; _progress.IsVisible = true;
        try
        {
            await _browser.InitializeAsync(DesktopSettings.ProfileDirectory(App.DataDirectory, _endpoint), _lifetime.Token);
            if (_disposed) return;
            var core = _browser.Core!;
            core.Settings.IsWebMessageEnabled = true; core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = Program.Options.Review;
            core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.WebMessageReceived += (_, args) =>
            {
                if (TeacherActions.IsMessage(args.WebMessageAsJson))
                {
                    // CoreWebView2.WebMessageReceived is for the main document only.
                    // Do not subscribe this bridge to CoreWebView2Frame.WebMessageReceived.
                    _ = HandleTeacherActionMessageAsync(args.WebMessageAsJson, args.Source); return;
                }
                if (!_disposed && DesktopSettings.SameOrigin(_endpoint, args.Source))
                {
                    if (ReadUpdateWork(args.WebMessageAsJson)) return;
                    _app.Diagnostics.RecordBrowser(args.WebMessageAsJson, _endpoint);
                }
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(UpdateWorkScript);
            using (var source = typeof(DesktopWindow).Assembly.GetManifestResourceStream("ICeClass.Desktop.teacher-actions.js")!)
            using (var script = new StreamReader(source))
                await core.AddScriptToExecuteOnDocumentCreatedAsync((await script.ReadToEndAsync()).Replace("__SCHOOL_ORIGIN__",
                    JsonSerializer.Serialize(new Uri(_endpoint).GetLeftPart(UriPartial.Authority))));
            core.IsDocumentPlayingAudioChanged += (_, _) => { if (core.IsDocumentPlayingAudio) _updateDownload?.Cancel(); };
            core.ScriptDialogOpening += (_, _) => _updateDownload?.Cancel();
            using (var source = typeof(DesktopWindow).Assembly.GetManifestResourceStream("ICeClass.Desktop.diagnostics.js")!)
            using (var script = new StreamReader(source))
                await core.AddScriptToExecuteOnDocumentCreatedAsync((await script.ReadToEndAsync()).Replace("__SCHOOL_ORIGIN__",
                    System.Text.Json.JsonSerializer.Serialize(new Uri(_endpoint).GetLeftPart(UriPartial.Authority))));
            _app.Diagnostics.Record("runtime", "WebView2 就绪", _endpoint, core.Environment.BrowserVersionString);
            core.NavigationStarting += (_, args) =>
            {
                if (!DesktopSettings.SameOrigin(_endpoint, args.Uri))
                { args.Cancel = true; if (args.IsUserInitiated) OpenExternal(args.Uri); return; }
                _teacherDocumentActive = false; _teacherActions.InvalidateDocument();
                _updateDownload?.Cancel(); _recordingFrames.Clear();
                _navigated = false; _progress.IsVisible = true; SetStatus("正在连接…");
                _navigationWatch.Restart();
                _app.Diagnostics.Record("navigation", "开始加载", args.Uri);
                _navigationTimeout?.Cancel(); _navigationTimeout?.Dispose(); _navigationTimeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                _ = NavigationDeadline(_navigationTimeout.Token);
            };
            core.ContentLoading += (_, args) => _teacherDocumentActive = !_disposed && !args.IsErrorPage;
            core.NavigationCompleted += (_, args) =>
            {
                _navigationTimeout?.Cancel(); _progress.IsVisible = false;
                if (_disposed) return;
                _app.Diagnostics.Record("navigation", args.IsSuccess ? "加载完成" : "加载失败", core.Source,
                    args.WebErrorStatus.ToString(), _navigationWatch.Elapsed.TotalMilliseconds, args.HttpStatusCode);
                if (args.IsSuccess && args.HttpStatusCode < 500)
                { _navigated = true; ShowPage(); SetStatus(ConnectedStatus); }
                else { _teacherDocumentActive = false; ShowError("暂时无法打开学校平台", "请检查网络或稍后重试。您的登录资料和学校数据不会因此被清除。"); }
            };
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (!args.IsUserInitiated) return;
                if (DesktopSettings.SameOrigin(_endpoint, args.Uri))
                {
                    var child = new DesktopWindow(_app, _endpoint, false, args.Uri); _children.Add(child);
                    child.Closed += (_, _) => _children.Remove(child); child.Show();
                }
                else OpenExternal(args.Uri);
            };
            core.PermissionRequested += (_, args) =>
            {
                args.State = DesktopSettings.SameOrigin(_endpoint, args.Uri) && args.PermissionKind == CoreWebView2PermissionKind.Microphone
                    ? CoreWebView2PermissionState.Default : CoreWebView2PermissionState.Deny;
            };
            core.ProcessFailed += (_, args) =>
            {
                _teacherDocumentActive = false; _teacherActions.InvalidateDocument();
                _app.Diagnostics.Record("runtime", "页面进程中断", detail: args.ProcessFailedKind.ToString());
                _needsRestart = true; ShowError("页面暂时中断", "点击“重新连接”会重新打开工作台。尚未提交的内容可能需要重新填写。");
            };
            core.ContainsFullScreenElementChanged += (_, _) =>
            {
                if (_disposed) return;
                if (core.ContainsFullScreenElement)
                {
                    _beforeFullscreen = WindowState;
                    _browser.HandleEscapeKey = true;
                    _toolbar.IsVisible = false;
                    WindowState = WindowState.FullScreen;
                }
                else
                {
                    _browser.HandleEscapeKey = false;
                    WindowState = _beforeFullscreen;
                    _toolbar.IsVisible = true;
                }
                Dispatcher.UIThread.Post(() => { if (!_disposed) _browser.FocusPage(); }, DispatcherPriority.Background);
            };
            core.DownloadStarting += DownloadStarting;
            _initialized = true; Navigate();
            if (_main)
            {
                _voiceInbox = new ClassroomVoiceInbox(_endpoint, ReadSessionAsync, diagnostics: _app.Diagnostics);
                _voiceInbox.Changed += UpdateVoiceNotice;
                _ = WatchClassroomVoiceAsync(_lifetime.Token);
                _ = WatchDesktopUpdatesAsync(_lifetime.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebView2RuntimeNotFoundException)
        { ShowError("还差一个运行组件", "这台电脑需要 Microsoft Edge WebView2。安装完成后，点击“重新连接”即可。"); _runtime.IsVisible = true; }
        catch (Exception error) { DesktopLog.Write(error); ShowError("工作台暂时无法启动", "请关闭并重新打开客户端；如仍无法启动，可先使用学校网页端。"); }
    }
    private async Task ExitFullscreen()
    {
        if (_disposed || _browser.Core is null) return;
        try { await _browser.Core.ExecuteScriptAsync("if(document.fullscreenElement) document.exitFullscreen();"); }
        catch (Exception error) { DesktopLog.Write(error); ShowError("全屏页面暂时中断", "请点击“重新连接”恢复工作台。"); _needsRestart = true; }
    }

    private async Task<string?> ReadSessionAsync()
    {
        if (_disposed || _browser.Core is null) return null;
        var cookies = await _browser.Core.CookieManager.GetCookiesAsync(_endpoint + "/api/classroom-voice");
        return _disposed ? null : cookies.FirstOrDefault(cookie => cookie.Name == "iceclass_session")?.Value;
    }

    private async Task<string?> ReadTeacherDocumentAsync()
    {
        if (_disposed || !_teacherDocumentActive || _browser.Core is not { } core ||
            !DesktopSettings.SameOrigin(_endpoint, core.Source)) return null;
        var value = await core.ExecuteScriptAsync("window.top === window && window.ICeClassTeacherHost ? window.ICeClassTeacherHost.clientId : null");
        return _disposed || !_teacherDocumentActive ? null : JsonSerializer.Deserialize<string?>(value);
    }

    private async Task<TeacherActionContext?> ReadTeacherActionContextAsync()
    {
        var document = await ReadTeacherDocumentAsync();
        if (document is null || string.IsNullOrEmpty(await ReadSessionAsync())) return null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var client = new TeacherFeedbackClient(_endpoint, ReadSessionAsync);
        FeedbackAccount account;
        try { account = await client.AccountAsync(timeout.Token); }
        catch (InvalidOperationException) { return null; }
        if (document != await ReadTeacherDocumentAsync() || account.Session != await ReadSessionAsync()) return null;
        return new(document, account.Session);
    }

    private async Task HandleTeacherActionMessageAsync(string message, string source)
    {
        try
        {
            if (_disposed || !_teacherDocumentActive || _browser.Core is not { } core) return;
            var reply = await _teacherActions.HandleAsync(message, source, core.Source, mainFrame: true);
            if (reply is null || _disposed || !_teacherDocumentActive ||
                !TeacherActions.TrustedSource(_endpoint, source, core.Source, mainFrame: true) ||
                reply.ClientId != await ReadTeacherDocumentAsync()) return;
            core.PostWebMessageAsJson(JsonSerializer.Serialize(reply, TeacherActions.Json));
            if (reply.Result is TeacherActionResult result) result.ReplyScheduled();
        }
        catch (Exception) { /* Never echo transport errors, credentials, or native exception messages into the page. */ }
    }

    private Task ShowSettingsAsync()
    {
        _app.Diagnostics.Record("action", "桌面设置", _browser.Core?.Source ?? _endpoint);
        return _app.ShowSettingsAsync();
    }

    private static async Task<TeacherActionResult> OpenTeacherDialogAsync(Func<Task> open, string detail)
    {
        var pending = open();
        if (pending.IsCompleted)
        {
            await pending;
            return TeacherActionResult.Refused("dialog-closed", "窗口已关闭，未确认保存任何内容。");
        }
        _ = ObserveTeacherDialogAsync(pending);
        return TeacherActionResult.Opened(detail);
    }

    private static async Task ObserveTeacherDialogAsync(Task pending)
    {
        try { await pending; }
        catch (Exception error) { DesktopLog.Write(error); }
    }

    private async Task<bool> ConfirmRefreshAsync()
    {
        _app.Diagnostics.Record("action", "刷新页面", _browser.Core?.Source ?? _endpoint);
        return await Dialogs.Confirm(this, "刷新工作台？", "页面会重新加载。请先保存尚未提交的内容。", "刷新");
    }

    private async Task<TeacherActionResult> RefreshTeacherActionAsync(TeacherActionContext expected)
    {
        if (!await ConfirmRefreshAsync()) return new(false, true, "已取消刷新，页面未重新加载。", "cancelled");
        // The confirmation can outlive logout or navigation. Revalidate before scheduling any refresh.
        var context = await ReadTeacherActionContextAsync();
        if (context != expected)
            return TeacherActionResult.Refused("document-changed", "登录或页面已变化，本次刷新未执行。");
        return new(true, false, "已确认刷新，即将重新加载；完成状态尚未核实。", "started")
        {
            AfterReply = () => Dispatcher.UIThread.Post(async () =>
            {
                try { if (expected == await ReadTeacherActionContextAsync()) Navigate(); }
                catch (Exception) { /* A refresh must not survive a changed document or login. */ }
            }, DispatcherPriority.Background)
        };
    }

    private async Task<bool> ShowFeedback(TeacherActionContext? expected = null)
    {
        if (_feedbackWindow is not null) { _feedbackWindow.Activate(); return true; }
        if (_openingFeedback || _disposed) return false;
        _openingFeedback = true;
        _updateDownload?.Cancel();
        var opening = Stopwatch.StartNew();
        _app.Diagnostics.Record("feedback", "点击反馈", _browser.Core?.Source ?? _endpoint);
        _feedbackAction.IsEnabled = false; _feedbackAction.Content = "正在打开…";
        TeacherFeedbackClient? client = null;
        try
        {
            await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Background);
            if (_disposed) return false;
            client = new(_endpoint, ReadSessionAsync, diagnostics: _app.Diagnostics);
            var account = await client.AccountAsync(_lifetime.Token);
            if (_disposed) return false;
            if (expected is not null && (expected.Identity != account.Session || expected.ClientId != await ReadTeacherDocumentAsync())) return false;
            _feedbackWindow = new TeacherFeedbackWindow(client, account, CaptureFeedbackPage,
                () => FeedbackDiagnostics.Page(_browser.Core?.Source),
                CollectFeedbackDiagnostics, _app.Diagnostics);
            client = null;
            _feedbackWindow.Closed += (_, _) => _feedbackWindow = null;
            _feedbackWindow.Show(this);
            _app.Diagnostics.Record("feedback", "表单已打开", _browser.Core?.Source ?? _endpoint, milliseconds: opening.Elapsed.TotalMilliseconds);
            return true;
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            _app.Diagnostics.Record("feedback", "打开失败", detail: error.GetType().Name, milliseconds: opening.Elapsed.TotalMilliseconds);
            if (!_disposed) await Dialogs.Message(this, "暂时无法打开反馈", error is InvalidOperationException ? error.Message : "请确认已登录教师工作台，并检查学校平台连接。");
        }
        finally
        {
            client?.Dispose(); _openingFeedback = false;
            if (!_disposed) { _feedbackAction.Content = "反馈"; _feedbackAction.IsEnabled = true; }
        }
        return false;
    }

    private async Task<string> CollectFeedbackDiagnostics(CancellationToken token)
    {
        var state = $"学校平台：{FeedbackDiagnostics.Page(_endpoint)}\n当前页面：{FeedbackDiagnostics.Page(_browser.Core?.Source)}\n" +
            $"连接状态：{_status.Text}\n页面已就绪：{_navigated}\nWebView2：{_browser.Core?.Environment.BrowserVersionString ?? "尚未就绪"}\n" +
            $"窗口：{ClientSize.Width:0}×{ClientSize.Height:0} DIP；缩放 {RenderScaling * 100:0}%\n";
        await _app.Diagnostics.FlushAsync(token);
        state += "诊断存储：" + _app.Diagnostics.StorageStatus;
        return await Task.Run(() => FeedbackDiagnostics.Collect(App.DataDirectory, state), token);
    }

    private async Task<FeedbackImage> CaptureFeedbackPage()
    {
        if (_disposed || _browser.Core is null || !_navigated || !IsVisible) throw new InvalidOperationException("请先打开需要反馈的页面。");
        using var stream = new MemoryStream();
        await _browser.Core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        return FeedbackImage.Create("当前页面.png", stream.ToArray());
    }

    private async Task WatchClassroomVoiceAsync(CancellationToken token)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
            do
            {
                try { await _voiceInbox!.RefreshAsync(token); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
                catch (Exception error) when (error is HttpRequestException or IOException or System.Text.Json.JsonException)
                { /* Keep the current reminder through temporary connection failures. */ }
            }
            while (await timer.WaitForNextTickAsync(token));
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!_disposed) DesktopLog.Write(error); }
    }

    private void UpdateVoiceNotice()
    {
        if (_disposed || _voiceInbox is null) return;
        if (_voiceNotice is not null) { _voiceNotice.UpdateMessages(); return; }
        if (_voiceInbox.Pending.Count == 0) return;
        _updateDownload?.Cancel();
        _voiceNotice = new ClassroomVoiceNoticeWindow(_voiceInbox, this);
        _voiceNotice.Closed += (_, _) => _voiceNotice = null;
        _voiceNotice.Show();
    }

    private void Navigate()
    {
        if (_disposed || _browser.Core is null) return;
        _error.IsVisible = false; _browser.IsVisible = true; _browser.SetPageVisible(true);
        try
        {
            if (_browser.Core.Source is { Length: > 0 } source && DesktopSettings.SameOrigin(_endpoint, source)) _browser.Core.Reload();
            else _browser.Core.Navigate(_initialAddress);
        }
        catch (Exception error) { _needsRestart = true; DesktopLog.Write(error); ShowError("页面暂时无法打开", "点击“重新连接”可重新打开工作台，您的登录资料会保留。"); }
    }
    private async Task NavigationDeadline(CancellationToken token)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(35), token); if (!_disposed && !_navigated) { _browser.Core?.Stop(); ShowError("连接时间有些长", "网络可能较弱。请检查网络后重试，或稍后再打开工作台。"); } }
        catch (OperationCanceledException) { }
    }
    private void ShowPage() { _error.IsVisible = false; _browser.IsVisible = true; _browser.SetPageVisible(IsVisible); }
    private void ShowError(string title, string note)
    {
        if (WindowState == WindowState.FullScreen) { WindowState = _beforeFullscreen; _toolbar.IsVisible = true; }
        _progress.IsVisible = false; _browser.SetPageVisible(false); _browser.IsVisible = false;
        _errorTitle.Text = title; _errorNote.Text = note; _error.IsVisible = true; _retry.IsVisible = true;
        SetStatus("等待重新连接");
    }
    private async void DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs args)
    {
        _pickingFile = true; _updateDownload?.Cancel();
        var deferral = args.GetDeferral(); args.Handled = true;
        try
        {
            var name = Path.GetFileName(args.ResultFilePath);
            var result = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions { Title = "保存文件", SuggestedFileName = name, ShowOverwritePrompt = true });
            var path = result?.TryGetLocalPath();
            if (string.IsNullOrWhiteSpace(path) || _disposed) { args.Cancel = true; return; }
            args.ResultFilePath = path; SetStatus("正在保存文件…");
            var download = args.DownloadOperation;
            _pageDownloads.Add(download);
            download.StateChanged += (_, _) =>
            {
                if (_disposed) return;
                if (download.State is CoreWebView2DownloadState.Completed or CoreWebView2DownloadState.Interrupted) _pageDownloads.Remove(download);
                SetStatus(download.State == CoreWebView2DownloadState.Completed ? "文件已保存：" + Path.GetFileName(path)
                    : download.State == CoreWebView2DownloadState.Interrupted ? "文件未保存完成，请重试" : "正在保存文件…");
            };
        }
        catch (Exception error) { args.Cancel = true; DesktopLog.Write(error); SetStatus("文件未保存，请重试"); }
        finally
        {
            _pickingFile = false;
            // Dispose completes the event. Calling Complete as well completes it twice.
            try { deferral.Dispose(); }
            catch (Exception error) { DesktopLog.Write(error); if (!_disposed) SetStatus("文件未保存完成，请重试"); }
        }
    }
    private static void OpenExternal(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || !string.IsNullOrEmpty(uri.UserInfo)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { DesktopLog.Write(error); }
    }
    private async Task ShowAbout()
    {
        _app.Diagnostics.Record("action", "关于", _browser.Core?.Source ?? _endpoint);
        var window = Dialogs.Window("关于 ICeClass 班伴 · 教师端", 740);
        window.Height = 660; window.SizeToContent = SizeToContent.Manual; window.CanResize = true;
        window.MinWidth = 600; window.MinHeight = 500;
        DesktopStyle.KeepWindowInWorkingArea(window);
        window.Content = AboutContent.Build("教师端", DesktopUpdates.CurrentVersion,
            "查看晨读统计、发送班级通知、收听教室来音，也可以向班班提问。",
            "网页功能随学校平台更新。桌面程序可在这里检查更新。", () => window.Close(),
            async () => { window.Close(); await CheckUpdatesAsync(); });
        await window.ShowDialog(this);
    }
    internal async Task CheckUpdatesAsync() => await CheckUpdatesCoreAsync(checkOnly: false);

    private async Task<TeacherActionResult> CheckUpdatesCoreAsync(bool checkOnly)
    {
        if (_checkingUpdate) return TeacherActionResult.Refused("update-busy", "已有更新检查正在进行，请查看教师端状态。");
        _checkingUpdate = true;
        try
        {
            CancelBackgroundUpdate();
            if (_backgroundUpdateTask is { } background)
            { try { await background; } catch (OperationCanceledException) { } }
            _readyUpdate = await DesktopUpdates.PendingAsync(_lifetime.Token);
            _app.SetUpdateReady(_readyUpdate is not null);
            if (_readyUpdate is not null)
            {
                if (checkOnly) return new(true, true, "桌面更新已就绪，将由老师选择何时安装；本次仅检查。", "checked", UpdateAvailable: true, Version: _readyUpdate.Version);
                if (!await Dialogs.Confirm(this, "桌面更新已就绪 " + _readyUpdate.Version,
                    "下次启动会安装更新。现在更新会重新打开工作台，学校平台与登录资料会保留。请先保存尚未提交的内容。", "立即更新"))
                    return new(false, true, "已取消立即更新。", "cancelled");
                await DesktopUpdates.RunGuardedAsync(_ => Task.FromResult(true), () => UpdateBusy(false), ReadUpdateActivityAsync, _lifetime.Token);
                _app.Restart(); return new(true, false, "已开始重新打开工作台。", "started");
            }
            SetStatus("正在检查桌面更新…");
            var update = _offeredUpdate = await DesktopUpdates.CheckPlanFirstAsync(_endpoint, _lifetime.Token);
            if (update is null) { SetStatus("暂未发现可用的桌面更新"); return new(true, true, "暂未发现可用的桌面更新。", "checked", UpdateAvailable: false); }
            if (checkOnly) { SetStatus("发现桌面更新 " + update.Version); return new(true, true, "发现桌面更新，本次仅检查，尚未下载或安装。", "checked", UpdateAvailable: true, Version: update.Version); }
            if (!await Dialogs.Confirm(this, "发现桌面更新 " + update.Version,
                "下载完成后，下次启动时安装。上课或正在使用语音等功能时暂停下载。", "下载")) return new(false, true, "已取消下载更新。", "cancelled");
            await PrepareUpdateAsync(update, automatic: false);
            return new(true, true, "桌面更新已下载，将在下次启动时安装。", "prepared");
        }
        catch (OperationCanceledException error)
        {
            if (!_disposed) SetStatus(error is DesktopUpdatePausedException ? error.Message : "桌面更新已暂停，课间空闲时可继续");
            return TeacherActionResult.Refused("update-paused", "更新检查已暂停，未确认可用更新。");
        }
        catch (Exception error)
        {
            DesktopLog.Write(error); SetStatus("暂时无法更新，您仍可继续使用工作台");
            if (!checkOnly) await Dialogs.Message(this, "桌面更新未完成", "请检查网络后重试。当前程序与登录资料保持，网页功能会随学校平台更新。");
            return TeacherActionResult.Refused("update-failed", "暂时无法检查桌面更新，请检查学校平台连接。");
        }
        finally { _checkingUpdate = false; }
    }

    internal void CancelBackgroundUpdate() { if (_automaticDownload) _updateDownload?.Cancel(); }
    private bool UpdateBusy(bool automatic) => _disposed || !_navigated || _recordingFrames.Count > 0 || _pickingFile
        || _openingFeedback || _pageDownloads.Count > 0 || _browser.Core?.IsDocumentPlayingAudio == true || _app.UpdateBusy(automatic);

    private async Task<DesktopUpdateActivity> ReadUpdateActivityAsync(CancellationToken token)
    {
        var session = await ReadSessionAsync();
        var activity = await DesktopUpdates.ReadActivityAsync(_endpoint, session, token);
        return session == await ReadSessionAsync() ? activity : new(false, true, TimeSpan.Zero);
    }

    private async Task PrepareUpdateAsync(DesktopUpdate update, bool automatic)
    {
        using var download = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _updateDownload = download; _automaticDownload = automatic;
        try
        {
            _readyUpdate = await DesktopUpdates.RunGuardedAsync(token => DesktopUpdates.PrepareAsync(_endpoint, update,
                new Progress<int>(p => { if (!_disposed) SetStatus($"正在下载桌面更新 {p}%"); }), token),
                () => UpdateBusy(automatic), ReadUpdateActivityAsync, download.Token);
            _app.SetUpdateReady(true);
            SetStatus("桌面更新已下载，下次启动时安装；也可从托盘选择“立即更新”");
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // A release can retire its payload hashes. Recheck the offer next
            // time while keeping the staged bytes for an unchanged plan.
            _offeredUpdate = null;
            throw;
        }
        finally { _updateDownload = null; _automaticDownload = false; }
    }

    private async Task WatchDesktopUpdatesAsync(CancellationToken token)
    {
        try
        {
            try { _readyUpdate = await DesktopUpdates.PendingAsync(token); _app.SetUpdateReady(_readyUpdate is not null); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
            { DesktopLog.Write(error); }
            var lastCheck = DateTimeOffset.MinValue;
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
            do
            {
                try
                {
                    if (_checkingUpdate || _readyUpdate is not null || UpdateBusy(true)) continue;
                    if (_offeredUpdate is null && DateTimeOffset.UtcNow - lastCheck < TimeSpan.FromMinutes(30)) continue;
                    if (DateTimeOffset.UtcNow - lastCheck >= TimeSpan.FromMinutes(30))
                    {
                        lastCheck = DateTimeOffset.UtcNow;
                        _offeredUpdate = await DesktopUpdates.CheckPlanFirstAsync(_endpoint, token);
                    }
                    if (_offeredUpdate is null || _checkingUpdate || UpdateBusy(true)) continue;
                    _backgroundUpdateTask = PrepareUpdateAsync(_offeredUpdate, automatic: true);
                    await _backgroundUpdateTask;
                }
                catch (OperationCanceledException error)
                { if (!_disposed) SetStatus(error is DesktopUpdatePausedException ? error.Message : "桌面更新已暂停，课间空闲时可继续"); }
                catch (Exception error) { lastCheck = DateTimeOffset.MinValue; if (!_disposed) DesktopLog.Write(error); }
                finally { _backgroundUpdateTask = null; }
            }
            while (await timer.WaitForNextTickAsync(token));
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!_disposed) DesktopLog.Write(error); }
    }

    private bool ReadUpdateWork(string message)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(message);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "iceclass-update-work") return false;
            if (!Guid.TryParse(root.GetProperty("id").GetString(), out var frame)) return false;
            if (root.GetProperty("busy").GetBoolean()) { _recordingFrames.Add(frame); _updateDownload?.Cancel(); }
            else _recordingFrames.Remove(frame);
            return true;
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or InvalidOperationException or KeyNotFoundException) { return false; }
    }

    private const string UpdateWorkScript = """
(() => {
  const tracks = new Set(), recorders = new Set(), pending = new Set();
  const id = crypto.randomUUID();
  let previous;
  const emit = busy => {
    if (busy === previous) return;
    previous = busy;
    window.chrome.webview.postMessage({type: "iceclass-update-work", id, busy});
  };
  const report = () => emit(tracks.size + recorders.size + pending.size > 0 ||
    [...document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden])')].some(dialog => dialog.getClientRects().length > 0));
  new MutationObserver(report).observe(document, {subtree: true, childList: true, attributes: true,
    attributeFilter: ["open", "hidden", "class", "style", "role"]});
  window.addEventListener("pagehide", () => emit(false), {once: true});
  const devices = navigator.mediaDevices;
  if (devices?.getUserMedia) {
    const original = devices.getUserMedia;
    devices.getUserMedia = async function(...args) {
      const request = {}; pending.add(request); report();
      try {
        const stream = await original.apply(this, args);
        for (const track of stream.getTracks()) {
          tracks.add(track);
          const clear = () => { tracks.delete(track); report(); };
          track.addEventListener("ended", clear, {once: true});
          const stop = track.stop;
          track.stop = function() { try { return stop.call(this); } finally { clear(); } };
        }
        return stream;
      } finally { pending.delete(request); report(); }
    };
  }
  if (typeof MediaRecorder !== "undefined") {
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function(...args) {
      const clear = () => { recorders.delete(this); report(); };
      this.addEventListener("stop", clear, {once: true});
      this.addEventListener("error", clear, {once: true});
      recorders.add(this); report();
      try { return start.apply(this, args); } catch (error) { clear(); throw error; }
    };
  }
})();
""";
    internal void DisposePage()
    {
        if (_disposed) return; _disposed = true; _teacherDocumentActive = false; _teacherActions.InvalidateDocument(closed: true);
        _lifetime.Cancel(); _navigationTimeout?.Cancel(); _navigationTimeout?.Dispose();
        _feedbackWindow?.CloseWithOwner(); _voiceNotice?.Close(); _voiceInbox?.Dispose();
        foreach (var child in _children.ToArray()) child.Close(); _browser.DisposeBrowser();
    }
}

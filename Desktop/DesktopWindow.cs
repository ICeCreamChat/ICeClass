using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using ICeClass.Receiver;
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
    private readonly ProgressBar _progress = new() { IsIndeterminate = true, Height = 2, IsVisible = true };
    private readonly Border _toolbar;
    private readonly List<DesktopWindow> _children = [];
    private bool _initialized, _disposed, _checkingUpdate, _navigated, _needsRestart;
    private WindowState _beforeFullscreen;
    private CancellationTokenSource? _navigationTimeout;
    private ClassroomVoiceInbox? _voiceInbox;
    private ClassroomVoiceNoticeWindow? _voiceNotice;

    internal DesktopWindow(App app, string endpoint, bool main, string? address = null)
    {
        _app = app; _endpoint = endpoint; _main = main; _initialAddress = address ?? endpoint + "/";
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
        var brand = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center,
            Children = { DesktopStyle.Logo(20), DesktopStyle.Text("ICeClass 班伴", 13, true) } };
        var refresh = ToolbarButton("刷新页面"); refresh.Click += async (_, _) =>
        {
            if (await Dialogs.Confirm(this, "刷新工作台？", "页面会重新加载。请先保存尚未提交的内容。", "刷新")) Navigate();
        };
        var settings = ToolbarButton("桌面设置"); settings.Click += async (_, _) => await _app.ShowSettingsAsync();
        var more = ToolbarButton("关于"); more.Click += async (_, _) => await ShowAbout();
        _browser.FocusOutside += forward => (forward ? refresh : more).Focus();
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { refresh, settings, more } };
        var toolbar = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,18,*,16,Auto"), Margin = new Thickness(16, 5) };
        toolbar.Children.Add(brand); Grid.SetColumn(_status, 2); _status.VerticalAlignment = VerticalAlignment.Center; _status.TextTrimming = TextTrimming.CharacterEllipsis; toolbar.Children.Add(_status);
        ToolTip.SetTip(_status, _endpoint);
        Grid.SetColumn(actions, 4); toolbar.Children.Add(actions);
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
            core.Settings.IsWebMessageEnabled = false; core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = Program.Options.Review;
            core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.NavigationStarting += (_, args) =>
            {
                if (!DesktopSettings.SameOrigin(_endpoint, args.Uri))
                { args.Cancel = true; if (args.IsUserInitiated) OpenExternal(args.Uri); return; }
                _navigated = false; _progress.IsVisible = true; SetStatus("正在连接…");
                _navigationTimeout?.Cancel(); _navigationTimeout?.Dispose(); _navigationTimeout = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
                _ = NavigationDeadline(_navigationTimeout.Token);
            };
            core.NavigationCompleted += (_, args) =>
            {
                _navigationTimeout?.Cancel(); _progress.IsVisible = false;
                if (_disposed) return;
                if (args.IsSuccess && args.HttpStatusCode < 500)
                { _navigated = true; ShowPage(); SetStatus(ConnectedStatus); }
                else ShowError("暂时无法打开学校平台", "请检查网络或稍后重试。您的登录资料和学校数据不会因此被清除。");
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
            core.ProcessFailed += (_, _) => { _needsRestart = true; ShowError("页面暂时中断", "点击“重新连接”会重新打开工作台。尚未提交的内容可能需要重新填写。"); };
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
                _voiceInbox = new ClassroomVoiceInbox(_endpoint, ReadVoiceSessionAsync);
                _voiceInbox.Changed += UpdateVoiceNotice;
                _ = WatchClassroomVoiceAsync(_lifetime.Token);
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

    private async Task<string?> ReadVoiceSessionAsync()
    {
        if (_disposed || _browser.Core is null) return null;
        var cookies = await _browser.Core.CookieManager.GetCookiesAsync(_endpoint + "/api/classroom-voice");
        return _disposed ? null : cookies.FirstOrDefault(cookie => cookie.Name == "iceclass_session")?.Value;
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
        var deferral = args.GetDeferral(); args.Handled = true;
        try
        {
            var name = Path.GetFileName(args.ResultFilePath);
            var result = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions { Title = "保存文件", SuggestedFileName = name, ShowOverwritePrompt = true });
            var path = result?.TryGetLocalPath();
            if (string.IsNullOrWhiteSpace(path) || _disposed) { args.Cancel = true; return; }
            args.ResultFilePath = path; SetStatus("正在保存文件…");
            var download = args.DownloadOperation;
            download.StateChanged += (_, _) =>
            {
                if (_disposed) return;
                SetStatus(download.State == CoreWebView2DownloadState.Completed ? "文件已保存：" + Path.GetFileName(path)
                    : download.State == CoreWebView2DownloadState.Interrupted ? "文件未保存完成，请重试" : "正在保存文件…");
            };
        }
        catch (Exception error) { args.Cancel = true; DesktopLog.Write(error); SetStatus("文件未保存，请重试"); }
        finally
        {
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
    internal async Task CheckUpdatesAsync()
    {
        if (_checkingUpdate) return; _checkingUpdate = true;
        try
        {
            SetStatus("正在检查桌面更新…");
            var update = await DesktopUpdates.CheckAsync(_endpoint, _lifetime.Token);
            if (update is null) { SetStatus("暂未发现可用的桌面更新"); return; }
            if (!await Dialogs.Confirm(this, "发现桌面更新 " + update.Version, "更新后会重新打开工作台，登录资料会保留。请先保存尚未提交的内容。", "下载并更新")) return;
            var path = await DesktopUpdates.DownloadAsync(_endpoint, update, new Progress<int>(p => SetStatus($"正在下载桌面更新 {p}%")), _lifetime.Token);
            DesktopUpdates.Install(path, update); _app.Exit();
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { DesktopLog.Write(error); SetStatus("暂时无法更新，您仍可继续使用工作台"); await Dialogs.Message(this, "桌面更新未完成", "请检查网络后重试。当前程序与登录资料保持，网页功能会随学校平台更新。"); }
        finally { _checkingUpdate = false; }
    }
    internal void DisposePage()
    {
        if (_disposed) return; _disposed = true; _lifetime.Cancel(); _navigationTimeout?.Cancel(); _navigationTimeout?.Dispose();
        _voiceNotice?.Close(); _voiceInbox?.Dispose();
        foreach (var child in _children.ToArray()) child.Close(); _browser.DisposeBrowser();
    }
}

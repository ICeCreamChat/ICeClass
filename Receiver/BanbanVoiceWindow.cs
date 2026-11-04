using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ICeClass.Receiver;

/// <summary>A classroom-bound teacher session; hiding the window keeps wake listening alive.</summary>
internal sealed class BanbanVoiceWindow : Window
{
    private readonly ReceiverConfig _binding;
    private readonly Uri _origin;
    private ReadingBrowser _browser = CreateBrowser();
    private readonly BanbanVoiceService _voice;
    private readonly BanbanPetWindow _pet;
    private readonly Action _stopComputer;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBlock _status = ClassroomStyle.Text("正在关联班主任账号…", 16, muted: true);
    private readonly Border _notice;
    private readonly Button _retry = ClassroomStyle.Button("重新连接", true);
    private readonly DispatcherTimer _connectionTimeout = new() { Interval = TimeSpan.FromSeconds(30) };
    private bool _canClose, _started, _pageReady, _authorized, _suspended, _pendingConversation, _connectionFailed, _browserFailed;
    internal event Action<string>? VoiceStatusChanged;

    internal BanbanVoiceWindow(ReceiverConfig binding, Action stopComputer, bool? enabled = null, string? petPreferencePath = null)
    {
        // The receiver updates its configuration object in place on re-binding.
        // Keep an immutable identity snapshot. The device token stays in native
        // memory and is only attached to this origin's API requests, never JS.
        _binding = new ReceiverConfig { Endpoint = binding.Endpoint, DeviceId = binding.DeviceId, DeviceToken = binding.DeviceToken,
            ClassId = binding.ClassId, ClassName = binding.ClassName };
        _stopComputer = stopComputer;
        _origin = new Uri(binding.Endpoint.TrimEnd('/') + "/");
        _voice = new BanbanVoiceService(enabled ?? BanbanVoicePreferences.Load());
        _pet = new BanbanPetWindow(BringForward, StartConversation, () => _voice.CancelTask(), SetVoiceEnabled, petPreferencePath)
            { SpeechOpening = () => _voice.SpeechMouthOpening };
        SystemEvents.SessionSwitch += SessionSwitch;
        SystemEvents.PowerModeChanged += PowerChanged;
        ClassroomStyle.Apply(this);
        Title = "班班 · 语音助手"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 540; Height = 780; MinWidth = 380; MinHeight = 500;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        DesktopStyle.KeepWindowInWorkingArea(this);
        _retry.IsEnabled = false;
        _retry.Click += async (_, _) =>
        {
            _retry.IsEnabled = false;
            try
            {
                if (!_started) await StartAsync();
                else if (_browser.Core is { } core) { BeginConnection(); core.Navigate(_origin.AbsoluteUri); }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                AppLog.Error("Reconnect Banban voice window failed", error);
                FailConnection("班班窗口无法重新连接，请重试。", recreateBrowser: true);
            }
        };
        var message = new StackPanel { Spacing = 18, MaxWidth = 380, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, Children = { DesktopStyle.Logo(64), _status, _retry } };
        _notice = new Border { Background = DesktopStyle.Brush("#F5F8FC"), Padding = new Avalonia.Thickness(24), Child = message };
        Content = new Grid { Children = { _browser, _notice } };
        _connectionTimeout.Tick += (_, _) =>
        {
            AppLog.Info($"Banban voice startup timed out: pageReady={_pageReady}; authorized={_authorized}");
            FailConnection(_pageReady ? "班主任账号关联超时，请检查网络后重新连接。" : "班班页面未能完成初始化，请重新连接。");
        };
        _voice.Changed += e => Dispatcher.UIThread.Post(() =>
        {
            if (_canClose) return;
            _pet.Present(e);
            if (e.Kind == "cancel") _stopComputer();
            if (e.Kind == "leave") Hide();
            if (e.Kind == "state") VoiceStatusChanged?.Invoke(e.Text);
            Send(new { type = "banban-voice", kind = e.Kind, text = e.Text, state = e.State, enabled = e.Enabled, level = e.Level, conversation = e.Conversation });
        });
        Closing += (_, e) =>
        {
            if (_canClose || e.CloseReason is WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown) return;
            e.Cancel = true; Hide();
        };
        Closed += (_, _) => { _connectionTimeout.Stop(); _pet.Shutdown(); SystemEvents.SessionSwitch -= SessionSwitch; SystemEvents.PowerModeChanged -= PowerChanged; _lifetime.Cancel(); _voice.Dispose(); _browser.DisposeBrowser(); _lifetime.Dispose(); };
    }

    // Native HWNDs draw above Avalonia siblings. Keep the host itself hidden
    // until the page authorizes; a notice layered over a visible host is obscured.
    private static ReadingBrowser CreateBrowser() => new() { HandleEscapeKey = false, HandleFullscreenKey = false, IsVisible = false };

    private void ShowNotice(string message)
    {
        _browser.IsVisible = false;
        _status.Text = message; _notice.IsVisible = true;
    }

    private void BeginConnection()
    {
        _connectionFailed = _pageReady = _authorized = false;
        _voice.SetReady(false); _stopComputer(); _retry.IsEnabled = false;
        ShowNotice("正在关联班主任账号…");
        _connectionTimeout.Stop(); _connectionTimeout.Start();
    }

    private void FailConnection(string message, bool recreateBrowser = false)
    {
        if (_canClose) return;
        _connectionTimeout.Stop();
        _browserFailed |= recreateBrowser;
        if (_browserFailed) { _started = false; _browser.DisposeBrowser(); }
        _pageReady = _authorized = false; _voice.SetReady(false); _stopComputer();
        ShowNotice(message); _retry.IsEnabled = true;
        ReportCallFailure();
    }

    internal bool Matches(ReceiverConfig binding) => _binding.Endpoint == binding.Endpoint && _binding.DeviceId == binding.DeviceId
        && _binding.DeviceToken == binding.DeviceToken && _binding.ClassId == binding.ClassId && _binding.ClassName == binding.ClassName;

    internal void CancelCurrentTask() => _voice.CancelTask();

    internal async Task StartAsync(bool background = false)
    {
        if (_canClose) return;
        if (_started) { if (!background) BringForward(); return; }
        if (_browserFailed)
        {
            _browser.DisposeBrowser();
            var surface = (Grid)Content!; surface.Children.Remove(_browser);
            _browser = CreateBrowser(); surface.Children.Insert(0, _browser); _browserFailed = false;
        }
        _started = true;
        _pet.ShowPet(false);
        ShowNotice("正在关联班主任账号…"); _retry.IsEnabled = false;
        var browser = _browser;
        bool Current() => !_canClose && ReferenceEquals(browser, _browser) && !_browserFailed;
        using var initialize = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        initialize.CancelAfter(TimeSpan.FromSeconds(30));
        var stage = "native host attachment";
        try
        {
            if (background)
            {
                // Attach the native browser without showing a top-level window.
                // Opacity only hides the client area; Windows can still draw its title bar.
                EnsureInitialized(); ApplyStyling(); ApplyTemplate();
                Presenter!.UpdateChild();
            }
            else Show();
            stage = "WebView2 initialization";
            var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_origin.AbsoluteUri + "|" + _binding.DeviceId + "|" + _binding.ClassId)))[..20];
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "BanbanVoice", identity);
            Directory.CreateDirectory(profile);
            await browser.InitializeAsync(profile, initialize.Token).WaitAsync(initialize.Token);
            if (!Current()) return;
            var core = browser.Core!;
            AppLog.Info($"Banban voice WebView2 {core.Environment.BrowserVersionString}; scaling={RenderScaling}");
            stage = "WebView2 configuration";
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document);
            core.WebResourceRequested += (_, e) =>
            {
                if (!Current() || !Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var address)
                    || address.Scheme != _origin.Scheme || address.Authority != _origin.Authority
                    || !address.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)) return;
                e.Request.Headers.SetHeader("Authorization", "Bearer " + _binding.DeviceToken);
                e.Request.Headers.SetHeader("X-ICeClass-Device", _binding.DeviceId);
                e.Request.Headers.SetHeader("X-ICeClass-Class", _binding.ClassId);
                e.Request.Headers.RemoveHeader("Cookie");
            };
            core.NavigationStarting += (_, e) =>
            {
                if (!Current()) { e.Cancel = true; return; }
                if (!Allowed(e.Uri)) { e.Cancel = true; return; }
                BeginConnection();
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += (_, e) =>
            {
                if (!Current() || !Allowed(e.Source)) return;
                try { Receive(e.WebMessageAsJson); }
                catch (JsonException) { }
                catch (InvalidOperationException error) { AppLog.Error("Banban voice bridge failed", error); }
            };
            core.NavigationCompleted += (_, e) =>
            {
                if (!Current()) return;
                AppLog.Info($"Banban voice navigation: success={e.IsSuccess}; status={e.WebErrorStatus}; pageReady={_pageReady}; authorized={_authorized}");
                if (!e.IsSuccess) FailConnection("班班暂时连不上，请检查网络后重新连接。");
            };
            core.ProcessFailed += (_, e) =>
            {
                if (!Current()) return;
                AppLog.Info($"Banban voice process failed: {e.ProcessFailedKind}");
                FailConnection("班班窗口已中断，请重新连接。", recreateBrowser: true);
            };
            stage = "voice bridge injection";
            await core.AddScriptToExecuteOnDocumentCreatedAsync("Object.defineProperty(window, 'ICeClassVoiceHost', {value:Object.freeze({version:1,classroomAccount:true}),writable:false});document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('bb-native-voice-page'),{once:true});").WaitAsync(initialize.Token);
            if (!Current()) return;
            BeginConnection();
            core.Navigate(_origin.AbsoluteUri);
        }
        catch (Exception error)
        {
            if (!Current()) return;
            browser.DisposeBrowser();
            if (_lifetime.IsCancellationRequested) return;
            AppLog.Error($"Open Banban voice window failed during {stage}; HRESULT=0x{error.HResult:X8}", error);
            FailConnection(error is OperationCanceledException ? "班班窗口初始化超时，请重新连接。"
                : "班班窗口无法打开，请检查 WebView2 运行组件后重试。", recreateBrowser: true);
        }
    }

    private bool Allowed(string address) => Uri.TryCreate(address, UriKind.Absolute, out var uri)
        && uri.Scheme == _origin.Scheme && uri.Authority == _origin.Authority && uri.AbsolutePath is "/" or "/index.html";

    private void Receive(string json)
    {
        if (json.Length > 16000) return;
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (!root.TryGetProperty("type", out var type) || type.GetString() != "banban-voice") return;
        var kind = root.TryGetProperty("kind", out var value) ? value.GetString() : "";
        if (kind == "ready")
        {
            _pageReady = true;
            Send(new { type = "banban-voice", kind = "binding", classId = _binding.ClassId, className = _binding.ClassName, deviceId = _binding.DeviceId });
            return;
        }
        if (kind == "authorized")
        {
            _authorized = _pageReady && root.TryGetProperty("value", out var ready) && ready.ValueKind == JsonValueKind.True;
            if (_authorized)
            {
                _connectionFailed = false; _connectionTimeout.Stop();
                _notice.IsVisible = false; _browser.IsVisible = true;
            }
            else
            {
                ShowNotice("班级关联已变化，请重新连接班班。");
                _retry.IsEnabled = true; _connectionTimeout.Start();
            }
            _voice.SetReady(!_suspended && _authorized);
            // Chat can mount before its class list arrives; the page rechecks
            // authorization once that request completes. Keep the call queued.
            if (_pendingConversation && _authorized) StartConversation();
            return;
        }
        if (kind == "identity-error")
        {
            var message = root.TryGetProperty("text", out var error) && error.ValueKind == JsonValueKind.String
                ? error.GetString() : null;
            FailConnection(string.IsNullOrWhiteSpace(message) ? "班主任账号暂时无法关联，请重新连接。" : message[..Math.Min(message.Length, 300)]);
            return;
        }
        if (kind == "logout") { _pendingConversation = false; _pet.SetPreparing(false); BeginConnection(); return; }
        if (kind == "hide") { Hide(); return; }
        if (kind == "enabled")
        {
            var enabled = root.TryGetProperty("value", out var state) && state.ValueKind == JsonValueKind.True;
            SetVoiceEnabled(enabled); return;
        }
        if (!_pageReady || !_authorized || _suspended) return;
        var text = root.TryGetProperty("text", out var content) && content.ValueKind == JsonValueKind.String ? content.GetString() ?? "" : "";
        switch (kind)
        {
            case "speak": _voice.Speak(text); break;
            case "speech-segment":
                if (root.TryGetProperty("turnId", out var turn) && turn.ValueKind == JsonValueKind.String
                    && root.TryGetProperty("sequence", out var sequence) && sequence.TryGetInt32(out var index) && index >= 0
                    && root.TryGetProperty("end", out var end) && end.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    _voice.SpeechSegment(turn.GetString()!, index, text, end.GetBoolean());
                break;
            case "stop-speech": _voice.StopSpeaking(); break;
            case "standby": _voice.Standby(); break;
            case "leave":
                if (root.TryGetProperty("conversation", out var conversation) && conversation.TryGetInt64(out var generation))
                    _voice.Leave(generation);
                break;
            case "work": _voice.SetWorkState(text); break;
            case "task-result":
                if (text is "succeeded" or "failed" or "cancelled") _pet.Present(new("task-result", State: text));
                break;
        }
    }
    private void Send(object message)
    {
        if (_canClose || _browserFailed) return;
        if (_browser.Core is not null && Allowed(_browser.Core.Source)) _browser.Core.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }
    private void SessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionLogoff) Suspend(true);
        else if (e.Reason is SessionSwitchReason.SessionUnlock or SessionSwitchReason.SessionLogon) Suspend(false);
    }
    private void PowerChanged(object sender, PowerModeChangedEventArgs e)
    {
        if (e.Mode == PowerModes.Suspend) Suspend(true);
        else if (e.Mode == PowerModes.Resume) Suspend(false);
    }
    private void Suspend(bool value) => Dispatcher.UIThread.Post(() =>
    {
        if (_canClose) return;
        _suspended = value;
        if (value) _pendingConversation = false;
        _pet.Suspend(value);
        _voice.SetReady(!value && _pageReady && _authorized);
        if (value) { _stopComputer(); Send(new { type = "banban-voice", kind = "suspended" }); }
    });
    private void SetVoiceEnabled(bool enabled)
    {
        if (!enabled) { _pendingConversation = false; _pet.SetPreparing(false); }
        BanbanVoicePreferences.Save(enabled); _voice.SetEnabled(enabled);
    }
    internal void StartConversation()
    {
        if (_suspended || _canClose) return;
        _pet.ShowPet(true);
        Hide();
        if (!_pageReady || !_authorized)
        {
            if (_connectionFailed) { BringForward(); return; }
            _pendingConversation = true;
            _pet.SetPreparing(true);
            return;
        }
        _pendingConversation = false;
        _pet.SetPreparing(true);
        if (!_voice.Enabled) SetVoiceEnabled(true);
        _voice.StartConversation();
    }
    private void ReportCallFailure()
    {
        _connectionFailed = true;
        _pet.SetPreparing(false);
        if (!_pendingConversation) return;
        _pendingConversation = false;
        BringForward();
    }
    internal bool CompanionVisible => _pet.IsVisible;
    internal bool IsBusy => _voice.Busy;
    internal void SetInClass(bool value) => _pet.SetInClass(value);
    internal void ShowPet() => _pet.ShowPet(true);
    internal void BringForward() { Show(); WindowState = WindowState.Normal; Activate(); _browser.FocusPage(); }
    internal void Shutdown() { if (_canClose) return; _canClose = true; _pet.Shutdown(); _stopComputer(); _voice.Dispose(); Close(); }
}

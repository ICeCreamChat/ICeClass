using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ICeClass.Receiver;

/// <summary>A persistent authenticated teacher session; hiding the window keeps wake listening alive.</summary>
internal sealed class BanbanVoiceWindow : Window
{
    private readonly ReceiverConfig _binding;
    private readonly Uri _origin;
    private readonly ReadingBrowser _browser = new() { HandleEscapeKey = false, HandleFullscreenKey = false };
    private readonly BanbanVoiceService _voice;
    private readonly BanbanPetWindow _pet;
    private readonly Action _stopComputer;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly TextBlock _status = ClassroomStyle.Text("正在打开班班…", 16, muted: true);
    private readonly Border _notice;
    private bool _canClose, _started, _background, _pageReady, _authorized, _suspended;
    internal event Action<string>? VoiceStatusChanged;

    internal BanbanVoiceWindow(ReceiverConfig binding, Action stopComputer, bool? enabled = null, string? petPreferencePath = null)
    {
        // The receiver updates its configuration object in place on re-binding.
        // Keep an immutable identity snapshot, without retaining the device token.
        _binding = new ReceiverConfig { Endpoint = binding.Endpoint, DeviceId = binding.DeviceId, ClassId = binding.ClassId, ClassName = binding.ClassName };
        _stopComputer = stopComputer;
        _origin = new Uri(binding.Endpoint.TrimEnd('/') + "/");
        _voice = new BanbanVoiceService(enabled ?? BanbanVoicePreferences.Load());
        _pet = new BanbanPetWindow(BringForward, StartConversation, () => _voice.CancelTask(), SetVoiceEnabled, petPreferencePath);
        SystemEvents.SessionSwitch += SessionSwitch;
        SystemEvents.PowerModeChanged += PowerChanged;
        ClassroomStyle.Apply(this);
        Title = "班班 · 语音助手"; Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 540; Height = 780; MinWidth = 380; MinHeight = 500;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        DesktopStyle.KeepWindowInWorkingArea(this);
        var retry = ClassroomStyle.Button("重新连接", true);
        retry.Click += async (_, _) =>
        {
            retry.IsEnabled = false;
            try { if (_browser.Core is not null) _browser.Core.Navigate(_origin.AbsoluteUri); else if (!_started) await StartAsync(); }
            finally { retry.IsEnabled = true; }
        };
        var message = new StackPanel { Spacing = 18, MaxWidth = 380, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, Children = { DesktopStyle.Logo(64), _status, retry } };
        _notice = new Border { Background = DesktopStyle.Brush("#F5F8FC"), Padding = new Avalonia.Thickness(24), Child = message };
        Content = new Grid { Children = { _browser, _notice } };
        _voice.Changed += e => Dispatcher.UIThread.Post(() =>
        {
            if (_canClose) return;
            _pet.Present(e);
            if (e.Kind == "cancel") _stopComputer();
            if (e.Kind == "state") VoiceStatusChanged?.Invoke(e.Text);
            Send(new { type = "banban-voice", kind = e.Kind, text = e.Text, state = e.State, enabled = e.Enabled, level = e.Level });
        });
        Closing += (_, e) =>
        {
            if (_canClose || e.CloseReason is WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown) return;
            e.Cancel = true; Hide();
        };
        Closed += (_, _) => { _pet.Shutdown(); SystemEvents.SessionSwitch -= SessionSwitch; SystemEvents.PowerModeChanged -= PowerChanged; _lifetime.Cancel(); _voice.Dispose(); _browser.DisposeBrowser(); _lifetime.Dispose(); };
    }

    internal bool Matches(ReceiverConfig binding) => _binding.Endpoint == binding.Endpoint && _binding.DeviceId == binding.DeviceId && _binding.ClassId == binding.ClassId;

    internal async Task StartAsync(bool background = false)
    {
        if (_started) { if (!background) BringForward(); return; }
        _started = true; _background = background;
        _pet.ShowPet(false);
        if (background) { Opacity = 0; ShowInTaskbar = false; ShowActivated = false; }
        Show();
        try
        {
            var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_origin.AbsoluteUri + "|" + _binding.DeviceId + "|" + _binding.ClassId)))[..20];
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "BanbanVoice", identity);
            Directory.CreateDirectory(profile);
            await _browser.InitializeAsync(profile, _lifetime.Token);
            var core = _browser.Core!;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.NavigationStarting += (_, e) =>
            {
                if (!Allowed(e.Uri)) { e.Cancel = true; return; }
                _pageReady = _authorized = false; _voice.SetReady(false); _stopComputer(); _notice.IsVisible = true;
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += (_, e) =>
            {
                if (!Allowed(e.Source)) return;
                try { Receive(e.WebMessageAsJson); }
                catch (JsonException) { }
                catch (InvalidOperationException error) { AppLog.Error("Banban voice bridge failed", error); }
            };
            core.NavigationCompleted += (_, e) =>
            {
                if (!e.IsSuccess) { _status.Text = "班班暂时连不上，请检查网络后重新连接。"; _notice.IsVisible = true; return; }
                _notice.IsVisible = false;
                if (_background) { Hide(); Opacity = 1; ShowInTaskbar = true; _background = false; }
            };
            core.ProcessFailed += (_, _) => { _pageReady = _authorized = false; _voice.SetReady(false); _stopComputer(); _notice.IsVisible = true; _status.Text = "班班窗口已中断，请重新连接。"; };
            await core.AddScriptToExecuteOnDocumentCreatedAsync("Object.defineProperty(window, 'ICeClassVoiceHost', {value:Object.freeze({version:1}),writable:false});document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('bb-native-voice-page'),{once:true});");
            core.Navigate(_origin.AbsoluteUri);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            _started = false;
            AppLog.Error("Open Banban voice window failed", error);
            _status.Text = "班班窗口无法打开，请检查 WebView2 运行组件后重试。";
            _notice.IsVisible = true; Opacity = 1; ShowInTaskbar = true;
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
            _voice.SetReady(!_suspended && _authorized); return;
        }
        if (kind == "logout") { _pageReady = _authorized = false; _voice.SetReady(false); _stopComputer(); return; }
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
            case "work": _voice.SetWorkState(text); break;
        }
    }
    private void Send(object message)
    {
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
        _pet.Suspend(value);
        _voice.SetReady(!value && _pageReady && _authorized);
        if (value) { _stopComputer(); Send(new { type = "banban-voice", kind = "suspended" }); }
    });
    private void SetVoiceEnabled(bool enabled) { BanbanVoicePreferences.Save(enabled); _voice.SetEnabled(enabled); }
    private void StartConversation()
    {
        if (_suspended || _canClose) return;
        if (!_pageReady || !_authorized) { BringForward(); return; }
        if (!_voice.Enabled) SetVoiceEnabled(true);
        _voice.StartConversation();
    }
    internal bool CompanionVisible => _pet.IsVisible;
    internal void SetInClass(bool value) => _pet.SetInClass(value);
    internal void ShowPet() => _pet.ShowPet(true);
    internal void BringForward() { _background = false; Opacity = 1; ShowInTaskbar = true; ShowActivated = true; Show(); WindowState = WindowState.Normal; Activate(); _browser.FocusPage(); }
    internal void Shutdown() { if (_canClose) return; _canClose = true; _pet.Shutdown(); _stopComputer(); _voice.Dispose(); Close(); }
}

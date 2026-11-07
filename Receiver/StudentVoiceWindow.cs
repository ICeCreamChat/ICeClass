using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;
using NAudio.Wave;

namespace ICeClass.Receiver;

/// <summary>The classroom home uses the approved local glass surface; native services own devices and credentials.</summary>
public sealed class StudentVoiceWindow : Window
{
    private const string Host = "classroom.iceclass.local";
    private const string Page = "https://" + Host + "/homework/classroom/index.html";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HttpClient Http = new(new HttpClientHandler {AllowAutoRedirect = false}) {Timeout = TimeSpan.FromSeconds(25)};
    private readonly ClassroomHomeApi _api = new(Http);
    private readonly Func<byte[], Task> _send;
    private readonly Func<Task>? _openReading;
    private readonly Action? _openSettings, _openAbout, _showIsland, _showBanban;
    private readonly Action<string>? _openIdeas;
    private readonly Action<long>? _acknowledge;
    private readonly ReceiverConfig _config;
    private readonly Grid _surface = new();
    private readonly Border _notice;
    private readonly TextBlock _message = ClassroomStyle.Caption("正在打开教室首页…");
    private readonly Button _retry = ClassroomStyle.Button("重新打开", true);
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource _pageLifetime = new();
    private ReadingBrowser _browser;
    private Task? _loadTask;
    private TaskCompletionSource<bool>? _ready, _leaveResponse;
    private Task<bool>? _leaveCheck;
    private Window? _closeDialog;
    private bool _initialized, _loaded, _failed, _closed, _homeworkBusy, _openManagement;
    private int _bindingVersion;
    private string _scope;
    private ReceiverConnectionState _connection = new(false, "正在连接…");
    private ClassroomHomeSnapshot? _islandState;
    private string? _islandJson;
    private readonly DispatcherTimer _timer;
    private readonly object _audioGate = new();
    private WaveInEvent? _waveIn;
    private WaveFileWriter? _writer;
    private MemoryStream? _buffer;
    private DateTimeOffset _startedAt;
    private bool _recording, _sending, _voiceSuccess;
    private string _voiceStatus = "", _duration = "最长 30 秒";
    internal bool IsBusy => _recording || _sending || _homeworkBusy;
    internal bool HasHomeworkActivity => _homeworkBusy;

    public StudentVoiceWindow(ReceiverConfig config, Func<byte[], Task> send, Func<Task>? openReading = null,
        Action? openSettings = null, Action? openAbout = null, Action? showIsland = null, Action? showBanban = null,
        Action<string>? openIdeas = null, Action<long>? acknowledge = null)
    {
        ClassroomStyle.Apply(this);
        _config = config; _scope = BindingScope(config); _send = send; _openReading = openReading;
        _openSettings = openSettings; _openAbout = openAbout; _showIsland = showIsland;
        _showBanban = showBanban; _openIdeas = openIdeas; _acknowledge = acknowledge;
        Title = $"ICeClass 班伴 · {config.ClassName}";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 1280; Height = 850; MinWidth = 720; MinHeight = 520;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        DesktopStyle.KeepWindowInWorkingArea(this);
        Background = DesktopStyle.Brush("#E5F0F8");
        _browser = CreateBrowser();
        _retry.IsVisible = false; _retry.Click += async (_, _) => await LoadAsync();
        _notice = new Border {Classes = {"classroom-glass"}, CornerRadius = new CornerRadius(24), Background = Avalonia.Media.Brushes.Transparent,
            Padding = new Thickness(28), Child = new StackPanel {
            Spacing = 18, MaxWidth = 560, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Children = {DesktopStyle.Logo(64), ClassroomStyle.Title("ICeClass 班伴"), _message, _retry}}};
        _surface.Children.Add(_browser); _surface.Children.Add(_notice); Content = _surface;
        _timer = new DispatcherTimer {Interval = TimeSpan.FromMilliseconds(100)};
        _timer.Tick += (_, _) => {
            var elapsed = (DateTimeOffset.Now - _startedAt).TotalSeconds;
            _duration = $"{elapsed:0.0} / 30.0 秒"; PublishVoice();
            if (elapsed >= 30) FinishRecording();
        };
        Opened += async (_, _) => await LoadAsync();
        PropertyChanged += (_, args) => {
            if (args.Property == WindowStateProperty || args.Property == IsVisibleProperty)
                _browser.SetPageVisible(IsVisible && WindowState != WindowState.Minimized && _loaded && !_notice.IsVisible);
        };
        Closed += (_, _) => {
            _closed = true; StopRecorder(); _ready?.TrySetCanceled(); _leaveResponse?.TrySetResult(true);
            _closeDialog?.Close(true); _lifetime.Cancel(); _pageLifetime.Cancel(); _browser.DisposeBrowser();
            _pageLifetime.Dispose(); _lifetime.Dispose();
        };
    }
    private static string BindingScope(ReceiverConfig config) =>
        ReceiverConfig.NormalizeEndpoint(config.Endpoint) + "\n" + config.DeviceId + "\n" + config.ClassId + "\n" + config.DeviceToken;
    private static bool AllowedPage(string source) => Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.Host == Host && uri.IsDefaultPort && uri.AbsolutePath == "/homework/classroom/index.html";
    private ReadingBrowser CreateBrowser()
    {
        var browser = new ReadingBrowser {HandleEscapeKey = false, HandleFullscreenKey = false};
        browser.FocusOutside += next => {
            if (!_closed && ReferenceEquals(browser, _browser))
                browser.FocusPage(next ? CoreWebView2MoveFocusReason.Next : CoreWebView2MoveFocusReason.Previous);
        };
        return browser;
    }
    private Task LoadAsync() => _loadTask is {IsCompleted:false} ? _loadTask : _loadTask = LoadCoreAsync();
    private async Task LoadCoreAsync()
    {
        if (_closed || _loaded && !_failed) return;
        _retry.IsVisible = false; _notice.IsVisible = true; _message.Text = "正在打开教室首页…";
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, _pageLifetime.Token);
        cancellation.CancelAfter(TimeSpan.FromSeconds(30));
        try {
            if (_failed) ResetBrowser();
            if (!_initialized) {
                var assets = await ReadingLocalAssets.EnsureAsync(cancellation.Token);
                if (!File.Exists(Path.Combine(assets, "homework", "classroom", "index.html")))
                    throw new IOException("客户端缺少教室首页资源，请重新安装最新版本。");
                var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                    _config.Endpoint.TrimEnd('/') + "\n" + _config.DeviceId + "\n" + _config.ClassId)))[..24];
                var root = ReceiverConfig.IsPreview(_config) ? AppContext.BaseDirectory :
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass");
                await _browser.InitializeAsync(Path.Combine(root, "ClassroomHome", key), cancellation.Token).WaitAsync(cancellation.Token);
                var core = _browser.Core!;
                core.SetVirtualHostNameToFolderMapping(Host, assets, CoreWebView2HostResourceAccessKind.DenyCors);
                core.Settings.AreDefaultContextMenusEnabled = false; core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                await core.AddScriptToExecuteOnDocumentCreatedAsync("window.ICeClassNativeHome=true;");
                core.NavigationStarting += (_, args) => { if (!AllowedPage(args.Uri)) args.Cancel = true; };
                core.NewWindowRequested += (_, args) => args.Handled = true;
                core.DownloadStarting += (_, args) => args.Cancel = true;
                core.LaunchingExternalUriScheme += (_, args) => args.Cancel = true;
                core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
                core.WebMessageReceived += async (_, args) => await ReceiveAsync(core, args);
                core.ProcessFailed += (_, _) => {
                    _failed = true; _loaded = false; _homeworkBusy = false;
                    _ready?.TrySetResult(false); _leaveResponse?.TrySetResult(false);
                    var interruptedRecording = _waveIn is not null;
                    StopRecorder();
                    if (interruptedRecording) ResetVoice("页面中断，录音未发送，请重新开始。");
                    ShowError("页面已停止，请重新打开并核对已保存的记录。未保存的选择需要重新填写。");
                };
                _initialized = true;
            }
            _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
            _browser.Core!.Navigate(Page);
            if (!await _ready.Task.WaitAsync(cancellation.Token)) return;
            _notice.IsVisible = false; _browser.IsVisible = true; _browser.SetPageVisible(IsVisible && WindowState != WindowState.Minimized);
            _browser.FocusPage();
        }
        catch (OperationCanceledException) when (_closed || _pageLifetime.IsCancellationRequested) { }
        catch (Exception error) {
            _failed = true; AppLog.Error("Open classroom home failed", error);
            ShowError(error is WebView2RuntimeNotFoundException ? "请先安装 Microsoft Edge WebView2，再打开教室端。" : "暂时无法打开教室首页，请重新打开。早读和浮岛仍可从托盘使用。");
        }
        finally { _ready = null; }
    }
    private void ResetBrowser()
    {
        _browser.DisposeBrowser(); _surface.Children.Remove(_browser); _browser = CreateBrowser();
        _surface.Children.Insert(0, _browser); _initialized = false; _loaded = false; _failed = false; _islandJson = null;
    }
    private void ShowError(string message)
    {
        if (_closed) return;
        _browser.SetPageVisible(false); _browser.IsVisible = false; _message.Text = message; _retry.IsVisible = true; _notice.IsVisible = true;
    }
    private void Post(object message)
    {
        if (_closed || !_loaded || _browser.Core is not { } core || !AllowedPage(core.Source)) return;
        core.PostWebMessageAsJson(JsonSerializer.Serialize(message, Json));
    }
    private object VoiceState() => new {recording = _recording, sending = _sending, status = _voiceStatus, duration = _duration, success = _voiceSuccess};
    private void PublishVoice() => Post(new {type = "voice-state", state = VoiceState()});
    private void PublishHome() => Post(new {type = "home-state", state = new {
        className = _config.ClassName,
        deviceCaption = $"{_config.DeviceName} · 设备编号 {ComputerIdentity.DeviceCode(_config.DeviceId)}",
        connected = _connection.Connected, connectionText = _connection.Text,
        capabilities = new {reading = _openReading is not null, plan = _openIdeas is not null, banban = _showBanban is not null},
        voice = VoiceState(), island = _islandState ?? ClassroomHomeSnapshot.Empty()}});
    private async Task ReceiveAsync(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_closed || !ReferenceEquals(core, _browser.Core) || !AllowedPage(args.Source) || args.WebMessageAsJson.Length > 65_536) return;
        int id = 0, version = _bindingVersion;
        try {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var message = document.RootElement;
            if (message.ValueKind != JsonValueKind.Object) return;
            if (message.TryGetProperty("type", out var type)) {
                switch (type.GetString()) {
                    case "classroom-ready":
                        _loaded = true; PublishHome();
                        if (_openManagement) {Post(new {type="open-management"});_openManagement=false;}
                        _ready?.TrySetResult(true); break;
                    case "homework-activity": _homeworkBusy = message.GetProperty("busy").GetBoolean(); break;
                    case "homework-leave": _leaveResponse?.TrySetResult(message.GetProperty("safe").GetBoolean()); break;
                }
                return;
            }
            id = message.GetProperty("id").GetInt32();
            if (id <= 0) return;
            object? value = null;
            switch (message.GetProperty("action").GetString()) {
                case "homework":
                    var path = message.GetProperty("path").GetString() ?? "";
                    JsonElement? body = message.TryGetProperty("body", out var b) && b.ValueKind != JsonValueKind.Null ? b : null;
                    value = await _api.SendAsync(_config, path, body, _pageLifetime.Token); break;
                case "reading": if (_openReading is not null) await _openReading(); break;
                case "voice": if (!_sending) {if (_recording) FinishRecording();else StartRecording();} break;
                case "cancel-voice": if (_recording) {StopRecorder(); ResetVoice("录音已取消，可以重新开始。");} break;
                case "plan": _openIdeas?.Invoke("submit"); break;
                case "banban": _showBanban?.Invoke(); break;
                case "binding": _openSettings?.Invoke(); break;
                case "about": _openAbout?.Invoke(); break;
                case "island": _showIsland?.Invoke(); break;
                case "acknowledge": _acknowledge?.Invoke(message.GetProperty("sequence").GetInt64()); break;
                default: throw new ArgumentException("当前操作不可用。");
            }
            if (version == _bindingVersion && ReferenceEquals(core, _browser.Core)) Post(new {type="response", id, value});
        }
        catch (Exception error) when (error is not OutOfMemoryException) {
            if (_closed || version != _bindingVersion || !ReferenceEquals(core, _browser.Core)) return;
            var text = error is HttpRequestException or JsonException ? "暂时无法连接，请检查网络后重新载入。"
                : error is OperationCanceledException ? "连接超时，当前选择已保留，请重新载入核对。" : error.Message;
            if (id > 0) Post(new {type="response", id, error=text});
            else AppLog.Error("Classroom page message failed", error);
        }
    }
    public void SetBinding(ReceiverConfig binding)
    {
        var scope = BindingScope(binding); var changed = _scope != scope; _scope = scope;
        _config.Endpoint = binding.Endpoint; _config.DeviceId = binding.DeviceId; _config.DeviceToken = binding.DeviceToken;
        _config.ClassId = binding.ClassId; _config.ClassName = binding.ClassName; _config.DeviceName = binding.DeviceName;
        Title = $"ICeClass 班伴 · {binding.ClassName}";
        if (!changed) {PublishHome(); return;}
        StopRecorder(); ResetVoice("班级归属已更新，请重新开始留言。");
        _bindingVersion++; _islandState = null; _loaded = false; _homeworkBusy = false;
        _closeDialog?.Close(false);
        _pageLifetime.Cancel(); _notice.IsVisible = true; _browser.SetPageVisible(false);
        _ = ReloadBindingAsync(_bindingVersion);
    }
    private async Task ReloadBindingAsync(int version)
    {
        if (_loadTask is not null) await _loadTask;
        if (_closed || version != _bindingVersion) return;
        _pageLifetime.Dispose(); _pageLifetime = new(); ResetBrowser(); await LoadAsync();
    }
    public void SetConnectionState(ReceiverConnectionState state) {_connection = state;PublishHome();}
    internal void SetIslandState(ClassroomHomeSnapshot state)
    {
        _islandState = state;
        var json = JsonSerializer.Serialize(state, Json);
        if (_islandJson == json) return;
        _islandJson = json; Post(new {type="island-state",state});
    }
    public void OpenManagement()
    {
        Show(); WindowState = WindowState.Normal; Activate();
        if (_loaded) Post(new {type="open-management"}); else _openManagement = true;
        _browser.FocusPage();
    }
    public void MinimizeToTray()
    {
        if (_recording) {StopRecorder();ResetVoice("录音已取消。需要留言时，请重新点击开始。");}
        _browser.SetPageVisible(false); WindowState = WindowState.Minimized; Hide();
    }
    public async Task<bool> PrepareToLeaveAsync()
    {
        if (_leaveCheck is not null) return await _leaveCheck;
        _leaveCheck = CheckLeaveAsync();
        try {return await _leaveCheck;} finally {_leaveCheck = null;}
    }
    private async Task<bool> CheckLeaveAsync()
    {
        if (_closed || !_loaded || _failed || _browser.Core is null) return true;
        var pageToken = _pageLifetime.Token;
        _leaveResponse = new(TaskCreationOptions.RunContinuationsAsynchronously);
        try {
            var ready = await _browser.Core.ExecuteScriptAsync("""
                (()=>{
                  if (typeof window.ICeClassHomework?.prepareToLeave !== 'function') return false;
                  window.ICeClassHomework.prepareToLeave().then(safe => {
                    window.chrome.webview.postMessage({type:'homework-leave',safe});
                  }).catch(() => window.chrome.webview.postMessage({type:'homework-leave',safe:false}));
                  return true;
                })();
                """).WaitAsync(TimeSpan.FromSeconds(5), pageToken);
            if (ready != "true") throw new InvalidOperationException("Homework leave handler is unavailable.");
            return await _leaveResponse.Task.WaitAsync(pageToken);
        }
        catch (OperationCanceledException) when (_closed || pageToken.IsCancellationRequested) {return _closed;}
        catch (Exception error) when (error is not OutOfMemoryException) {
            AppLog.Error("Check classroom changes before exit", error);
            if (_closed) return true;
            var dialog = new Window {Title="确认退出",Width=460,MinHeight=240,SizeToContent=SizeToContent.Height,CanResize=false,
                WindowStartupLocation=WindowStartupLocation.CenterOwner,Background=Avalonia.Media.Brushes.White};
            ClassroomStyle.Apply(dialog); DesktopStyle.KeepWindowInWorkingArea(dialog);
            var keep = ClassroomStyle.Button("继续填写",true); var discard = ClassroomStyle.Button("放弃并退出");
            keep.Click += (_,_)=>dialog.Close(false);discard.Click += (_,_)=>dialog.Close(true);
            dialog.Content = new StackPanel {Margin=new Thickness(24),Spacing=18,Children={
                ClassroomStyle.SectionTitle("暂时无法确认保存状态"),ClassroomStyle.Caption("继续填写并保存，或放弃未保存的选择。"),
                new StackPanel {Orientation=Orientation.Horizontal,Spacing=12,Children={discard,keep}}}};
            _closeDialog=dialog;
            try{return await dialog.ShowDialog<bool>(this);}finally{_closeDialog=null;}
        }
        finally {_leaveResponse=null;}
    }
    private void StartRecording()
    {
        try {
            if (WaveInEvent.DeviceCount <= 0) throw new InvalidOperationException("没有检测到可用麦克风，请检查 Windows 麦克风连接和权限。");
            _buffer = new MemoryStream(); _writer = new WaveFileWriter(_buffer, new WaveFormat(16_000,16,1));
            _waveIn = new WaveInEvent {WaveFormat=new WaveFormat(16_000,16,1),BufferMilliseconds=50};
            _waveIn.DataAvailable += (_,args)=>{lock(_audioGate)_writer?.Write(args.Buffer,0,args.BytesRecorded);};
            _waveIn.RecordingStopped += (source,args)=>Dispatcher.UIThread.Post(()=>{if(ReferenceEquals(source,_waveIn))RecordingStopped(args.Exception);});
            _waveIn.StartRecording(); _recording=true; _startedAt=DateTimeOffset.Now; _timer.Start();
            _voiceSuccess=false;_voiceStatus="正在录音…再次点击按钮结束并发送。";PublishVoice();
        }
        catch (Exception error) {StopRecorder();ResetVoice($"无法使用麦克风：{error.Message}");AppLog.Error("Student voice recording failed",error);}
    }
    private void FinishRecording()
    {
        if (!_recording) return;
        _recording=false;_sending=true;_timer.Stop();_voiceStatus="正在发送给本班教师，请稍候…";PublishVoice();
        try {_waveIn?.StopRecording();}catch(Exception error){StopRecorder();ResetVoice($"录音结束失败：{error.Message}");}
    }
    private async void RecordingStopped(Exception? recordingError)
    {
        if (_closed) return;
        var version=_bindingVersion;
        byte[] bytes;
        lock(_audioGate){
            var writer=_writer;var buffer=_buffer;_writer=null;_buffer=null;
            writer?.Dispose();bytes=buffer?.ToArray()??[];buffer?.Dispose();
        }
        _waveIn?.Dispose();_waveIn=null;_timer.Stop();_recording=false;
        if(recordingError is not null){ResetVoice($"录音失败：{recordingError.Message}");return;}
        if(bytes.Length<16_044){ResetVoice("录音太短，请至少录音 0.5 秒。");return;}
        _sending=true;PublishVoice();
        try {await _send(bytes);if(version==_bindingVersion)ResetVoice("已发送给本班教师。可以再次点击开始录音。",true);}
        catch(Exception error){AppLog.Error("Student voice upload failed",error);if(version==_bindingVersion)ResetVoice($"发送失败：{error.Message}");}
        finally{if(version==_bindingVersion){_sending=false;if(!_closed)PublishVoice();}}
    }
    private void ResetVoice(string status,bool success=false)
    {
        _sending=false;_duration="最长 30 秒";_voiceStatus=status;_voiceSuccess=success;PublishVoice();
    }
    private void StopRecorder()
    {
        _timer.Stop();var wave=_waveIn;_waveIn=null;
        try{wave?.StopRecording();}catch{ }wave?.Dispose();
        lock(_audioGate){_writer?.Dispose();_writer=null;_buffer?.Dispose();_buffer=null;}
        _recording=false;
    }
}

internal sealed record ClassroomHomeLesson(string Name,string Start,string End,bool Current);
internal sealed record ClassroomHomeSnapshot(string Date,bool ScheduleKnown,List<ClassroomHomeLesson> Lessons,ClassroomIslandNotice? Notice)
{
    internal static ClassroomHomeSnapshot Empty() => new(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd"),false,[],null);
}

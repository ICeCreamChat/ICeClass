using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using ICeClass.Updates;

namespace ICeClass.Receiver;

public sealed partial class App : Application
{
    private IClassicDesktopStyleApplicationLifetime? _desktop;
    private CloudReceiverService? _receiver;
    private readonly ReceiverUpdateService _updates = new();
    private SpeechService? _speech;
    private TrayIcon? _tray;
    private NativeMenuItem? _statusMenuItem;
    private EnrollmentWindow? _enrollmentWindow;
    private StudentVoiceWindow? _studentVoiceWindow;
    private CreativeIdeasWindow? _creativeIdeasWindow;
    private BanbanVoiceWindow? _banbanVoiceWindow;
    private AboutWindow? _aboutWindow;
    private ComputerControlSettingsWindow? _computerSettingsWindow;
    private Task? _stopTask;
    private IslandShoutPreviewWindow? _shoutPreviewWindow;
    private ReadingReminderService? _readingReminders;
    private ClassroomIslandService? _island;
    private SelfStudyMonitor? _selfStudy;
    private NativeMenuItem? _islandMenuItem;
    private CancellationTokenSource? _automaticUpdateCancellation;
    private int _updateInProgress;
    private NativeMenuItem? _updateMenuItem;
    private string? _readyUpdateVersion;
    private string? _updateStateText;
    private bool _updateStateBusy;
    private UpdateProgress? _updateProgress;
    private DateTimeOffset _nextUpdateCheck;
    private bool _exitRequested;
    private ReceiverConnectionState _lastConnectionState = new(false, "正在连接…");

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is not IClassicDesktopStyleApplicationLifetime desktop)
        {
            base.OnFrameworkInitializationCompleted();
            return;
        }

        _desktop = desktop;
        InitializeClientDiagnostics();
        desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _speech = new SpeechService();
        _receiver = new CloudReceiverService(_speech);
        _readingReminders = new ReadingReminderService();
        _island = new ClassroomIslandService(config => ClassroomControlService.OpenReadingAsync(config), ShowStudentVoice);
        _selfStudy = new SelfStudyMonitor(
            token => _island.ShowSelfStudyWarningAsync(token),
            () => _banbanVoiceWindow?.IsBusy == true || _studentVoiceWindow?.IsBusy == true ||
                _creativeIdeasWindow?.IsVisible == true || ReadingExperience.IsOpen || _speech?.IsBusy == true,
            () => _island.CancelSelfStudyWarning());
        _selfStudy.FeedbackChanged += _island.UpdateSelfStudyFeedback;
        _selfStudy.SoundLevelChanged += _island.UpdateSelfStudyLevel;
        _receiver.SelfStudyChanged += () => Dispatcher.UIThread.Post(() => _selfStudy?.Invalidate());
        _receiver.NotificationPresenter = _island;
        _island.ShoutPreviewRequested += PreviewShout;
        _island.PreferenceChanged += UpdateIslandMenu;
        _island.ClassTimeChanged += value => _banbanVoiceWindow?.SetInClass(value);
        _island.HomeStateChanged += state => _studentVoiceWindow?.SetIslandState(state);
        ReadingExperience.Configure(ShowStudentVoice, () => _studentVoiceWindow?.MinimizeToTray());
        _receiver.ConnectionStateChanged += ReceiverOnConnectionStateChanged;
        _receiver.BindingChanged += (_, binding) => Dispatcher.UIThread.Post(() => {
            ResetClientDiagnosticBinding();
            if (_creativeIdeasWindow is not null && !_creativeIdeasWindow.Matches(binding)) { _creativeIdeasWindow.CloseWithoutPrompt(); _creativeIdeasWindow = null; }
            ReadingOfflineService.For(binding); _readingReminders?.Start(binding); _studentVoiceWindow?.SetBinding(binding);
            ReadingExperience.BindingChanged(binding); _island?.SetBinding(binding);
            _selfStudy?.SetBinding(binding);
            if (_banbanVoiceWindow is null || !_banbanVoiceWindow.Matches(binding)) StartBanbanVoice(binding, _banbanVoiceWindow?.IsVisible != true);
        });
        CreateTray();
        InitializeVoiceResources();
        DesktopShortcut.EnsureCreated();
        InstanceActivation.Listen(() => Dispatcher.UIThread.Post(ShowStudentVoice),
            () => Dispatcher.UIThread.Post(() => _island?.PlayDemo()), () => Dispatcher.UIThread.Post(PreviewShout));
        ReceiverUpdateService.ConfirmUpdatedLaunch();
        desktop.Exit += async (_, _) => await ShutdownAsync();

        if (ReceiverConfig.TryLoad(out var config))
        {
            ReadingOfflineService.For(config);
            StartupManager.SetEnabled(config);
            _ = _receiver.StartAsync(config);
            _readingReminders.Start(config);
            _island.SetBinding(config);
            _selfStudy.SetBinding(config);
            Dispatcher.UIThread.Post(() => StartBanbanVoice(config, true));
            StartAutomaticUpdates(config);
            // Keep the student entry point visible on classroom screens so nobody has to find the tray menu.
            if (desktop.Args?.Contains("--island-shout-preview") == true) Dispatcher.UIThread.Post(PreviewShout);
            else if (desktop.Args?.Contains("--island-demo") == true) Dispatcher.UIThread.Post(() => _island.PlayDemo());
            else if (!(desktop.Args?.Contains("--background") ?? false)) Dispatcher.UIThread.Post(ShowStudentVoice);
        }
        else
        {
            ShowEnrollment();
        }

        Dispatcher.UIThread.Post(() => UpdateInstaller.ConfirmLaunch(AppContext.BaseDirectory), DispatcherPriority.Background);
        base.OnFrameworkInitializationCompleted();
    }

    private void CreateTray()
    {
        var menu = new NativeMenu();
        _statusMenuItem = new NativeMenuItem { Header = "未连接教室", IsEnabled = false };
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new NativeMenuItemSeparator());
        var studentVoice = new NativeMenuItem { Header = "教室首页" };
        studentVoice.Click += (_, _) => ShowStudentVoice();
        menu.Items.Add(studentVoice);
        var banbanVoice = new NativeMenuItem { Header = "班班语音助手" };
        banbanVoice.Click += (_, _) => ShowBanbanVoice();
        menu.Items.Add(banbanVoice);
        var reading = new NativeMenuItem { Header = "早读陪伴" };
        reading.Click += async (_, _) =>
        {
            if (!ReceiverConfig.TryLoad(out var current)) { ShowEnrollment(); return; }
            try { await ClassroomControlService.OpenReadingAsync(current); }
            catch (Exception error) { AppLog.Error("Open reading failed", error); ShowStudentVoice(); }
        };
        menu.Items.Add(reading);
        menu.Items.Add(new NativeMenuItemSeparator());
        var display = new NativeMenu();
        var banbanPet = new NativeMenuItem { Header = "显示班班桌宠" };
        banbanPet.Click += (_, _) =>
        {
            if (!ReceiverConfig.TryLoad(out var config)) { ShowEnrollment(); return; }
            StartBanbanVoice(config, true); _banbanVoiceWindow?.ShowPet();
        };
        display.Items.Add(banbanPet);
        _islandMenuItem = new NativeMenuItem { Header = "隐藏教室浮岛" };
        _islandMenuItem.Click += (_, _) =>
        {
            if (!ReceiverConfig.TryLoad(out _)) { ShowEnrollment(); return; }
            _island?.SetEnabled(!_island.Enabled);
        };
        display.Items.Add(_islandMenuItem);
        menu.Items.Add(new NativeMenuItem { Header = "桌面显示", Menu = display });
        var stopComputer = new NativeMenuItem { Header = "停止当前任务" };
        stopComputer.Click += async (_, _) => await StopCurrentTaskAsync();
        menu.Items.Add(stopComputer);
        menu.Items.Add(new NativeMenuItemSeparator());
        var setup = new NativeMenuItem { Header = "教室设置" };
        setup.Click += (_, _) => ShowEnrollment();
        menu.Items.Add(setup);
        var about = new NativeMenuItem { Header = "关于班伴" };
        about.Click += (_, _) => ShowAbout();
        menu.Items.Add(about);
        _updateMenuItem = new NativeMenuItem { Header = "检查更新" };
        _updateMenuItem.Click += async (_, _) => await CheckForUpdateAsync(true);
        var voiceResources = new NativeMenuItem { Header = "语音资源与下载" };
        voiceResources.Click += (_, _) => { ShowEnrollment(); _enrollmentWindow?.RevealVoiceResources(); };
        menu.Items.Add(voiceResources);
        menu.Items.Add(_updateMenuItem);
        menu.Items.Add(new NativeMenuItemSeparator());
        var exit = new NativeMenuItem { Header = "退出" };
        exit.Click += async (_, _) => await ExitAsync();
        menu.Items.Add(exit);
        _tray = new TrayIcon { Icon = new WindowIcon(AppIconFactory.CreateStream()), ToolTipText = "ICeClass 班伴", Menu = menu, IsVisible = true };
        _tray.Clicked += (_, _) => ShowStudentVoice();
    }

    private Task StopCurrentTaskAsync()
    {
        if (_stopTask is { IsCompleted: false }) return _stopTask;
        _banbanVoiceWindow?.CancelCurrentTask();
        if (_receiver is null) return Task.CompletedTask;
        if (!ReceiverConfig.TryLoad(out var binding)) { _receiver.ComputerAgent.Stop(); return Task.CompletedTask; }
        return _stopTask = _receiver.StopComputerTaskAsync(binding);
    }

    private void ShowComputerSettings()
    {
        if (_receiver is null) return;
        if (_computerSettingsWindow is null)
        {
            ReceiverConfig.TryLoad(out var binding);
            _computerSettingsWindow = new ComputerControlSettingsWindow(_receiver.ComputerAgent, binding, stopTask: StopCurrentTaskAsync);
            _computerSettingsWindow.Closed += (_, _) => _computerSettingsWindow = null;
        }
        _computerSettingsWindow.Show(); _computerSettingsWindow.WindowState = WindowState.Normal; _computerSettingsWindow.Activate();
    }

    private void ShowAbout()
    {
        if (_aboutWindow is null)
        {
            ReceiverConfig.TryLoad(out var diagnosticBinding);
            _aboutWindow = new AboutWindow(async token => await ReceiverDiagnostics.CollectAsync(
                $"连接状态：{_lastConnectionState.Text}\n语音资源：{_voicePreparation?.Current.Message ?? "未初始化"}\n" +
                $"客户端更新：检查或下载中={_updateInProgress != 0}；待安装={_readyUpdateVersion ?? "无"}\n" +
                $"早读：已打开={ReadingExperience.IsOpen}；全屏={ReadingExperience.IsFullscreen}\n" +
                (_studentVoiceWindow is { } home ? await home.CollectDiagnosticStateAsync(token) : "教室首页尚未初始化。\n") +
                (_island?.DiagnosticState ?? "通知窗口尚未初始化。"), token),
                (report, token) => SubmitClientDiagnosticsAsync("manual", report, token, diagnosticBinding),
                acknowledgementsEndpoint: string.IsNullOrEmpty(diagnosticBinding.Endpoint) ? ReceiverConfig.TryLoadDefaultEndpoint() : diagnosticBinding.Endpoint);
            _aboutWindow.Closed += (_, _) => _aboutWindow = null;
        }
        _aboutWindow.Show(); _aboutWindow.WindowState = WindowState.Normal; _aboutWindow.Activate();
    }

    private void ShowBanbanVoice()
    {
        if (!ReceiverConfig.TryLoad(out var config)) { ShowEnrollment(); return; }
        StartBanbanVoice(config, false);
    }

    private void CallBanban()
    {
        if (!ReceiverConfig.TryLoad(out var config)) { ShowEnrollment(); return; }
        StartBanbanVoice(config, true, listen: true);
    }

    private async void StartBanbanVoice(ReceiverConfig config, bool background, bool listen = false)
    {
        if (_banbanVoiceWindow is not null && !_banbanVoiceWindow.Matches(config)) { _banbanVoiceWindow.Shutdown(); _banbanVoiceWindow = null; }
        if (_banbanVoiceWindow is null)
        {
            var window = new BanbanVoiceWindow(config, () => _receiver?.ComputerAgent.Stop());
            window.SetInClass(_island?.InClass == true);
            _banbanVoiceWindow = window;
            window.Closed += (_, _) => { if (ReferenceEquals(_banbanVoiceWindow, window)) _banbanVoiceWindow = null; };
        }
        try
        {
            if (listen) _banbanVoiceWindow.StartConversation();
            await _banbanVoiceWindow.StartAsync(background);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { AppLog.Error("Start Banban voice failed", error); }
    }

    private async void PreviewShout()
    {
        if (_receiver is null || _island is null) return;
        if (_shoutPreviewWindow is not null)
        {
            _shoutPreviewWindow.Show(); _shoutPreviewWindow.WindowState = WindowState.Normal; _shoutPreviewWindow.Activate();
            return;
        }
        var preview = new IslandShoutPreviewWindow((level, sound) => _receiver.ShowShoutPreviewAsync(level, sound), () => _island.CancelPreviewShouts());
        _shoutPreviewWindow = preview;
        preview.Closed += (_, _) => { if (ReferenceEquals(_shoutPreviewWindow, preview)) _shoutPreviewWindow = null; };
        preview.Show(); preview.Activate();
        try { await preview.Play("info"); }
        catch (Exception error) { AppLog.Error("Preview island shout failed", error); }
    }

    private void ShowEnrollment()
    {
        if (_enrollmentWindow is not null)
        {
            _enrollmentWindow.Show(); _enrollmentWindow.WindowState = WindowState.Normal;
            _enrollmentWindow.Activate();
            return;
        }

        _enrollmentWindow = new EnrollmentWindow(ReceiverConfig.TryLoad(out var config) ? config : null);
        ConnectVoiceResourcesView();
        if (config is not null) _enrollmentWindow.SetConnectionState(_lastConnectionState);
        if (_updateStateText is not null)
            _enrollmentWindow.SetUpdateState(_updateStateText, _updateStateBusy, _readyUpdateVersion is not null, _updateProgress);
        else if (_readyUpdateVersion is not null) _enrollmentWindow.SetUpdateState($"新版 {_readyUpdateVersion} 已就绪，可立即更新。", false, true);
        _enrollmentWindow.UpdateRequested += async (_, _) => await CheckForUpdateAsync(true);
        _enrollmentWindow.PreviewRequested += level => _ = _receiver?.ShowTestAsync(level);
        _enrollmentWindow.AudioTestRequested += async (_, _) => await TestAudioAsync();
        _enrollmentWindow.ComputerSettingsRequested += (_, _) => ShowComputerSettings();
        _enrollmentWindow.Saved += async (_, saved) =>
        {
            _creativeIdeasWindow?.CloseWithoutPrompt(); _creativeIdeasWindow = null;
            ReadingOfflineService.For(saved);
            await ReadingExperience.StopAsync();
            await _receiver!.RestartAsync(saved);
            _readingReminders?.Start(saved);
            _island?.SetBinding(saved);
            _selfStudy?.SetBinding(saved);
            StartBanbanVoice(saved, _banbanVoiceWindow?.IsVisible != true);
            StartAutomaticUpdates(saved);
            InitializeVoiceResources();
            _enrollmentWindow?.Close();
            _studentVoiceWindow?.Close();
            Dispatcher.UIThread.Post(ShowStudentVoice);
        };
        _enrollmentWindow.Closed += (_, _) => _enrollmentWindow = null;
        KeepInTray(_enrollmentWindow);
        _enrollmentWindow.Show();
        _enrollmentWindow.Activate();
    }

    private void ShowStudentVoice()
    {
        if (ReadingExperience.ReturnToHomeIfOpen()) return;
        if (_studentVoiceWindow is not null)
        {
            _studentVoiceWindow.Show(); _studentVoiceWindow.WindowState = WindowState.Normal;
            _studentVoiceWindow.Activate();
            return;
        }
        if (!ReceiverConfig.TryLoad(out var config))
        {
            ShowEnrollment();
            return;
        }
        _studentVoiceWindow = new StudentVoiceWindow(config, audio => _receiver?.SendStudentVoiceAsync(config, audio) ?? Task.FromException(new InvalidOperationException("教室端尚未启动。")), () => ClassroomControlService.OpenReadingAsync(config), ShowEnrollment, ShowAbout, () => _island?.ShowControls(), CallBanban, ShowCreativeIdeas, acknowledge: sequence => _island?.AcknowledgeHomeNotice(sequence),
            selfStudy: action => action == "pause" ? _selfStudy?.Pause() : _selfStudy?.View());
        _studentVoiceWindow.SetConnectionState(_lastConnectionState);
        if (_island?.HomeState is { } homeState) _studentVoiceWindow.SetIslandState(homeState);
        _studentVoiceWindow.Closed += (_, _) => _studentVoiceWindow = null;
        KeepInTray(_studentVoiceWindow);
        _studentVoiceWindow.Show();
        _studentVoiceWindow.Activate();
    }

    private async void ShowCreativeIdeas(string view)
    {
        if (!ReceiverConfig.TryLoad(out var config)) { ShowEnrollment(); return; }
        if (_creativeIdeasWindow is not null && !_creativeIdeasWindow.Matches(config))
        { _creativeIdeasWindow.CloseWithoutPrompt(); _creativeIdeasWindow = null; }
        if (_creativeIdeasWindow is not null) { _creativeIdeasWindow.BringForward(_studentVoiceWindow); return; }
        var window = new CreativeIdeasWindow(config); _creativeIdeasWindow = window;
        window.Closed += (_, _) => { if (ReferenceEquals(_creativeIdeasWindow, window)) _creativeIdeasWindow = null; };
        window.BringForward(_studentVoiceWindow); await window.LoadAsync(view);
    }

    private async Task TestAudioAsync()
    {
        if (_receiver is null || _enrollmentWindow is null) return;
        _enrollmentWindow.SetAudioTestState("正在播放测试音…", true);
        try
        {
            await _receiver.PlayTestAudioAsync();
            _enrollmentWindow?.SetAudioTestState("测试音播放完成；如果没有听到，请检查 Windows 音量和默认扬声器。", false);
        }
        catch (Exception exception)
        {
            AppLog.Error("Local audio test failed", exception);
            _enrollmentWindow?.SetAudioTestState($"本机声音测试失败：{exception.Message}", false);
        }
    }

    private async Task ExitAsync()
    {
        if (_exitRequested) return;
        if (_studentVoiceWindow is { } home)
        {
            if (home.HasHomeworkActivity) { home.Show(); home.WindowState = WindowState.Normal; home.Activate(); }
            if (!await home.PrepareToLeaveAsync()) return;
        }
        if (_exitRequested) return;
        _exitRequested = true;
        await ReadingExperience.StopAsync();
        _desktop?.TryShutdown();
    }

    private async Task ShutdownAsync()
    {
        AppLog.ErrorRecorded -= QueueClientError; _clientErrors?.Dispose();
        _creativeIdeasWindow?.CloseWithoutPrompt(); _creativeIdeasWindow = null;
        _banbanVoiceWindow?.Shutdown();
        _selfStudy?.Dispose();
        _shoutPreviewWindow?.Close();
        _island?.Dispose();
        await ReadingExperience.StopAsync();
        _readingReminders?.Stop();
        ReadingOfflineService.Stop();
        InstanceActivation.Stop();
        _automaticUpdateCancellation?.Cancel();
        _automaticUpdateCancellation?.Dispose();
        _tray?.Dispose();
        _voicePreparation?.Dispose();
        if (_receiver is not null) await _receiver.StopAsync();
        _studentVoiceWindow?.Close();
        _speech?.Dispose();
    }

    private void KeepInTray(Window window)
    {
        window.Closing += (_, args) =>
        {
            if (_exitRequested || args.IsProgrammatic || args.CloseReason is WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown) return;
            args.Cancel = true;
            if (window is StudentVoiceWindow home) home.MinimizeToTray();
            else { window.WindowState = WindowState.Minimized; window.Hide(); }
        };
    }

    // Wake listening remains active; only conversation, recording and classroom work block downloads.
    private bool VoiceActivityBusy => ReadingExperience.IsOpen ||
        _banbanVoiceWindow?.IsBusy == true || _studentVoiceWindow?.IsBusy == true ||
        _creativeIdeasWindow?.IsVisible == true || _receiver?.ComputerAgent.IsBusy == true || _stopTask is { IsCompleted: false };
    private bool CanUpdate(bool userInitiated) => !VoiceActivityBusy && _voicePreparation?.IsDownloading != true &&
        (userInitiated || _island?.ScheduleKnown == true && _island.InClass == false);
    private bool CanDownloadUpdate => CanUpdate(false);
    private string ManualUpdateBlockedText => VoiceActivityBusy
        ? "请先结束早读、录音、对话或当前任务，再立即更新。"
        : "语音资源正在下载，请先暂停资源下载，再立即更新。";

    private void StartAutomaticUpdates(ReceiverConfig config)
    {
        _automaticUpdateCancellation?.Cancel();
        _automaticUpdateCancellation?.Dispose();
        _automaticUpdateCancellation = new CancellationTokenSource();
        var token = _automaticUpdateCancellation.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(Random.Shared.Next(2, 16)), token);
                while (!token.IsCancellationRequested)
                {
                    if (_readyUpdateVersion is null && DateTimeOffset.UtcNow >= _nextUpdateCheck &&
                        await Dispatcher.UIThread.InvokeAsync(() => CanDownloadUpdate))
                        await CheckForUpdateAsync(false, config, token);
                    await Task.Delay(TimeSpan.FromSeconds(15), token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }, token);
    }

    private async Task CheckForUpdateAsync(bool userInitiated, ReceiverConfig? knownConfig = null, CancellationToken token = default)
    {
        if (Interlocked.Exchange(ref _updateInProgress, 1) != 0) return;
        try
        {
            AppLog.Info(userInitiated ? "Receiver manual update requested" : "Receiver background update check started");
            if (!await Dispatcher.UIThread.InvokeAsync(() => CanUpdate(userInitiated)))
            {
                if (userInitiated) SetUpdateState(await Dispatcher.UIThread.InvokeAsync(() => ManualUpdateBlockedText), false);
                return;
            }
            _readyUpdateVersion ??= ReceiverUpdateService.PendingVersion();
            if (_readyUpdateVersion is not null)
            {
                if (userInitiated)
                    await Dispatcher.UIThread.InvokeAsync(InstallReadyUpdate);
                return;
            }
            var config = knownConfig;
            if (config is null && !ReceiverConfig.TryLoad(out config))
            {
                if (userInitiated) SetUpdateState("请先完成教室绑定，再检查更新。", false);
                return;
            }
            SetUpdateState("正在检查更新…", true);
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(token);
            var monitor = PauseWhenBusyAsync(idle, userInitiated);
            ReceiverUpdateResult result;
            try
            {
                // Capture the UI context once. Progress and completion then share the same queue,
                // so a delayed download callback cannot replace the final ready/paused state.
                var progress = await Dispatcher.UIThread.InvokeAsync(() => new Progress<UpdateProgress>(value =>
                    ApplyUpdateState(value.Message, true, value)));
                // Hashing models and applying a binary patch must not run on the UI dispatcher.
                result = await Task.Run(() => _updates.CheckAndDownloadAsync(config, progress, idle.Token), idle.Token);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested && idle.IsCancellationRequested)
            {
                _nextUpdateCheck = DateTimeOffset.UtcNow.AddSeconds(15);
                SetUpdateState(userInitiated ? "更新已暂停，请结束当前活动后重试。" : "更新已暂停，课间空闲时继续下载。", false);
                return;
            }
            finally { idle.Cancel(); await monitor; }
            _nextUpdateCheck = DateTimeOffset.UtcNow.AddMinutes(30);
            if (!result.UpdateAvailable)
                SetUpdateState($"当前已是最新版本 {ReceiverUpdateService.CurrentVersionText}", false);
            else
            {
                _readyUpdateVersion = result.Version;
                AppLog.Info($"Receiver update ready: {result.Version}; manual={userInitiated}");
                if (userInitiated) await Dispatcher.UIThread.InvokeAsync(InstallReadyUpdate);
                else SetUpdateState($"新版 {result.Version} 已就绪，可立即更新。", false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception exception)
        {
            _nextUpdateCheck = DateTimeOffset.UtcNow.AddMinutes(5);
            AppLog.Error("Receiver update check failed", exception);
            SetUpdateState(userInitiated ? $"更新失败：{exception.Message}" : "检查更新失败，稍后自动重试。", false);
        }
        finally { Interlocked.Exchange(ref _updateInProgress, 0); }
    }

    private void InstallReadyUpdate()
    {
        if (!CanUpdate(true)) { ApplyUpdateState(ManualUpdateBlockedText, false, _updateProgress); return; }
        ApplyUpdateState($"正在更新至 {_readyUpdateVersion}，完成后自动重新打开…", true, _updateProgress);
        var ready = new ReceiverUpdateResult(true, _readyUpdateVersion!, null);
        if (!_updates.TryLaunchInstaller(ready, out var error))
        {
            _readyUpdateVersion = null;
            ApplyUpdateState(error, false, _updateProgress);
            return;
        }
        _exitRequested = true;
        _desktop?.TryShutdown();
    }

    private async Task PauseWhenBusyAsync(CancellationTokenSource idle, bool userInitiated = false)
    {
        try
        {
            while (!idle.IsCancellationRequested)
            {
                if (!await Dispatcher.UIThread.InvokeAsync(() => CanUpdate(userInitiated))) { idle.Cancel(); break; }
                await Task.Delay(250, idle.Token);
            }
        }
        catch (OperationCanceledException) when (idle.IsCancellationRequested) { }
    }

    private void SetUpdateState(string text, bool checking)
    {
        Dispatcher.UIThread.Post(() => ApplyUpdateState(text, checking, checking ? null : _updateProgress));
    }

    private void ApplyUpdateState(string text, bool checking, UpdateProgress? progress)
    {
        _updateStateText = text; _updateStateBusy = checking; _updateProgress = progress;
        _enrollmentWindow?.SetUpdateState(text, checking, _readyUpdateVersion is not null, progress);
        if (_updateMenuItem is not null)
        {
            _updateMenuItem.Header = _readyUpdateVersion is not null ? "立即更新" : "检查更新";
            _updateMenuItem.IsEnabled = !checking;
        }
    }

    private void ReceiverOnConnectionStateChanged(object? sender, ReceiverConnectionState state)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            if (_statusMenuItem is not null)
            {
                var name = ReceiverConfig.TryLoad(out var binding) ? binding.ClassName : "未绑定教室";
                _statusMenuItem.Header = state.Connected ? name + " · 已连接" : name + " · 未连接";
            }
            _tray!.ToolTipText = state.Text;
            _lastConnectionState = state;
            _enrollmentWindow?.SetConnectionState(state);
            _studentVoiceWindow?.SetConnectionState(state);
            _island?.SetConnection(state);
        });
    }

    private void UpdateIslandMenu()
    {
        if (_islandMenuItem is not null) _islandMenuItem.Header = _island?.Enabled == true ? "隐藏教室浮岛" : "显示教室浮岛";
    }
}

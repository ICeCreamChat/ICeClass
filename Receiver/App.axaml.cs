using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;

namespace ICeClass.Receiver;

public sealed class App : Application
{
    private IClassicDesktopStyleApplicationLifetime? _desktop;
    private CloudReceiverService? _receiver;
    private readonly ReceiverUpdateService _updates = new();
    private SpeechService? _speech;
    private TrayIcon? _tray;
    private NativeMenuItem? _statusMenuItem;
    private EnrollmentWindow? _enrollmentWindow;
    private StudentVoiceWindow? _studentVoiceWindow;
    private BanbanVoiceWindow? _banbanVoiceWindow;
    private AboutWindow? _aboutWindow;
    private ComputerControlSettingsWindow? _computerSettingsWindow;
    private Task? _stopTask;
    private IslandShoutPreviewWindow? _shoutPreviewWindow;
    private ReadingReminderService? _readingReminders;
    private ClassroomIslandService? _island;
    private NativeMenuItem? _islandMenuItem;
    private CancellationTokenSource? _automaticUpdateCancellation;
    private int _updateInProgress;
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
        desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _speech = new SpeechService();
        _receiver = new CloudReceiverService(_speech);
        _readingReminders = new ReadingReminderService();
        _island = new ClassroomIslandService(config => ClassroomControlService.OpenReadingAsync(config), ShowStudentVoice);
        _receiver.NotificationPresenter = _island;
        _island.ShoutPreviewRequested += PreviewShout;
        _island.PreferenceChanged += UpdateIslandMenu;
        _island.ClassTimeChanged += value => _banbanVoiceWindow?.SetInClass(value);
        ReadingExperience.Configure(ShowStudentVoice, () => _studentVoiceWindow?.MinimizeToTray());
        _receiver.ConnectionStateChanged += ReceiverOnConnectionStateChanged;
        _receiver.BindingChanged += (_, binding) => Dispatcher.UIThread.Post(() => {
            ReadingOfflineService.For(binding); _readingReminders?.Start(binding); _studentVoiceWindow?.SetBinding(binding);
            ReadingExperience.BindingChanged(binding); _island?.SetBinding(binding);
            if (_banbanVoiceWindow is null || !_banbanVoiceWindow.Matches(binding)) StartBanbanVoice(binding, _banbanVoiceWindow?.IsVisible != true);
        });
        CreateTray();
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
            _aboutWindow = new AboutWindow();
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
        if (config is not null) _enrollmentWindow.SetConnectionState(_lastConnectionState);
        _enrollmentWindow.UpdateRequested += async (_, _) => await CheckForUpdateAsync(true);
        _enrollmentWindow.PreviewRequested += level => _ = _receiver?.ShowTestAsync(level);
        _enrollmentWindow.AudioTestRequested += async (_, _) => await TestAudioAsync();
        _enrollmentWindow.ComputerSettingsRequested += (_, _) => ShowComputerSettings();
        _enrollmentWindow.Saved += async (_, saved) =>
        {
            ReadingOfflineService.For(saved);
            await ReadingExperience.StopAsync();
            await _receiver!.RestartAsync(saved);
            _readingReminders?.Start(saved);
            _island?.SetBinding(saved);
            StartBanbanVoice(saved, _banbanVoiceWindow?.IsVisible != true);
            StartAutomaticUpdates(saved);
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
        _studentVoiceWindow = new StudentVoiceWindow(config, audio => _receiver?.SendStudentVoiceAsync(config, audio) ?? Task.FromException(new InvalidOperationException("教室端尚未启动。")), () => ClassroomControlService.OpenReadingAsync(config), ShowEnrollment, ShowAbout, () => _island?.ShowControls(), CallBanban);
        _studentVoiceWindow.SetConnectionState(_lastConnectionState);
        _studentVoiceWindow.Closed += (_, _) => _studentVoiceWindow = null;
        KeepInTray(_studentVoiceWindow);
        _studentVoiceWindow.Show();
        _studentVoiceWindow.Activate();
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
        _exitRequested = true;
        await ReadingExperience.StopAsync();
        _desktop?.TryShutdown();
    }

    private async Task ShutdownAsync()
    {
        _banbanVoiceWindow?.Shutdown();
        _shoutPreviewWindow?.Close();
        _island?.Dispose();
        await ReadingExperience.StopAsync();
        _readingReminders?.Stop();
        ReadingOfflineService.Stop();
        InstanceActivation.Stop();
        _automaticUpdateCancellation?.Cancel();
        _automaticUpdateCancellation?.Dispose();
        _tray?.Dispose();
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
                    await CheckForUpdateAsync(false, config, token);
                    await Task.Delay(TimeSpan.FromMinutes(30), token);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }, token);
    }

    private async Task CheckForUpdateAsync(bool userInitiated, ReceiverConfig? knownConfig = null, CancellationToken token = default)
    {
        if (Interlocked.Exchange(ref _updateInProgress, 1) != 0)
        {
            if (userInitiated) SetUpdateState("正在检查更新，请稍候…", true);
            return;
        }

        try
        {
            if (ReadingExperience.IsOpen)
            {
                if (userInitiated) SetUpdateState("早读结束后再更新，活动不会中断。", false);
                return;
            }
            var config = knownConfig;
            if (config is null && !ReceiverConfig.TryLoad(out config))
            {
                if (userInitiated) SetUpdateState("请先完成教室绑定，再检查更新。", false);
                return;
            }

            SetUpdateState("正在检查更新…", true);
            var progress = new Progress<int>(value => SetUpdateState($"正在下载更新：{value}%", true));
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(token);
            void PauseDownload() => idle.Cancel();
            ReceiverUpdateResult result;
            ReadingExperience.Opened += PauseDownload;
            try
            {
                // A reading window may have opened between the first check and subscribing.
                if (await Dispatcher.UIThread.InvokeAsync(() => ReadingExperience.IsOpen)) idle.Cancel();
                result = await _updates.CheckAndDownloadAsync(config, progress, idle.Token);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested && idle.IsCancellationRequested)
            {
                SetUpdateState("早读已开始，更新已暂停，下次继续下载。", false);
                return;
            }
            finally { ReadingExperience.Opened -= PauseDownload; }
            if (!result.UpdateAvailable)
            {
                SetUpdateState($"当前已是最新版本 {ReceiverUpdateService.CurrentVersionText}", false);
                return;
            }

            await Dispatcher.UIThread.InvokeAsync(() =>
            {
                token.ThrowIfCancellationRequested();
                // Reading windows are created on this same dispatcher. Keep this final check,
                // installer launch and shutdown together so a lesson cannot start between them.
                if (ReadingExperience.IsOpen)
                {
                    SetUpdateState($"新版 {result.Version} 已保存，早读结束后更新。", false);
                    return;
                }
                if (!_updates.TryLaunchInstaller(result, out var error))
                {
                    SetUpdateState(error, false);
                    return;
                }
                _exitRequested = true;
                _desktop?.TryShutdown();
            });
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception exception)
        {
            AppLog.Error("Receiver update check failed", exception);
            SetUpdateState(userInitiated ? $"更新失败：{exception.Message}" : $"检查更新失败，稍后自动重试", false);
        }
        finally
        {
            Interlocked.Exchange(ref _updateInProgress, 0);
        }
    }

    private void SetUpdateState(string text, bool checking)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            _enrollmentWindow?.SetUpdateState(text, checking);
        });
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

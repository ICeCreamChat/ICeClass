using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Media.Imaging;
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
    private NativeMenuItem? _updateMenuItem;
    private Bitmap? _trayIconBitmap;
    private EnrollmentWindow? _enrollmentWindow;
    private StudentVoiceWindow? _studentVoiceWindow;
    private AboutWindow? _aboutWindow;
    private ReadingReminderService? _readingReminders;
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
        ReadingExperience.Configure(ShowStudentVoice, () => _studentVoiceWindow?.MinimizeToTray());
        _receiver.ConnectionStateChanged += ReceiverOnConnectionStateChanged;
        _receiver.BindingChanged += (_, binding) => Dispatcher.UIThread.Post(() => { _studentVoiceWindow?.SetBinding(binding); ReadingExperience.BindingChanged(binding); });
        CreateTray();
        DesktopShortcut.EnsureCreated();
        InstanceActivation.Listen(() => Dispatcher.UIThread.Post(ShowStudentVoice));
        ReceiverUpdateService.ConfirmUpdatedLaunch();
        desktop.Exit += async (_, _) => await ShutdownAsync();

        if (ReceiverConfig.TryLoad(out var config))
        {
            StartupManager.SetEnabled(config);
            _ = _receiver.StartAsync(config);
            _readingReminders.Start(config);
            StartAutomaticUpdates(config);
            // Keep the student entry point visible on classroom screens so nobody has to find the tray menu.
            if (!(desktop.Args?.Contains("--background") ?? false)) Dispatcher.UIThread.Post(ShowStudentVoice);
        }
        else
        {
            ShowEnrollment();
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void CreateTray()
    {
        _trayIconBitmap = new Bitmap(AppIconFactory.CreateBitmapStream());
        var menu = new NativeMenu();
        _statusMenuItem = new NativeMenuItem { Header = "状态：等待连接", Icon = _trayIconBitmap };
        _statusMenuItem.Click += (_, _) => ShowEnrollment();
        menu.Items.Add(_statusMenuItem);
        var setup = new NativeMenuItem { Header = "打开绑定设置" };
        setup.Click += (_, _) => ShowEnrollment();
        menu.Items.Add(setup);
        var studentVoice = new NativeMenuItem { Header = "打开教室首页" };
        studentVoice.Click += (_, _) => ShowStudentVoice();
        menu.Items.Add(studentVoice);
        var reading = new NativeMenuItem { Header = "打开早读陪伴" };
        reading.Click += async (_, _) =>
        {
            if (!ReceiverConfig.TryLoad(out var current)) { ShowEnrollment(); return; }
            try { await ClassroomControlService.OpenReadingAsync(current); }
            catch (Exception error) { AppLog.Error("Open reading failed", error); ShowStudentVoice(); }
        };
        menu.Items.Add(reading);
        var test = new NativeMenuItem { Header = "本机测试" };
        test.Click += async (_, _) => await TestAsync();
        menu.Items.Add(test);
        _updateMenuItem = new NativeMenuItem { Header = $"检查更新（当前 {ReceiverUpdateService.CurrentVersionText}）" };
        _updateMenuItem.Click += async (_, _) => await CheckForUpdateAsync(true);
        menu.Items.Add(_updateMenuItem);
        var about = new NativeMenuItem { Header = "关于班伴" };
        about.Click += (_, _) =>
        {
            if (_aboutWindow is null)
            {
                _aboutWindow = new AboutWindow();
                _aboutWindow.Closed += (_, _) => _aboutWindow = null;
            }
            _aboutWindow.Show(); _aboutWindow.WindowState = WindowState.Normal; _aboutWindow.Activate();
        };
        menu.Items.Add(about);
        menu.Items.Add(new NativeMenuItemSeparator());
        var exit = new NativeMenuItem { Header = "退出" };
        exit.Click += async (_, _) => await ExitAsync();
        menu.Items.Add(exit);
        _tray = new TrayIcon { Icon = new WindowIcon(AppIconFactory.CreateStream()), ToolTipText = "ICeClass · 班伴", Menu = menu, IsVisible = true };
        _tray.Clicked += (_, _) => ShowStudentVoice();
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
        _enrollmentWindow.Saved += async (_, saved) =>
        {
            await ReadingExperience.StopAsync();
            await _receiver!.RestartAsync(saved);
            _readingReminders?.Start(saved);
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

    private async Task TestAsync()
    {
        if (_receiver is null) return;
        await _receiver.ShowTestAsync();
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
        _studentVoiceWindow = new StudentVoiceWindow(config, audio => _receiver?.SendStudentVoiceAsync(config, audio) ?? Task.FromException(new InvalidOperationException("教室端尚未启动。")), () => ClassroomControlService.OpenReadingAsync(config), ShowEnrollment);
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
        await ReadingExperience.StopAsync();
        _readingReminders?.Stop();
        InstanceActivation.Stop();
        _automaticUpdateCancellation?.Cancel();
        _automaticUpdateCancellation?.Dispose();
        _tray?.Dispose();
        _trayIconBitmap?.Dispose();
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
                    await Task.Delay(TimeSpan.FromHours(6), token);
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
            var config = knownConfig;
            if (config is null && !ReceiverConfig.TryLoad(out config))
            {
                if (userInitiated) SetUpdateState("请先完成教室绑定，再检查更新。", false);
                return;
            }

            SetUpdateState("正在检查更新…", true);
            var progress = new Progress<int>(value => SetUpdateState($"正在下载更新：{value}%", true));
            var result = await _updates.CheckAndDownloadAsync(config, progress, token);
            if (!result.UpdateAvailable)
            {
                SetUpdateState($"当前已是最新版本 {ReceiverUpdateService.CurrentVersionText}", false);
                return;
            }

            SetUpdateState($"新版 {result.Version} 已下载，程序即将自动重启…", true);
            if (!_updates.TryLaunchInstaller(result, out var error))
            {
                SetUpdateState(error, false);
                return;
            }
            await Task.Delay(500, token);
            await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(async () =>
            {
                _exitRequested = true;
                await ReadingExperience.StopAsync();
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
            if (_updateMenuItem is not null)
            {
                _updateMenuItem.Header = checking ? text : $"检查更新（{text}）";
                _updateMenuItem.IsEnabled = !checking;
            }
            _enrollmentWindow?.SetUpdateState(text, checking);
        });
    }

    private void ReceiverOnConnectionStateChanged(object? sender, ReceiverConnectionState state)
    {
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            if (_statusMenuItem is not null) _statusMenuItem.Header = $"状态：{state.Text}";
            _tray!.ToolTipText = state.Text;
            _lastConnectionState = state;
            _enrollmentWindow?.SetConnectionState(state);
            _studentVoiceWindow?.SetConnectionState(state);
        });
    }
}

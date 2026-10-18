using System.Diagnostics;
using System.IO.Pipes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

public sealed class App : Application
{
    private IClassicDesktopStyleApplicationLifetime _desktop = null!;
    private readonly CancellationTokenSource _lifetime = new();
    private TrayIcon? _tray;
    private DesktopWindow _window = null!;
    private bool _exiting;
    internal DesktopSettings Settings { get; private set; } = null!;
    internal bool HasTray => _tray is not null;
    internal static string DataDirectory => Program.Options.DataDirectory;
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is not IClassicDesktopStyleApplicationLifetime desktop) { base.OnFrameworkInitializationCompleted(); return; }
        _desktop = desktop; desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        Settings = DesktopSettings.Load(DataDirectory);
        if (Program.Options.Endpoint is not null) Settings.Endpoint = Program.Options.Endpoint;
        Directory.CreateDirectory(DataDirectory);
        _window = new DesktopWindow(this, Settings.Endpoint, main: true);
        desktop.MainWindow = _window;
        try
        {
            var menu = new NativeMenu();
            Add("打开 ICeClass 班伴 · 教师端", ShowWindow); Add("桌面设置", () => { ShowWindow(); _ = ShowSettingsAsync(); });
            Add("检查桌面更新", () => { ShowWindow(); _ = _window.CheckUpdatesAsync(); });
            menu.Items.Add(new NativeMenuItemSeparator()); Add("退出 ICeClass 班伴 · 教师端", Exit);
            _tray = new TrayIcon { Icon = new WindowIcon(AppIconFactory.CreateStream()), ToolTipText = "ICeClass 班伴 · 教师端", Menu = menu, IsVisible = true };
            _tray.Clicked += (_, _) => ShowWindow();
            TrayIcon.SetIcons(this, new TrayIcons { _tray });
            void Add(string title, Action action) { var item = new NativeMenuItem { Header = title }; item.Click += (_, _) => action(); menu.Items.Add(item); }
        }
        catch (Exception error) { DesktopLog.Write(error); }
        _ = ListenAsync();
        desktop.Exit += (_, _) => { _lifetime.Cancel(); _tray?.Dispose(); _window.DisposePage(); };
        Dispatcher.UIThread.Post(DesktopUpdates.ConfirmLaunch);
        base.OnFrameworkInitializationCompleted();
    }

    internal void ShowWindow()
    {
        _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.RestorePage(); _window.Activate();
    }

    private async Task ListenAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(Program.InstanceName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(_lifetime.Token);
                using var request = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token); request.CancelAfter(TimeSpan.FromSeconds(4));
                var data = new byte[1];
                if (await pipe.ReadAsync(data, request.Token) == 1 && data[0] == 1) Dispatcher.UIThread.Post(ShowWindow);
            }
            catch (OperationCanceledException) { }
            catch (IOException) { if (!_lifetime.IsCancellationRequested) await Task.Delay(500); }
        }
    }

    internal async Task ShowSettingsAsync()
    {
        var editor = new SettingsWindow(Settings);
        var updated = await editor.ShowDialog<DesktopSettings?>(_window);
        if (updated is null) return;
        var changedServer = updated.Endpoint != Settings.Endpoint;
        if (changedServer && !await Dialogs.Confirm(_window, "切换学校平台？", "工作台将重新打开。请先保存尚未提交的内容；原平台的登录资料会保留。", "保存并重新打开")) return;
        try
        {
            updated.Save(DataDirectory); Settings = updated;
            if (changedServer) Restart(preserveEndpoint: false);
            else _window.SetStatus("桌面设置已保存");
        }
        catch (Exception error) { DesktopLog.Write(error); await Dialogs.Message(_window, "设置未保存", "请确认当前 Windows 账号可以写入本机用户文件夹，再重试。"); }
    }

    internal void Restart(bool preserveEndpoint = true)
    {
        if (_exiting) return;
        // Wait for the current process to release the single-instance mutex.
        var restart = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        restart.ArgumentList.Add("-NoProfile"); restart.ArgumentList.Add("-Command");
        var executable = Environment.ProcessPath!.Replace("'", "''");
        var resumeArguments = Program.Options.RestartArguments(preserveEndpoint);
        var extra = resumeArguments.Length > 0 ? " -ArgumentList '" + resumeArguments.Replace("'", "''") + "'" : "";
        restart.ArgumentList.Add($"Wait-Process -Id {Environment.ProcessId} -ErrorAction SilentlyContinue; Start-Process -WindowStyle Hidden -FilePath '{executable}'{extra}");
        Process.Start(restart); Exit();
    }

    internal bool ExitRequested => _exiting;
    internal void Exit() { if (_exiting) return; _exiting = true; _lifetime.Cancel(); _window.DisposePage(); _desktop.Shutdown(); }
}

internal static class DesktopLog
{
    internal static void Write(Exception error)
    {
        try { Directory.CreateDirectory(App.DataDirectory); File.AppendAllText(Path.Combine(App.DataDirectory, "desktop.log"), $"{DateTimeOffset.Now:O} {error}\n"); }
        catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

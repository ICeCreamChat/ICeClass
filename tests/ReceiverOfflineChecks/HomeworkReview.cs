using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

/// <summary>Open the actual classroom windows with an explicit isolated loopback binding.</summary>
internal static class HomeworkReview
{
    internal static void Run(string bindingPath, bool compact = false)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var config) || !ReceiverConfig.IsPreview(config))
            throw new InvalidOperationException("Homework review requires an explicit loopback preview binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(_ => Dispatcher.UIThread.Post(() => Open(config, compact)))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static void Open(ReceiverConfig config, bool compact)
    {
        var home = new StudentVoiceWindow(config, _ => Task.FromException(new InvalidOperationException("本地作业验收未启用录音发送。")));
        if (compact) { home.Width = 720; home.Height = 520; }
        home.Title += " · 作业统计本地验收";
        home.SetConnectionState(new ReceiverConnectionState(true, "已连接本地验收"));
        var lifetime = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        lifetime.MainWindow = home;
        var canClose = false;
        home.Closing += async (_, args) => {
            if (canClose) return;
            args.Cancel = true;
            if (await home.PrepareToLeaveAsync()) {canClose = true;home.Close();}
        };
        home.Show(); home.Activate();
    }
}

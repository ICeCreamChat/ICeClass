using Avalonia;
using ICeClass.Updates;

namespace ICeClass.Receiver;

internal static class Program
{
    private static Mutex? _singleInstance;

    [STAThread]
    public static void Main(string[] args)
    {
        if (args is ["--banban-computer-worker"]) { ClassroomAgentWorker.Run(); return; }
        _singleInstance = new Mutex(true, "ICeClass.Receiver.SingleInstance", out var isFirstInstance);
        if (!isFirstInstance) { InstanceActivation.NotifyRunningInstance(args.Contains("--island-demo"), args.Contains("--island-shout-preview")); _singleInstance.Dispose(); return; }
        try
        {
            try
            {
                // Only startup skips the helper's own confirmation launch. Later manual updates remain available.
                if (!UpdateInstaller.IsUpdateLaunch && UpdateInstaller.TryLaunchPending(AppContext.BaseDirectory,
                    "ICeClass.exe", ReceiverUpdateService.RestartArguments(), ReceiverUpdateService.CurrentVersionText)) return;
            }
            catch (Exception error) { AppLog.Error("Could not apply prepared update at startup", error); }
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        finally { _singleInstance.ReleaseMutex(); _singleInstance.Dispose(); }
    }

    private static AppBuilder BuildAvaloniaApp()
    {
        return AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
    }
}

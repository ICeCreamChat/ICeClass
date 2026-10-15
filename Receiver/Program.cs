using Avalonia;

namespace ICeClass.Receiver;

internal static class Program
{
    private static Mutex? _singleInstance;

    [STAThread]
    public static void Main(string[] args)
    {
        _singleInstance = new Mutex(true, "ICeClass.Receiver.SingleInstance", out var isFirstInstance);
        if (!isFirstInstance) { InstanceActivation.NotifyRunningInstance(); _singleInstance.Dispose(); return; }
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        _singleInstance.ReleaseMutex();
        _singleInstance.Dispose();
    }

    private static AppBuilder BuildAvaloniaApp()
    {
        return AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
    }
}

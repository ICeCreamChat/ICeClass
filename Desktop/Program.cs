using Avalonia;
using System.IO.Pipes;
using ICeClass.Updates;

namespace ICeClass.Desktop;

internal static class Program
{
    internal static LaunchOptions Options { get; private set; } = null!;
    private static Mutex? _instance;
    internal static string InstanceName => "ICeClass.Desktop." + Environment.UserName + (Options.Review ? ".Review" : "");
    [STAThread]
    public static void Main(string[] args)
    {
        Options = LaunchOptions.Parse(args);
        _instance = new Mutex(true, @"Local\" + InstanceName, out var first);
        if (!first)
        {
            try { using var pipe = new NamedPipeClientStream(".", InstanceName, PipeDirection.Out, PipeOptions.CurrentUserOnly); pipe.Connect(2500); pipe.WriteByte(1); }
            catch (IOException) { } catch (TimeoutException) { }
            _instance.Dispose(); return;
        }
        try
        {
            try
            {
                if (UpdateInstaller.TryLaunchPending(AppContext.BaseDirectory,
                    "ICeClass.Desktop.exe", Options.RestartArguments(), DesktopUpdates.CurrentVersion)) return;
            }
            catch (Exception error) { DesktopLog.Write(error); }
            AppBuilder.Configure<App>().UsePlatformDetect().LogToTrace().StartWithClassicDesktopLifetime(args);
        }
        finally { _instance.ReleaseMutex(); _instance.Dispose(); }
    }
}

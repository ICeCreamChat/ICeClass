using Avalonia;
using Avalonia.Threading;
using ICeClass.Updates;
using System.Runtime.InteropServices;

namespace ICeClass.Receiver;

internal static class Program
{
    internal const string PaperClassroom = "--paper-classroom";
    internal static ReceiverConfig? PaperBinding { get; private set; }
    internal static string? PaperPreferencePath { get; private set; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr owner, string text, string title, uint type);

    private static bool IsUpdateArgument(string value) =>
        value == "--incremental-update-started" || value.StartsWith("--update-marker=", StringComparison.Ordinal);

    [STAThread]
    public static void Main(string[] args)
    {
        if (args is ["--banban-computer-worker"]) { ClassroomAgentWorker.Run(); return; }
        var launchArgs = args.Where(value => !IsUpdateArgument(value)).ToArray();
        var confirmingUpdate = launchArgs.Length != args.Length;
        var openPaper = launchArgs.Contains(PaperClassroom);
        if (openPaper && launchArgs is not [PaperClassroom])
        {
            if (launchArgs is not [PaperClassroom, var bindingFile] || bindingFile.StartsWith("--", StringComparison.Ordinal) ||
                !ReceiverConfig.TryRead(bindingFile, out var binding) ||
                string.IsNullOrWhiteSpace(binding.ClassId))
            {
                MessageBoxW(IntPtr.Zero, "无法读取这台白板的班级绑定。请检查纸卡课堂快捷方式。", "班班 · 纸卡课堂", 0x10);
                Environment.ExitCode = 2;
                return;
            }
            if (!ReceiverConfig.CanUseDefaultBinding(binding))
            {
                var key = CardQuizService.BindingKey(binding);
                PaperBinding = binding;
                PaperPreferencePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ICeClass", "CardQuiz", key, "banban-pet.json");
                InstanceActivation.Scope = "." + key;
            }
        }
        using var instance = new Mutex(false, "ICeClass.Receiver.SingleInstance" + InstanceActivation.Scope);
        if (!InstanceActivation.AcquireOrNotify(instance, launchArgs.Contains("--island-demo"), launchArgs.Contains("--island-shout-preview"), openPaper))
            return;
        try
        {
            try
            {
                // Only startup skips the helper's own confirmation launch. Later manual updates remain available.
                if (PaperBinding is null && !confirmingUpdate && UpdateInstaller.TryLaunchPending(AppContext.BaseDirectory,
                    "ICeClass.exe", ReceiverUpdateService.RestartArguments(), ReceiverUpdateService.CurrentVersionText)) return;
            }
            catch (Exception error) { AppLog.Error("Could not apply prepared update at startup", error); }
            var app = BuildAvaloniaApp();
            if (PaperBinding is not null && confirmingUpdate)
            {
                // The isolated paper classroom skips the daily client's update-confirmation hooks.
                app.AfterSetup(_ => Dispatcher.UIThread.Post(() =>
                {
                    ReceiverUpdateService.ConfirmUpdatedLaunch();
                    UpdateInstaller.ConfirmLaunch(AppContext.BaseDirectory);
                }, DispatcherPriority.Background));
            }
            app.StartWithClassicDesktopLifetime(args);
        }
        finally { instance.ReleaseMutex(); }
    }

    private static AppBuilder BuildAvaloniaApp()
    {
        return AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .LogToTrace();
    }
}

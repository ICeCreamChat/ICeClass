using Microsoft.Win32;

namespace ICeClass.Receiver;

internal static class StartupManager
{
    private const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    private const string ValueName = "ICeClass";

    public static void SetEnabled(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
            if (key is null) return;
            // Migrate a receiver replaced in the same folder; a separate old platform keeps its startup entry.
            foreach (var legacyName in new[] { "ICeCreamShouter", "CloudRemoteShouter" })
            {
                var command = key.GetValue(legacyName) as string;
                if (string.IsNullOrWhiteSpace(command)) continue;
                var executable = command.StartsWith('"') ? command.Split('"')[1] : command.Split(' ')[0];
                var directory = Path.GetDirectoryName(Path.GetFullPath(executable));
                if (string.Equals(directory, AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    key.DeleteValue(legacyName, false);
            }
            if (enabled)
            {
                var path = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "ICeClass.exe");
                key.SetValue(ValueName, $"\"{path}\" --background");
            }
            else key.DeleteValue(ValueName, false);
        }
        catch { }
    }
}

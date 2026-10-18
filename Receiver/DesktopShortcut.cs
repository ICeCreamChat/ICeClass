using System.Runtime.InteropServices;

namespace ICeClass.Receiver;

internal static class DesktopShortcut
{
    public static void EnsureCreated()
    {
        if (!OperatingSystem.IsWindows()) return;
        object? shell = null, shortcut = null;
        try
        {
            var executable = Environment.ProcessPath;
            if (executable is null || !string.Equals(Path.GetFileName(executable), "ICeClass.exe", StringComparison.OrdinalIgnoreCase)) return;
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (string.IsNullOrWhiteSpace(desktop) || !Directory.Exists(desktop)) return;
            var path = Path.Combine(desktop, "ICeClass 班伴 教室端.lnk");
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type is null) return;
            shell = Activator.CreateInstance(type);
            if (shell is null) return;
            var previousPath = Path.Combine(desktop, "班伴教室端.lnk");
            if (!File.Exists(path) && File.Exists(previousPath))
            {
                var previous = ((dynamic)shell).CreateShortcut(previousPath);
                try
                {
                    var target = (string)previous.TargetPath;
                    if (!string.IsNullOrWhiteSpace(target) && string.Equals(Path.GetFullPath(target), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase))
                        File.Move(previousPath, path);
                }
                finally { if (Marshal.IsComObject(previous)) Marshal.FinalReleaseComObject(previous); }
            }
            shortcut = ((dynamic)shell).CreateShortcut(path);
            // A similarly named shortcut for another application belongs to the user.
            var original = (string)((dynamic)shortcut).TargetPath;
            if (!string.IsNullOrWhiteSpace(original) && !string.Equals(Path.GetFileName(original), "ICeClass.exe", StringComparison.OrdinalIgnoreCase)) return;
            ((dynamic)shortcut).TargetPath = executable;
            ((dynamic)shortcut).WorkingDirectory = AppContext.BaseDirectory;
            ((dynamic)shortcut).Description = "ICeClass 班伴 · 教室端 · 早读陪伴与班级通知";
            ((dynamic)shortcut).IconLocation = GetShortcutIcon(executable);
            ((dynamic)shortcut).Save();
        }
        catch (Exception error) { AppLog.Error("Create classroom desktop shortcut failed", error); }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }

    private static string GetShortcutIcon(string executable)
    {
        try
        {
            // A separate icon path also refreshes shortcuts cached from older EXEs.
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "icons");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "app-icon-rounded.ico");
            using var input = AppIconFactory.CreateStream();
            using (var output = File.Create(path)) input.CopyTo(output);
            return path + ",0";
        }
        catch (Exception error)
        {
            AppLog.Error("Prepare desktop shortcut icon failed", error);
            return executable + ",0";
        }
    }
}

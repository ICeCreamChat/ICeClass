using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace ICeClass.Receiver;

internal sealed record AgentApplication(string Id, string Name, string Kind, string Path, string? RuntimePath = null)
{
    internal bool MatchesPath(string path) => string.Equals(ClassroomAgentPolicy.ApplicationPath(Path), path, StringComparison.OrdinalIgnoreCase)
        || RuntimePath is not null && string.Equals(ClassroomAgentPolicy.ApplicationPath(RuntimePath), path, StringComparison.OrdinalIgnoreCase);
}

internal sealed record AgentFolder(string Name, string Path);

internal sealed class ClassroomAgentPolicy
{
    public bool Enabled { get; set; } = true;
    public bool AllowInteraction { get; set; } = true;
    // Older settings without this option use the classroom default; explicit false is preserved.
    public bool AllowAllFolders { get; set; } = true;
    public List<string> Applications { get; set; } = [];
    public List<string> Folders { get; set; } = [];
    internal static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "ComputerControl");
    private static string Location => Path.Combine(Root, "settings.json");
    internal static ClassroomAgentPolicy Load()
    {
        try
        {
            if (File.Exists(Location)) return JsonSerializer.Deserialize<ClassroomAgentPolicy>(File.ReadAllText(Location)) ?? new() { Enabled = false };
        }
        catch (Exception error) { AppLog.Error("Read computer control settings", error); return new() { Enabled = false }; }
        return new() { Folders = new[] { Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.DesktopDirectory }
            .Select(f => Path.Combine(Environment.GetFolderPath(f), "课件")).Where(Directory.Exists).ToList() };
    }

    internal void Save()
    {
        Applications = Applications.Where(p => Path.IsPathFullyQualified(p) && File.Exists(p) && Path.GetExtension(p).Equals(".exe", StringComparison.OrdinalIgnoreCase))
            .Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).Take(100).ToList();
        Folders = Folders.Where(p => Path.IsPathFullyQualified(p) && Directory.Exists(p)).Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase).Take(30).ToList();
        Directory.CreateDirectory(Root);
        var pending = Location + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(pending, JsonSerializer.Serialize(this));
        File.Move(pending, Location, true);
    }

    internal static string Identity(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value.ToLowerInvariant())))[..24];
    internal static string ApplicationPath(string path)
    {
        var full = Path.GetFullPath(path);
        var buffer = new StringBuilder(1024);
        var length = GetLongPathName(full, buffer, buffer.Capacity);
        if (length >= buffer.Capacity)
        {
            buffer.EnsureCapacity(checked((int)length + 1));
            length = GetLongPathName(full, buffer, buffer.Capacity);
        }
        return length > 0 ? buffer.ToString() : full;
    }

    private static string? RegisteredRuntime(string launcher)
    {
        if (!Path.GetFileName(launcher).Equals("swenlauncher.exe", StringComparison.OrdinalIgnoreCase)) return null;
        var root = Path.GetDirectoryName(Path.GetDirectoryName(launcher))! + Path.DirectorySeparatorChar;
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        foreach (var location in new[] { @"SOFTWARE\Seewo\EasiNote5", @"SOFTWARE\WOW6432Node\Seewo\EasiNote5" })
        {
            try
            {
                using var key = hive.OpenSubKey(location);
                if (key?.GetValue("ActualExePath") is not string value) continue;
                value = value.Trim('"');
                if (!Path.IsPathFullyQualified(value) || !File.Exists(value)) continue;
                var candidate = ApplicationPath(value);
                // Only the installed whiteboard executable in this launcher's
                // own package is an alias. Unrelated child processes are not.
                if (candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                    && Path.GetFileName(candidate).Equals("EasiNote.exe", StringComparison.OrdinalIgnoreCase)) return candidate;
            }
            catch (System.Security.SecurityException) { }
        }
        return null;
    }
    internal static string Kind(string path) => Path.GetFileNameWithoutExtension(path).ToLowerInvariant() switch
    {
        "powerpnt" => "powerpoint", "winword" => "word", "excel" => "excel", "wpp" => "wps-presentation", "wps" => "wps-writer", "et" => "wps-sheet",
        "easinote" or "easinote5" or "swenlauncher" or "en5" => "seewo",
        "msedge" or "chrome" or "firefox" => "browser", _ => "application"
    };

    internal IReadOnlyList<AgentApplication> Available(ReceiverConfig? binding = null)
    {
        var paths = new HashSet<string>(Applications, StringComparer.OrdinalIgnoreCase);
        if (binding is not null)
        {
            try
            {
                var island = new IslandLocalStore(IslandLocalStore.RootFor(binding)).Read<IslandLocalSettings>("local-settings.json");
                foreach (var path in island?.AllowedApplications ?? []) paths.Add(path);
            }
            catch (Exception error) { AppLog.Error("Read allowed classroom applications", error); }
        }
        // App Paths is Windows' standard installed-application catalogue. It
        // lets unfamiliar registered desktop apps use the same UIA executor.
        // Launch arguments and executable names still never come from the LLM.
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        foreach (var prefix in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths" })
        {
            try
            {
                using var catalogue = hive.OpenSubKey(prefix);
                if (catalogue is null) continue;
                foreach (var exe in catalogue.GetSubKeyNames().Where(name => name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)).Take(150))
                {
                    using var key = catalogue.OpenSubKey(exe);
                    if (key?.GetValue("") is string path) paths.Add(Environment.ExpandEnvironmentVariables(path.Trim('"')));
                }
            }
            catch (System.Security.SecurityException) { }
        }
        foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) })
        foreach (var relative in new[] { @"Microsoft\Edge\Application\msedge.exe", @"Google\Chrome\Application\chrome.exe", @"Mozilla Firefox\firefox.exe",
            @"Microsoft Office\root\Office16\POWERPNT.EXE", @"Seewo\EasiNote5\swenlauncher\swenlauncher.exe", @"Seewo\EasiNote\EasiNote.exe" })
            paths.Add(Path.Combine(folder, relative));
        // WPS often registers only wps.exe although its other editors sit beside it.
        foreach (var path in paths.Where(p => Kind(p).StartsWith("wps-", StringComparison.Ordinal)).ToArray())
            foreach (var exe in new[] { "wps.exe", "wpp.exe", "et.exe" }) paths.Add(Path.Combine(Path.GetDirectoryName(path)!, exe));
        return paths.Where(p => Path.IsPathFullyQualified(p) && Path.GetExtension(p).Equals(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
            .Select(ApplicationPath).Distinct(StringComparer.OrdinalIgnoreCase).Take(80).Select(p =>
            {
                var info = FileVersionInfo.GetVersionInfo(p);
                var name = string.IsNullOrWhiteSpace(info.ProductName) ? Path.GetFileNameWithoutExtension(p) : info.ProductName;
                var kind = Kind(p);
                name = kind switch { "powerpoint" => "PowerPoint", "word" => "Word", "excel" => "Excel",
                    "wps-presentation" => "WPS 演示", "wps-writer" => "WPS 文字", "wps-sheet" => "WPS 表格", "seewo" => "希沃白板", _ => name };
                return new AgentApplication(Identity(p), name[..Math.Min(name.Length, 80)], kind, p, RegisteredRuntime(p));
            }).GroupBy(a => a.RuntimePath ?? a.Path, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.OrderByDescending(a => a.RuntimePath is not null).First()).ToList();
    }

    internal static readonly HashSet<string> DocumentExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".ppt", ".pptx", ".pps", ".ppsx", ".dps", ".dpt", ".doc", ".docx", ".wps", ".xls", ".xlsx", ".et", ".pdf", ".enb", ".enbx", ".enpx", ".mp4", ".mp3", ".wav", ".png", ".jpg", ".jpeg", ".txt" };

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetLongPathName(string path, StringBuilder buffer, int capacity);

    internal IReadOnlyList<AgentFolder> FileLocations()
    {
        var locations = new List<AgentFolder>();
        if (AllowAllFolders)
        {
            foreach (var (name, special) in new[] { ("桌面", Environment.SpecialFolder.DesktopDirectory),
                ("文档", Environment.SpecialFolder.MyDocuments), ("图片", Environment.SpecialFolder.MyPictures),
                ("音乐", Environment.SpecialFolder.MyMusic), ("视频", Environment.SpecialFolder.MyVideos) })
                locations.Add(new(name, Environment.GetFolderPath(special)));
            var downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            using (var shell = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"))
                if (shell?.GetValue("{374DE290-123F-4565-9164-39C4925E467B}") is string redirected)
                    downloads = Environment.ExpandEnvironmentVariables(redirected);
            locations.Add(new("下载", downloads));
        }
        locations.AddRange(Folders.Where(Path.IsPathFullyQualified).Select(p => new AgentFolder(Path.GetFileName(p.TrimEnd('\\')), Path.GetFullPath(p))));
        // Search known user and configured folders before broad drive roots.
        if (AllowAllFolders)
            foreach (var drive in DriveInfo.GetDrives())
            {
                try { if (drive.IsReady) locations.Add(new(drive.Name, drive.RootDirectory.FullName)); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        return locations.Where(l => Directory.Exists(l.Path)).DistinctBy(l => l.Path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    internal string ResolveFolder(string value)
    {
        value = value.Trim();
        var aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            ["desktop"] = "桌面", ["documents"] = "文档", ["downloads"] = "下载", ["pictures"] = "图片", ["music"] = "音乐", ["videos"] = "视频" };
        var name = aliases.GetValueOrDefault(value, value);
        var known = FileLocations().FirstOrDefault(l => string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
        return known?.Path ?? value;
    }

    private static bool OrdinaryPath(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\?\", StringComparison.Ordinal) || path.StartsWith(@"\\.\", StringComparison.Ordinal)) return false;
        var root = Path.GetPathRoot(path)!;
        return !path[root.Length..].Contains(':') && !path.Any(char.IsControl);
    }

    internal bool FolderAllowed(string path) => OrdinaryPath(path) && Directory.Exists(path) && WithinScope(new DirectoryInfo(Path.GetFullPath(path)));
    internal bool FileVisible(string path) => OrdinaryPath(path) && File.Exists(path)
        && (AllowAllFolders || DocumentExtensions.Contains(Path.GetExtension(path))) && WithinScope(new FileInfo(Path.GetFullPath(path)));
    internal bool FileAllowed(string path) => DocumentExtensions.Contains(Path.GetExtension(path)) && FileVisible(path);

    private bool WithinScope(FileSystemInfo item)
    {
        if (AllowAllFolders) return true;
        var full = item.FullName;
        foreach (var configured in Folders.Where(Path.IsPathFullyQualified))
        {
            var root = Path.GetFullPath(configured).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && !string.Equals(full.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) continue;
            // A junction/symlink in an allowed folder must not escape that folder.
            FileSystemInfo? entry = item;
            while (entry is not null && !string.Equals(entry.FullName.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) return false;
                entry = entry is FileInfo file ? file.Directory : ((DirectoryInfo)entry).Parent;
            }
            return entry is not null && (entry.Attributes & FileAttributes.ReparsePoint) == 0;
        }
        return false;
    }
}

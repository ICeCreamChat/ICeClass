using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ICeClass.Receiver;

internal sealed record ClassroomPluginManifest(int SchemaVersion, string Id, string Name, string Version,
    int HostApiVersion, string Runtime, string EntryPoint);
internal sealed record ClassroomPluginInstallation(ClassroomPluginManifest Manifest, bool Enabled);

/// <summary>Only the local VideoBooth package is supported. Personal booth data lives outside this tree.</summary>
internal sealed class ClassroomPluginPackage(string root, string runtime)
{
    internal const string PluginId = "iceclass.video-booth";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, MaxDepth = 8 };
    private readonly string _root = Path.GetFullPath(root);
    private string InstalledDirectory => Path.Combine(_root, PluginId);
    private string StatePath => Path.Combine(_root, "video-booth-state.json");
    private const long MaximumArchiveBytes = 2L * 1024 * 1024 * 1024;
    private const long MaximumExpandedBytes = 3L * 1024 * 1024 * 1024;

    internal ClassroomPluginInstallation? Read()
    {
        AssertNoLinks(_root);
        if (!Directory.Exists(InstalledDirectory)) return null;
        AssertTree(InstalledDirectory);
        var manifest = ParseManifest(File.ReadAllBytes(Path.Combine(InstalledDirectory, "plugin.json")));
        if (!File.Exists(StatePath)) throw new InvalidDataException("插件安装登记不完整，请卸载后重新安装。");
        using var state = JsonDocument.Parse(File.ReadAllBytes(StatePath));
        return new(manifest, state.RootElement.GetProperty("enabled").GetBoolean());
    }

    internal string EntryPoint()
    {
        var installation = Read() ?? throw new InvalidOperationException("请先安装视频展台插件。");
        var path = SafePath(InstalledDirectory, installation.Manifest.EntryPoint);
        if (!File.Exists(path)) throw new InvalidDataException("插件运行文件缺失，请卸载后重新安装。");
        return path;
    }

    internal ClassroomPluginManifest Inspect(string archivePath)
    {
        using var archive = Open(archivePath);
        return Inspect(archive);
    }

    internal async Task InstallAsync(ZipArchive archive, CancellationToken token)
    {
        AssertNoLinks(_root);
        if (Directory.Exists(InstalledDirectory)) throw new InvalidOperationException("此插件已安装，请先卸载再安装新包。展台资料会保留。");
        Directory.CreateDirectory(_root);
        var staging = Path.Combine(_root, ".install-" + Guid.NewGuid().ToString("N"));
        try
        {
            Inspect(archive);
            Directory.CreateDirectory(staging);
            foreach (var item in archive.Entries)
            {
                token.ThrowIfCancellationRequested();
                var destination = SafePath(staging, item.FullName);
                if (item.FullName.EndsWith('/') || item.FullName.EndsWith('\\')) { Directory.CreateDirectory(destination); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await using var source = item.Open();
                await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true);
                await source.CopyToAsync(output, token);
                if (output.Length != item.Length) throw new InvalidDataException("插件包文件长度不符。");
            }
            token.ThrowIfCancellationRequested();
            AssertTree(staging);
            Directory.Move(staging, InstalledDirectory);
            try { SaveState(false); }
            catch { AssertTree(InstalledDirectory); Directory.Delete(InstalledDirectory, true); throw; }
        }
        finally
        {
            if (Directory.Exists(staging)) { AssertTree(staging); Directory.Delete(staging, true); }
        }
    }

    internal void SetEnabled(bool enabled)
    {
        if (Read() is null) throw new InvalidOperationException("视频展台尚未安装。");
        SaveState(enabled);
    }

    internal void Uninstall()
    {
        AssertNoLinks(_root);
        if (Directory.Exists(InstalledDirectory)) { AssertTree(InstalledDirectory); Directory.Delete(InstalledDirectory, true); }
        if (File.Exists(StatePath)) File.Delete(StatePath);
    }

    private void SaveState(bool enabled)
    {
        AssertNoLinks(_root);
        var temporary = StatePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(new { enabled }, Json)); File.Move(temporary, StatePath, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    // Keep this read-only handle open from confirmation through installation.
    internal static ZipArchive Open(string path)
    {
        var file = new FileInfo(path);
        if (!file.Exists || file.Length is <= 0 or > MaximumArchiveBytes) throw new InvalidDataException("请选择有效的视频展台 ZIP 插件包。");
        return ZipFile.OpenRead(path);
    }

    private ClassroomPluginManifest ParseManifest(byte[] bytes)
    {
        if (bytes.Length is <= 0 or > 16384) throw new InvalidDataException("插件清单大小无效。");
        ClassroomPluginManifest? manifest;
        try { manifest = JsonSerializer.Deserialize<ClassroomPluginManifest>(bytes, Json); }
        catch (JsonException) { throw new InvalidDataException("插件清单格式无效。"); }
        if (manifest is null || manifest.SchemaVersion != 1 || manifest.HostApiVersion != 1 || manifest.Id != PluginId ||
            manifest.Name != "视频展台" || manifest.Runtime is not ("win-x64" or "win-x86") || manifest.Runtime != runtime ||
            manifest.Version is null || !System.Text.RegularExpressions.Regex.IsMatch(manifest.Version, @"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant) ||
            manifest.EntryPoint is null || !manifest.EntryPoint.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("插件清单或架构不适用于本机，请选择 " + runtime + " 视频展台包。");
        SafePath(_root, manifest.EntryPoint);
        return manifest;
    }

    internal ClassroomPluginManifest Inspect(ZipArchive archive)
    {
        if (archive.Entries.Count is 0 or > 12000) throw new InvalidDataException("插件包文件数量无效。");
        var entries = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        foreach (var item in archive.Entries)
        {
            var path = SafePath(_root, item.FullName);
            var relative = Path.GetRelativePath(_root, path);
            var directory = item.FullName.EndsWith('/') || item.FullName.EndsWith('\\');
            if (!entries.TryAdd(relative, directory)) throw new InvalidDataException("插件包包含重复文件名。");
            var kind = (item.ExternalAttributes >> 16) & 0xF000;
            if (kind is not (0 or 0x8000 or 0x4000) || (item.ExternalAttributes & 0x400) != 0)
                throw new InvalidDataException("插件包不能包含链接或特殊文件。");
            if (item.Length < 0 || (expanded = checked(expanded + item.Length)) > MaximumExpandedBytes)
                throw new InvalidDataException("插件包解压大小超出限制。");
            var parts = relative.Split(Path.DirectorySeparatorChar);
            if (parts.Any(p => p.Equals("data", StringComparison.OrdinalIgnoreCase) || p.Equals("preserved-data", StringComparison.OrdinalIgnoreCase) || p.Equals("User Data", StringComparison.OrdinalIgnoreCase)) ||
                Path.GetExtension(relative).ToLowerInvariant() is ".pfx" or ".p12" or ".pem" or ".key" or ".dpapi" or ".db" ||
                Path.GetFileName(relative).ToLowerInvariant() is "config.json" or "state.json" or "settings.json" or "video-booth-state.json")
                throw new InvalidDataException("插件包含个人资料、缓存或密钥，请使用干净的插件分发包。");
        }
        foreach (var entry in entries.Keys)
        {
            var parent = Path.GetDirectoryName(entry);
            while (!string.IsNullOrEmpty(parent))
            {
                if (entries.TryGetValue(parent, out var directory) && !directory) throw new InvalidDataException("插件包文件与目录冲突。");
                parent = Path.GetDirectoryName(parent);
            }
        }
        var manifestEntry = archive.GetEntry("plugin.json") ?? throw new InvalidDataException("插件包根目录缺少 plugin.json。");
        if (manifestEntry.Length > 16384) throw new InvalidDataException("插件清单过大。");
        using var source = manifestEntry.Open(); using var memory = new MemoryStream(); source.CopyTo(memory);
        var manifest = ParseManifest(memory.ToArray());
        var executable = archive.Entries.SingleOrDefault(e => string.Equals(e.FullName.Replace('/', '\\'), manifest.EntryPoint.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase));
        if (executable is null || executable.Length < 64) throw new InvalidDataException("插件入口不存在或不是有效的程序。");
        using var stream = executable.Open(); using var reader = new BinaryReader(stream);
        var header = reader.ReadBytes(64);
        if (header.Length != 64 || header[0] != 'M' || header[1] != 'Z') throw new InvalidDataException("插件入口不是 Windows 程序。");
        var offset = BitConverter.ToInt32(header, 60);
        if (offset < 64 || offset > Math.Min(executable.Length - 6, 1024 * 1024)) throw new InvalidDataException("插件程序头无效。");
        reader.ReadBytes(offset - 64);
        if (reader.ReadUInt32() != 0x4550 || reader.ReadUInt16() != (runtime == "win-x64" ? 0x8664 : 0x14C))
            throw new InvalidDataException("插件运行程序的架构与清单不符。");
        return manifest;
    }

    private static string SafePath(string directory, string value)
    {
        if (string.IsNullOrEmpty(value) || Path.IsPathRooted(value) || value.Contains(':')) throw new InvalidDataException("插件包含绝对路径。");
        var normalized = value.Replace('/', '\\').TrimEnd('\\');
        var parts = normalized.Split('\\');
        foreach (var part in parts)
        {
            var stem = part.Split('.')[0];
            if (part is "" or "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                System.Text.RegularExpressions.Regex.IsMatch(stem, @"^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new InvalidDataException("插件包含不安全或重复解释的路径。");
        }
        var resolved = Path.GetFullPath(Path.Combine(directory, normalized));
        if (!resolved.StartsWith(Path.GetFullPath(directory).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("插件路径越过安装目录。");
        return resolved;
    }

    private static void AssertNoLinks(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("插件目录不能包含符号链接或目录联接。");
    }
    private static void AssertTree(string path)
    {
        AssertNoLinks(path);
        foreach (var child in Directory.EnumerateFileSystemEntries(path))
        {
            var attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("插件文件包含链接，请先恢复原安装文件。");
            if ((attributes & FileAttributes.Directory) != 0) AssertTree(child);
        }
    }
}

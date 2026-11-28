using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using ICeClass.Updates;

namespace ICeClass.Receiver;

internal static class ClassroomWebViewPackage
{
    private sealed record Cabinet(string Version, long Size, string Sha256);

    internal const string UpdatePath = "VoiceResources/WebView2-x64.cab";
    private static readonly Cabinet Package = ReadManifest();
    private static readonly SemaphoreSlim Installation = new(1);
    private static readonly string[] RequiredFiles =
        ["msedgewebview2.exe", "msedge.dll", "icudtl.dat", "resources.pak", "locales/zh-CN.pak", "EBWebView/x64/EmbeddedBrowserWebView.dll"];
    private const string Marker = ".iceclass-cab-sha256";

    [DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string link, string existing, IntPtr securityAttributes);

    internal static string Version => Package.Version;

    private static Cabinet ReadManifest()
    {
        using var manifest = typeof(ClassroomWebViewPackage).Assembly.GetManifestResourceStream("ICeClass.Classroom.WebView2.json");
        return JsonSerializer.Deserialize<Cabinet>(manifest!, IncrementalUpdates.Json)!;
    }

    internal static async Task<string> EnsureAsync(string installDirectory, string? installerCab, CancellationToken token)
    {
        var target = IncrementalUpdates.SafePath(installDirectory, "WebView2/" + Package.Version);
        if (installerCab is null && Ready(target)) return target;

        await Installation.WaitAsync(token);
        try
        {
            if (installerCab is null && Ready(target)) return target;
            var cab = installerCab ?? IncrementalUpdates.SafePath(installDirectory, UpdatePath);
            if (!File.Exists(cab))
                throw new FileNotFoundException("找不到白板网页组件。", cab);
            var root = Path.GetDirectoryName(target)!;
            Directory.CreateDirectory(root);
            var lockFile = IncrementalUpdates.SafePath(root, ".install.lock");
            using var installLock = new FileStream(lockFile, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None);
            if (installerCab is null && Ready(target)) return target;

            // Publish a complete runtime by renaming a directory on the installation volume.
            var incoming = Path.Combine(root, "stage-" + Guid.NewGuid().ToString("N"));
            var previous = Path.Combine(root, "previous-" + Guid.NewGuid().ToString("N"));
            try
            {
                const string localCab = "WebView2-x64.cab";
                const string output = "expanded";
                // Keep out writers while expand.exe reads the verified cabinet.
                await using (var cabinet = File.OpenRead(cab))
                {
                    if (cabinet.Length != Package.Size ||
                        !Convert.ToHexString(await SHA256.HashDataAsync(cabinet, token)).Equals(Package.Sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("白板网页组件缺失或未通过完整性检查。");
                    if (Ready(target)) return target;
                    token.ThrowIfCancellationRequested();

                    Directory.CreateDirectory(Path.Combine(incoming, output));
                    var stagedCab = Path.Combine(incoming, localCab);
                    // expand.exe takes ANSI arguments. Pass ASCII names relative to its Unicode working directory.
                    if (!CreateHardLink(stagedCab, cab, IntPtr.Zero))
                    {
                        cabinet.Position = 0;
                        await using var copy = new FileStream(stagedCab, FileMode.CreateNew, FileAccess.Write,
                            FileShare.None, 1024 * 1024, FileOptions.Asynchronous);
                        await cabinet.CopyToAsync(copy, token);
                    }
                    await RunAsync("expand.exe", incoming, localCab, "-F:*", output);
                }
                var expandedName = Path.Combine(output, $"Microsoft.WebView2.FixedVersionRuntime.{Package.Version}.x64");
                var expanded = Path.Combine(incoming, expandedName);
                if (!Complete(expanded) || FileVersionInfo.GetVersionInfo(Path.Combine(expanded, RequiredFiles[0])).ProductVersion != Package.Version)
                    throw new InvalidDataException("白板网页组件内容与锁定版本不符。");
                // Allow the WebView2 sandbox identities to read and execute the private runtime.
                await RunAsync("icacls.exe", incoming, expandedName, "/grant",
                    "*S-1-15-2-2:(OI)(CI)(RX)", "*S-1-15-2-1:(OI)(CI)(RX)");

                File.WriteAllText(Path.Combine(expanded, Marker), Package.Sha256);
                if (Directory.Exists(target)) Directory.Move(target, previous);
                try { Directory.Move(expanded, target); }
                catch
                {
                    if (Directory.Exists(previous) && !Directory.Exists(target)) Directory.Move(previous, target);
                    throw;
                }
                DeleteStage(previous);
                return target;
            }
            finally { DeleteStage(incoming); }
        }
        finally { Installation.Release(); }
    }

    private static bool Complete(string directory) => RequiredFiles.All(file =>
        File.Exists(IncrementalUpdates.SafePath(directory, file)));

    private static bool Ready(string directory)
    {
        var marker = IncrementalUpdates.SafePath(directory, Marker);
        return File.Exists(marker) && File.ReadAllText(marker) == Package.Sha256 && Complete(directory);
    }

    private static async Task RunAsync(string program, string workingDirectory, params string[] arguments)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, program))
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true,
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new IOException("Cannot start " + program);
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var details = await output + await error;
        if (process.ExitCode != 0) throw new IOException($"{program} ({process.ExitCode}): {details.Trim()}");
    }

    private static void DeleteStage(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, recursive: true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { AppLog.Error("Classroom WebView2 temporary directory cleanup failed", error); }
    }
}

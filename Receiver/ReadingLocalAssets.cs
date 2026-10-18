using System.Reflection;

namespace ICeClass.Receiver;

internal static class ReadingLocalAssets
{
    internal const string Host = "reading.iceclass.local";
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static string? _ready;

    public static async Task<string> EnsureAsync(CancellationToken token)
    {
        await Gate.WaitAsync(token);
        try
        {
            if (_ready is not null) return _ready;
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ICeClass", "ReadingAssets", ReceiverUpdateService.CurrentVersionText + "-" + typeof(ReadingLocalAssets).Module.ModuleVersionId.ToString("N"));
            // A temporary directory is promoted only after every resource is written. An interrupted
            // first launch cannot leave an apparently complete but partially extracted activity.
            if (!File.Exists(Path.Combine(root, ".complete")))
            {
                var stage = root + ".extract-" + Guid.NewGuid().ToString("N");
                Directory.CreateDirectory(stage);
                var assembly = typeof(ReadingLocalAssets).Assembly;
                foreach (var name in assembly.GetManifestResourceNames().Where(n => n.StartsWith("ICeClass.Local/", StringComparison.Ordinal)))
                {
                    token.ThrowIfCancellationRequested();
                    var relative = name["ICeClass.Local/".Length..].Replace('\\', '/');
                    var path = Path.GetFullPath(Path.Combine(stage, relative));
                    if (!path.StartsWith(Path.GetFullPath(stage) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("活动资源路径无效。");
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    await using var input = assembly.GetManifestResourceStream(name)!;
                    await using var output = File.Create(path);
                    await input.CopyToAsync(output, token);
                }
                if (!File.Exists(Path.Combine(stage, "reading", "index.html"))) throw new IOException("客户端缺少本地活动资源。");
                await File.WriteAllTextAsync(Path.Combine(stage, ".complete"), ReceiverUpdateService.CurrentVersionText, token);
                // Preserve incomplete directories for diagnosis; never delete someone else's data.
                if (Directory.Exists(root)) Directory.Move(root, root + ".incomplete-" + Guid.NewGuid().ToString("N"));
                Directory.Move(stage, root);
            }
            return _ready = root;
        }
        finally { Gate.Release(); }
    }
}

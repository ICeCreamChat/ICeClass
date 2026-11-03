using System.Reflection;
using System.Text.Json;

namespace ICeClass.Updates;

internal sealed record VoiceResourceFile(string Path, long Size, string Sha256);

/// <summary>Prepares only voice data. It never creates an application update or restarts a client.</summary>
internal sealed class VoiceResources
{
    private readonly string _directory;
    private readonly Func<string, Stream?>? _bundled;
    private readonly string? _asrCache;
    private readonly HashSet<string> _available = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile bool _ready, _speechReady;
    internal IReadOnlyList<VoiceResourceFile> Files { get; }
    internal bool Ready => _ready;
    internal bool SpeechReady => _speechReady;
    internal event Action? Changed;
    internal static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = Timeout.InfiniteTimeSpan };

    internal VoiceResources(IReadOnlyList<VoiceResourceFile> files, string directory, Func<string, Stream?>? bundled = null, string? asrCache = null)
    {
        if (files.Count is < 1 or > 64 || files.Any(f => !f.Path.StartsWith("VoiceResources/", StringComparison.Ordinal)
            || !IncrementalUpdates.ValidTarget(f.Path, "ICeClass.exe") || !IncrementalUpdates.ValidHash(f.Sha256)
            || f.Size is < 1 or > IncrementalUpdates.MaxFileBytes)
            || files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count)
            throw new InvalidDataException("语音资源清单无效。");
        Files = files; _directory = Path.GetFullPath(directory); _bundled = bundled; _asrCache = asrCache;
        foreach (var file in files) { using var source = bundled?.Invoke(file.Path); if (source is not null) _available.Add(file.Path); }
        RefreshState();
    }

    internal static VoiceResources ForClient(Assembly assembly, bool teacher)
    {
        var files = new List<VoiceResourceFile>();
        string? cache = null;
        // Prepare natural announcement speech first, before the larger recognition model.
        foreach (var group in teacher ? new[] { "Asr" } : new[] { "Tts", "", "Vad", "Asr", "Speaker" })
        {
            var prefix = "ICeClass.Voice." + (group.Length == 0 ? "" : group + ".");
            using var source = assembly.GetManifestResourceStream(prefix + "manifest.json")
                ?? throw new InvalidDataException("缺少语音资源清单。");
            using var manifest = JsonDocument.Parse(source);
            if (group == "Asr") cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ICeClass", "Voice", manifest.RootElement.GetProperty("version").GetString()!);
            var entries = manifest.RootElement.TryGetProperty("parts", out var parts) ? parts : manifest.RootElement.GetProperty("files");
            foreach (var entry in entries.EnumerateArray())
            {
                var name = entry.GetProperty("name").GetString()!;
                if (name.Contains('/') || name.Contains('\\')) throw new InvalidDataException("语音资源名称无效。");
                files.Add(new("VoiceResources/" + (group.Length == 0 ? "" : group + "/") + name,
                    entry.GetProperty("size").GetInt64(), entry.GetProperty("sha256").GetString()!));
            }
        }
        return new(files, AppContext.BaseDirectory, path => assembly.GetManifestResourceStream(LogicalName(path)), cache);
    }
    internal static string LogicalName(string path) => "ICeClass.Voice." + path["VoiceResources/".Length..].Replace('/', '.');

    internal async Task<bool> IsReadyAsync(CancellationToken token)
    {
        await _gate.WaitAsync(token);
        try { await InspectAsync(token); return Ready; }
        finally { _gate.Release(); }
    }
    private async Task InspectAsync(CancellationToken token)
    {
        _available.Clear();
        foreach (var file in Files)
        {
            token.ThrowIfCancellationRequested();
            using var source = _bundled?.Invoke(file.Path);
            if (source is not null || await IncrementalUpdates.MatchesAsync(IncrementalUpdates.SafePath(_directory, file.Path), file.Size, file.Sha256, token)
                || await ReuseCacheAsync(file, token))
                _available.Add(file.Path);
        }
        RefreshState();
    }

    private async Task<bool> ReuseCacheAsync(VoiceResourceFile file, CancellationToken token)
    {
        if (_asrCache is null || !file.Path.StartsWith("VoiceResources/Asr/", StringComparison.Ordinal)) return false;
        var source = IncrementalUpdates.SafePath(_asrCache, Path.GetFileName(file.Path));
        if (!await IncrementalUpdates.MatchesAsync(source, file.Size, file.Sha256, token)) return false;
        var temporary = IncrementalUpdates.SafePath(_directory, ".updates/voice-resources/" + file.Sha256 + ".cache");
        Directory.CreateDirectory(Path.GetDirectoryName(temporary)!);
        await using (var input = File.OpenRead(source))
        await using (var output = File.Create(temporary)) await input.CopyToAsync(output, token);
        if (!await IncrementalUpdates.MatchesAsync(temporary, file.Size, file.Sha256, token))
            throw new InvalidDataException("本机语音缓存未通过完整性检查。");
        token.ThrowIfCancellationRequested();
        var target = IncrementalUpdates.SafePath(_directory, file.Path);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Move(temporary, target, true);
        return true;
    }
    private void RefreshState()
    {
        _ready = _available.Count == Files.Count;
        var speech = Files.Where(f => f.Path.StartsWith("VoiceResources/Tts/", StringComparison.Ordinal)).ToArray();
        _speechReady = speech.Length > 0 && speech.All(f => _available.Contains(f.Path));
        Changed?.Invoke();
    }

    internal async Task PrepareAsync(Uri origin, HttpClient client, IProgress<UpdateProgress>? progress, CancellationToken token)
    {
        await _gate.WaitAsync(token);
        try
        {
            progress?.Report(new(UpdateStage.Preparing));
            await InspectAsync(token);
            var missing = Files.Where(f => !_available.Contains(f.Path)).ToArray();
            var total = missing.Sum(f => f.Size);
            var stage = IncrementalUpdates.SafePath(_directory, ".updates/voice-resources");
            Directory.CreateDirectory(stage);
            long completed = 0;
            using var transfer = new UpdateTransferProgress(progress, total);
            foreach (var file in missing)
            {
                var downloaded = await IncrementalUpdates.DownloadAsync(origin, "/api/voice/resources/" + file.Sha256.ToLowerInvariant(),
                    file.Size, file.Sha256, stage, client, null, received => transfer.Report(completed + received),
                    () => progress?.Report(new(UpdateStage.Verifying, completed + file.Size, total)), token);
                token.ThrowIfCancellationRequested();
                var target = IncrementalUpdates.SafePath(_directory, file.Path);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                // Publish each completely verified file atomically. Partial files stay in the staging folder.
                File.Move(downloaded, target, true);
                completed += file.Size; _available.Add(file.Path); RefreshState();
            }
            progress?.Report(new(UpdateStage.Verifying, completed, total));
        }
        finally { _gate.Release(); }
    }
}

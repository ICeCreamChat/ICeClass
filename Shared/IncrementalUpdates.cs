using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;

namespace ICeClass.Updates;

internal sealed record UpdateDelta
{
    public string SourceSha256 { get; init; } = "";
    public long Size { get; init; }
    public string Sha256 { get; init; } = "";
    public string DownloadUrl { get; init; } = "";
}
internal sealed record UpdateFile
{
    public string Path { get; init; } = "";
    public long Size { get; init; }
    public string Sha256 { get; init; } = "";
    public string DownloadUrl { get; init; } = "";
    public List<UpdateDelta> Deltas { get; init; } = [];
}
internal sealed record UpdatePlan
{
    public bool Available { get; init; }
    public string Version { get; init; } = "";
    public List<UpdateFile> Files { get; init; } = [];
}
internal sealed record PreparedFile(string Path, string StagedPath, long Size, string Sha256);
internal sealed record PreparedUpdate(string Version, string ExecutableName, List<PreparedFile> Files);

internal static class IncrementalUpdates
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    internal const long MaxFileBytes = 1024L * 1024 * 1024;

    internal static async Task<UpdatePlan?> FetchPlanAsync(Uri origin, string url, string currentVersion, HttpClient client, string? bearer, CancellationToken token)
    {
        using var request = Request(origin, url, bearer);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null; // Existing schools can still serve the original whole-file update.
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var body = new MemoryStream(); var buffer = new byte[8192];
        while (true)
        {
            var count = await source.ReadAsync(buffer, timeout.Token); if (count == 0) break;
            if (body.Length + count > 128 * 1024) throw new InvalidDataException("更新计划过大。");
            body.Write(buffer, 0, count);
        }
        var plan = JsonSerializer.Deserialize<UpdatePlan>(body.ToArray(), Json) ?? throw new InvalidDataException("更新计划为空。");
        if (!plan.Available) return null;
        if (!System.Version.TryParse(plan.Version, out var remote) || !System.Version.TryParse(currentVersion, out var current)) throw new InvalidDataException("更新版本无效。");
        return remote > current ? plan : null;
    }

    internal static async Task<PreparedUpdate> PrepareAsync(Uri origin, UpdatePlan plan, string installDirectory, string executableName,
        HttpClient client, string? bearer, Func<string, Stream?>? bundledFile, IProgress<int>? progress, CancellationToken token)
    {
        Validate(plan, origin, executableName);
        installDirectory = Path.GetFullPath(installDirectory);
        var identity = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(plan, Json))).ToLowerInvariant()[..16];
        var stage = Path.Combine(installDirectory, ".updates", plan.Version + "-" + identity);
        SafeDirectory(stage); Directory.CreateDirectory(stage);
        var files = new List<PreparedFile>(); var index = 0;
        foreach (var file in plan.Files)
        {
            token.ThrowIfCancellationRequested();
            var currentPath = SafePath(installDirectory, file.Path);
            var stagedPath = SafePath(stage, "files/" + file.Path);
            if (await MatchesAsync(currentPath, file.Size, file.Sha256, token)) { progress?.Report(++index * 100 / plan.Files.Count); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(stagedPath)!);
            if (!await MatchesAsync(stagedPath, file.Size, file.Sha256, token))
            {
                TryDelete(stagedPath);
                // A transitional full/offline executable already contains the exact signed-off resources.
                using var bundled = bundledFile?.Invoke(file.Path);
                var reusedBundled = false;
                if (bundled is not null)
                {
                    var temporary = stagedPath + ".bundled";
                    try
                    {
                        // Older embedded resources are reusable only when they are the target version.
                        // A changed model must still come from the current release payload.
                        if (bundled.CanSeek && bundled.Length == file.Size)
                        {
                            await using (var output = File.Create(temporary)) await CopyBoundedAsync(bundled, output, file.Size, token);
                            if (await MatchesAsync(temporary, file.Size, file.Sha256, token))
                            { File.Move(temporary, stagedPath, true); reusedBundled = true; }
                        }
                    }
                    finally { TryDelete(temporary); }
                }
                if (!reusedBundled)
                {
                    UpdateDelta? delta = null;
                    if (File.Exists(currentPath) && file.Deltas.Count > 0)
                    {
                        var sourceHash = await HashAsync(currentPath, token);
                        delta = file.Deltas.FirstOrDefault(d => d.SourceSha256.Equals(sourceHash, StringComparison.OrdinalIgnoreCase));
                    }
                    if (delta is not null)
                    {
                        var patch = await DownloadAsync(origin, delta.DownloadUrl, delta.Size, delta.Sha256, stage, client, bearer, token);
                        token.ThrowIfCancellationRequested();
                        // The source is checked again to avoid applying a patch while another updater changed it.
                        if (!(await HashAsync(currentPath, token)).Equals(delta.SourceSha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("原程序已变化，请重新检查更新。");
                        WindowsDelta.Apply(currentPath, patch, stagedPath);
                    }
                    else
                    {
                        var downloaded = await DownloadAsync(origin, file.DownloadUrl, file.Size, file.Sha256, stage, client, bearer, token);
                        File.Copy(downloaded, stagedPath, true);
                    }
                    if (!await MatchesAsync(stagedPath, file.Size, file.Sha256, token)) { TryDelete(stagedPath); throw new InvalidDataException("更新回建结果未通过完整性检查。"); }
                }
            }
            files.Add(new(file.Path, stagedPath, file.Size, file.Sha256));
            progress?.Report(++index * 100 / plan.Files.Count);
        }
        var prepared = new PreparedUpdate(plan.Version, executableName, files);
        await UpdateInstaller.ValidateAsync(prepared, installDirectory, executableName, token);
        UpdateInstaller.SavePending(installDirectory, prepared);
        return prepared;
    }

    internal static void Validate(UpdatePlan plan, Uri origin, string executableName)
    {
        if (!plan.Available || !System.Version.TryParse(plan.Version, out _) || plan.Version.Any(c => !char.IsAsciiDigit(c) && c != '.') ||
            plan.Files is null || plan.Files.Count is < 1 or > 128 || plan.Files.Any(f => f is null) ||
            plan.Files.Count(f => f.Path == executableName) != 1 || plan.Files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != plan.Files.Count)
            throw new InvalidDataException("更新计划无效。");
        long total = 0;
        foreach (var file in plan.Files)
        {
            if (!ValidTarget(file.Path, executableName) || file.Size is < 1 or > MaxFileBytes || !ValidHash(file.Sha256) || file.Deltas is null || file.Deltas.Count > 8)
                throw new InvalidDataException("更新文件信息无效。");
            ValidateUrl(origin, file.DownloadUrl); total += file.Size;
            foreach (var delta in file.Deltas)
            {
                if (delta is null || !ValidHash(delta.SourceSha256) || !ValidHash(delta.Sha256) || delta.Size <= 0 || delta.Size >= file.Size) throw new InvalidDataException("更新补丁信息无效。");
                ValidateUrl(origin, delta.DownloadUrl);
            }
        }
        if (total > 2 * MaxFileBytes) throw new InvalidDataException("更新计划超过大小限制。");
    }
    internal static bool ValidHash(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    internal static bool ValidTarget(string? path, string executableName)
    {
        if (path == executableName) return true;
        if (executableName != "ICeClass.exe" || path is null || !path.StartsWith("VoiceResources/", StringComparison.Ordinal) || path.Length > 240) return false;
        return path.Split('/').All(part => part.Length > 0 && part is not "." and not ".." && !part.EndsWith('.') &&
            part.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.') &&
            !new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" }.Contains(part.Split('.')[0], StringComparer.OrdinalIgnoreCase));
    }
    internal static string SafePath(string root, string relative)
    {
        var absoluteRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(absoluteRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新文件越出安装目录。");
        SafeDirectory(path); return path;
    }
    private static void SafeDirectory(string path)
    {
        for (var item = new FileInfo(Path.GetFullPath(path)); item is not null; item = item.Directory is { } parent ? new FileInfo(parent.FullName) : null)
            if ((File.Exists(item.FullName) || Directory.Exists(item.FullName)) && (File.GetAttributes(item.FullName) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("更新位置不能使用链接目录。");
    }
    private static Uri ValidateUrl(Uri origin, string url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(origin, url, out var target) || target.UserInfo.Length > 0 || target.Fragment.Length > 0 ||
            target.Scheme != origin.Scheme || target.Host != origin.Host || target.Port != origin.Port ||
            !(target.Scheme == "https" || target.Scheme == "http" && target.IsLoopback)) throw new InvalidDataException("更新地址必须来自当前学校平台。");
        return target;
    }
    private static HttpRequestMessage Request(Uri origin, string url, string? bearer)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, ValidateUrl(origin, url));
        if (!string.IsNullOrEmpty(bearer)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        return request;
    }
    internal static async Task<bool> MatchesAsync(string path, long size, string hash, CancellationToken token)
        => File.Exists(path) && new FileInfo(path).Length == size && (await HashAsync(path, token)).Equals(hash, StringComparison.OrdinalIgnoreCase);
    internal static async Task<string> HashAsync(string path, CancellationToken token)
    { await using var source = File.OpenRead(path); return Convert.ToHexString(await SHA256.HashDataAsync(source, token)).ToLowerInvariant(); }

    private static async Task<string> DownloadAsync(Uri origin, string url, long size, string hash, string stage, HttpClient client, string? bearer, CancellationToken token)
    {
        var path = SafePath(stage, hash.ToLowerInvariant() + ".download");
        if (await MatchesAsync(path, size, hash, token)) return path;
        var offset = File.Exists(path) ? new FileInfo(path).Length : 0;
        if (offset >= size) { TryDelete(path); offset = 0; }
        using var request = Request(origin, url, bearer);
        if (offset > 0) request.Headers.Range = new RangeHeaderValue(offset, null);
        using var connection = CancellationTokenSource.CreateLinkedTokenSource(token); connection.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connection.Token);
        response.EnsureSuccessStatusCode();
        if (response.RequestMessage?.RequestUri is { } final) ValidateUrl(origin, final.AbsoluteUri);
        if (response.StatusCode == HttpStatusCode.OK) offset = 0;
        else if (response.StatusCode != HttpStatusCode.PartialContent || response.Content.Headers.ContentRange is not { } range ||
            range.From != offset || range.Length != size || range.To != size - 1) throw new InvalidDataException("更新续传范围不正确。");
        if (response.Content.Headers.ContentLength is long length && length != size - offset) throw new InvalidDataException("更新文件长度不正确。");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        await using (var output = new FileStream(path, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 131072, true))
            await CopyBoundedAsync(input, output, size - offset, token);
        if (!await MatchesAsync(path, size, hash, token)) { TryDelete(path); throw new InvalidDataException("更新文件未通过完整性检查。"); }
        return path;
    }
    private static async Task CopyBoundedAsync(Stream input, Stream output, long expected, CancellationToken token)
    {
        var buffer = new byte[131072]; long received = 0;
        while (true)
        {
            using var stalled = CancellationTokenSource.CreateLinkedTokenSource(token); stalled.CancelAfter(TimeSpan.FromSeconds(30));
            var count = await input.ReadAsync(buffer, stalled.Token); if (count == 0) break;
            received += count; if (received > expected) throw new InvalidDataException("更新文件超过声明长度。");
            await output.WriteAsync(buffer.AsMemory(0, count), token);
        }
        await output.FlushAsync(token);
        if (received != expected) throw new IOException("更新下载中断，下次继续。");
    }
    private static void TryDelete(string path) { if (File.Exists(path)) File.Delete(path); }
}

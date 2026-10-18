using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ICeClass.Desktop;

public sealed record DesktopRelease(string Version, string Sha256, long Size, string DownloadUrl);

public static class DesktopUpdates
{
    private const long MaxBytes = 180L * 1024 * 1024;
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(12) };
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public static string CurrentVersion => typeof(DesktopUpdates).Assembly.GetName().Version?.ToString(3) ?? "2.3.0";
    public static bool IsValid(string endpoint, DesktopRelease release)
    {
        return Version.TryParse(release.Version, out var version) && version > Version.Parse(CurrentVersion) &&
            release.Size is > 0 and <= MaxBytes && release.Sha256 is { Length: 64 } && release.Sha256.All(Uri.IsHexDigit) && !string.IsNullOrWhiteSpace(release.DownloadUrl) &&
            Uri.TryCreate(new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/"), release.DownloadUrl, out var download) &&
            DesktopSettings.SameOrigin(endpoint, download.AbsoluteUri);
    }
    public static async Task<DesktopRelease?> CheckAsync(string endpoint, CancellationToken token)
    {
        var uri = new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/api/desktop/update?currentVersion=" + Uri.EscapeDataString(CurrentVersion));
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(20));
        using var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        if (response.StatusCode == HttpStatusCode.NotFound) throw new InvalidOperationException("学校平台尚未提供桌面更新服务。");
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > 16384) throw new InvalidOperationException("更新信息无效。");
        await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var bounded = new MemoryStream(); var buffer = new byte[4096];
        while (true) { var count = await source.ReadAsync(buffer, timeout.Token); if (count == 0) break; if (bounded.Length + count > 16384) throw new InvalidOperationException("更新信息无效。"); bounded.Write(buffer, 0, count); }
        var manifest = JsonSerializer.Deserialize<JsonElement>(bounded.ToArray());
        if (!manifest.TryGetProperty("available", out var available) || !available.GetBoolean()) return null;
        var release = manifest.Deserialize<DesktopRelease>(JsonOptions);
        if (release is null || !IsValid(endpoint, release)) throw new InvalidOperationException("更新信息无效。");
        return release;
    }
    public static async Task<string> DownloadAsync(string endpoint, DesktopRelease release, IProgress<int>? progress, CancellationToken token)
        => await DownloadAsync(endpoint, release, progress, token, Path.Combine(AppContext.BaseDirectory, ".updates"), Client);

    internal static async Task<string> DownloadAsync(string endpoint, DesktopRelease release, IProgress<int>? progress, CancellationToken token, string directory, HttpClient client)
    {
        if (!IsValid(endpoint, release)) throw new InvalidOperationException("更新信息无效。");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "ICeClass.Desktop-" + Version.Parse(release.Version) + ".download");
        // Bytes are reused only for this exact release; the final digest is always checked.
        var metadata = JsonSerializer.Serialize(release);
        if (!File.Exists(path + ".json") || File.ReadAllText(path + ".json") != metadata)
        { if (File.Exists(path)) File.Delete(path); File.WriteAllText(path + ".json", metadata); }
        var offset = File.Exists(path) ? new FileInfo(path).Length : 0;
        if (offset > release.Size) { File.Delete(path); offset = 0; }
        if (offset == release.Size)
        { if (await Verify(path, release, token)) return path; File.Delete(path); offset = 0; }
        var uri = new Uri(new Uri(DesktopSettings.NormalizeEndpoint(endpoint) + "/"), release.DownloadUrl);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (offset > 0) request.Headers.Range = new RangeHeaderValue(offset, null);
        using var connectionTimeout = CancellationTokenSource.CreateLinkedTokenSource(token); connectionTimeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connectionTimeout.Token);
        response.EnsureSuccessStatusCode();
        if (response.StatusCode == HttpStatusCode.OK) offset = 0;
        else if (response.StatusCode != HttpStatusCode.PartialContent || response.Content.Headers.ContentRange?.From != offset || response.Content.Headers.ContentRange.Length != release.Size)
            throw new InvalidOperationException("下载续传范围不正确。");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        await using (var output = new FileStream(path, offset > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 131072, true))
        {
            var buffer = new byte[131072]; long total = offset;
            while (true)
            {
                using var stalled = CancellationTokenSource.CreateLinkedTokenSource(token); stalled.CancelAfter(TimeSpan.FromSeconds(30));
                var count = await input.ReadAsync(buffer, stalled.Token); if (count == 0) break;
                total += count; if (total > release.Size) throw new InvalidOperationException("更新文件大小不正确。");
                await output.WriteAsync(buffer.AsMemory(0, count), token); progress?.Report((int)(total * 100 / release.Size));
            }
            await output.FlushAsync(token);
        }
        if (!await Verify(path, release, token)) { File.Delete(path); throw new InvalidOperationException("更新文件未通过完整性检查，请重新下载。"); }
        return path;
    }
    private static async Task<bool> Verify(string path, DesktopRelease release, CancellationToken token)
    {
        if (new FileInfo(path).Length != release.Size) return false;
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase);
    }
    internal static void Install(string path, DesktopRelease release)
    {
        var current = Environment.ProcessPath ?? throw new InvalidOperationException("无法找到当前程序。");
        var directory = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".updates"));
        if (!Path.GetFullPath(path).StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("更新文件位置不正确。");
        var script = Path.Combine(directory, "apply-desktop-update.ps1");
        File.WriteAllText(script, ApplyScript, new UTF8Encoding(true));
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        var resume = Convert.ToBase64String(Encoding.UTF8.GetBytes(Program.Options.RestartArguments()));
        foreach (var value in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, Environment.ProcessId.ToString(), current, path, release.Sha256, resume }) start.ArgumentList.Add(value);
        Process.Start(start);
    }
    internal static void ConfirmLaunch()
    {
        var args = Environment.GetCommandLineArgs(); var index = Array.IndexOf(args, "--update-marker");
        if (index < 0 || index + 1 >= args.Length) return;
        var marker = Path.GetFullPath(args[index + 1]);
        if (marker == Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".updates", "desktop-started.ok"))) File.WriteAllText(marker, "started");
    }
    internal const string ApplyScript = """
param([int]$OldProcessId,[string]$CurrentExecutable,[string]$DownloadedExecutable,[string]$ExpectedDigest,[string]$EncodedRestartArguments)
$ErrorActionPreference='Stop'
$resumeArguments=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedRestartArguments))
$backup=$CurrentExecutable+'.previous'
$marker=Join-Path (Split-Path -Parent $PSCommandPath) 'desktop-started.ok'
$moved=$false
$newProcess=$null
try {
  try { Wait-Process -Id $OldProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch { }
  if (Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue) { throw 'Application is still running.' }
  if ((Get-FileHash -LiteralPath $DownloadedExecutable -Algorithm SHA256).Hash -ne $ExpectedDigest) { throw 'Update integrity check failed.' }
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $CurrentExecutable -Destination $backup -Force
  $moved=$true
  Move-Item -LiteralPath $DownloadedExecutable -Destination $CurrentExecutable -Force
  $argument=($resumeArguments+' --update-marker "'+$marker+'"').Trim()
  $newProcess=Start-Process -FilePath $CurrentExecutable -ArgumentList $argument -WindowStyle Hidden -PassThru
  $ready=$false
  for($i=0;$i -lt 60;$i++) {
    if(Test-Path -LiteralPath $marker){$ready=$true;break}
    if($newProcess.HasExited){break}
    Start-Sleep -Milliseconds 500
    $newProcess.Refresh()
  }
  if(-not $ready){throw 'Updated application did not confirm startup.'}
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
} catch {
  if($newProcess -and -not $newProcess.HasExited){Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue}
  if($moved -and (Test-Path -LiteralPath $backup)){
    Remove-Item -LiteralPath $CurrentExecutable -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $backup -Destination $CurrentExecutable -Force
    if($resumeArguments){Start-Process -FilePath $CurrentExecutable -ArgumentList $resumeArguments -WindowStyle Hidden}
    else{Start-Process -FilePath $CurrentExecutable -WindowStyle Hidden}
  }
} finally {
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
""";
}

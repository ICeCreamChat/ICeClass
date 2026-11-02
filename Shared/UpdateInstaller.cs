using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ICeClass.Updates;

internal static class UpdateInstaller
{
    internal static string QuoteArguments(IEnumerable<string> arguments) => string.Join(" ", arguments.Select(value =>
    {
        var quoted = new StringBuilder("\""); var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            quoted.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character); slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }));

    internal static void SavePending(string installDirectory, PreparedUpdate update)
    {
        var path = IncrementalUpdates.SafePath(installDirectory, ".updates/pending.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path + ".next", JsonSerializer.Serialize(update, IncrementalUpdates.Json), new UTF8Encoding(false));
        File.Move(path + ".next", path, true);
    }
    internal static PreparedUpdate? LoadPending(string installDirectory, string executableName)
    {
        var path = IncrementalUpdates.SafePath(installDirectory, ".updates/pending.json");
        if (!File.Exists(path)) return null;
        if (new FileInfo(path).Length > 128 * 1024) throw new InvalidDataException("本机更新计划过大。");
        var update = JsonSerializer.Deserialize<PreparedUpdate>(File.ReadAllText(path), IncrementalUpdates.Json);
        if (update is null || update.ExecutableName != executableName || !Version.TryParse(update.Version, out _)) throw new InvalidDataException("本机更新计划无效。");
        return update;
    }
    internal static async Task ValidateAsync(PreparedUpdate update, string installDirectory, string executableName, CancellationToken token)
    {
        if (update.ExecutableName != executableName || !Version.TryParse(update.Version, out _) || update.Files is null || update.Files.Count is < 1 or > 128 ||
            update.Files.Any(f => f is null) || update.Files.Select(f => f.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != update.Files.Count)
            throw new InvalidDataException("待安装更新无效。");
        var updateRoot = Path.GetFullPath(Path.Combine(installDirectory, ".updates")) + Path.DirectorySeparatorChar;
        foreach (var file in update.Files)
        {
            if (!IncrementalUpdates.ValidTarget(file.Path, executableName) || file.Size is < 1 or > IncrementalUpdates.MaxFileBytes || !IncrementalUpdates.ValidHash(file.Sha256))
                throw new InvalidDataException("待安装文件信息无效。");
            IncrementalUpdates.SafePath(installDirectory, file.Path);
            var stage = Path.GetFullPath(file.StagedPath);
            if (!stage.StartsWith(updateRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("暂存更新不在本机更新目录。");
            IncrementalUpdates.SafePath(updateRoot, Path.GetRelativePath(updateRoot, stage));
            if (!await IncrementalUpdates.MatchesAsync(stage, file.Size, file.Sha256, token)) throw new InvalidDataException("暂存更新已变化，请重新下载。");
        }
    }
    internal static bool IsUpdateLaunch => Environment.GetCommandLineArgs().Contains("--incremental-update-started");

    internal static bool TryLaunchPending(string installDirectory, string executableName, string restartArguments, string? currentVersion = null)
    {
        // The helper's launch must initialize normally and confirm readiness, rather than starting another helper.
        if (IsUpdateLaunch) return false;
        var directory = IncrementalUpdates.SafePath(installDirectory, ".updates");
        var applyingPath = Path.Combine(directory, "applying.json");
        PreparedUpdate? pending;
        try { pending = File.Exists(applyingPath) ? null : LoadPending(installDirectory, executableName); }
        catch (Exception error) when (error is JsonException or InvalidDataException or IOException)
        {
            var invalid = Path.Combine(directory, "pending.json");
            if (File.Exists(invalid)) File.Move(invalid, Path.Combine(directory, "rejected-pending.json"), true);
            File.WriteAllText(Path.Combine(directory, "last-error.txt"), "更新计划损坏，继续使用当前程序。" + error.Message);
            return false;
        }
        if (pending is not null && currentVersion is not null && Version.TryParse(currentVersion, out var current) && Version.Parse(pending.Version) <= current)
        { File.Delete(Path.Combine(directory, "pending.json")); return false; }
        if (pending is null && !File.Exists(applyingPath)) return false;
        // The helper rechecks every staged size and digest before it changes any installed file.
        var script = Path.Combine(directory, "apply-incremental-update.ps1");
        Directory.CreateDirectory(directory);
        File.WriteAllText(script, ApplyScript, new UTF8Encoding(true));
        var process = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(restartArguments));
        foreach (var arg in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, Environment.ProcessId.ToString(), Path.GetFullPath(installDirectory), executableName, encoded }) process.ArgumentList.Add(arg);
        Process.Start(process); return true;
    }
    internal static void ConfirmLaunch(string installDirectory)
    {
        if (!IsUpdateLaunch) return;
        File.WriteAllText(IncrementalUpdates.SafePath(installDirectory, ".updates/incremental-started.ok"), "started");
    }

    internal const string ApplyScript = """
param([int]$OldProcessId,[string]$InstallDirectory,[string]$ExecutableName,[string]$EncodedRestartArguments)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')+'\'
$updates=Join-Path $root '.updates'
$pending=Join-Path $updates 'pending.json'
$applying=Join-Path $updates 'applying.json'
$journal=Join-Path $updates 'install-journal.json'
$marker=Join-Path $updates 'incremental-started.ok'
$resume=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedRestartArguments))
$changes=@()
$newProcess=$null
function Resolve-Safe([string]$relative){
  $resolved=[IO.Path]::GetFullPath((Join-Path $root $relative))
  if(-not $resolved.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Update path escaped installation.'}
  $probe=$resolved
  while($probe -and $probe.Length -ge $root.Length){
    if((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Update path is a link.'}
    $probe=Split-Path -Parent $probe
  }
  return $resolved
}
function Assert-Target([string]$relative){
  if($relative -eq $ExecutableName){return}
  if($ExecutableName -ne 'ICeClass.exe' -or $relative -notmatch '^VoiceResources/[A-Za-z0-9_./-]+$'){throw 'Invalid update destination.'}
  foreach($part in $relative.Split('/')){
    if(-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw 'Invalid update destination.'}
  }
}
function Start-App([bool]$confirm){
  $arguments=($resume+$(if($confirm){' --incremental-update-started'}else{''})).Trim()
  $program=Resolve-Safe $ExecutableName
  if($arguments){return Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Hidden -PassThru}
  return Start-Process -FilePath $program -WindowStyle Hidden -PassThru
}
function Restore-Previous {
  if(Test-Path -LiteralPath $journal){
    $parsedEntries=Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries=@($parsedEntries)
    [array]::Reverse($entries)
    foreach($entry in $entries){
      Assert-Target $entry.path
      if($entry.backup -ne ('.updates/previous/'+$entry.path)){throw 'Invalid recovery backup.'}
      $target=Resolve-Safe $entry.path
      $backup=Resolve-Safe $entry.backup
      if($entry.existed -and (Test-Path -LiteralPath $backup)){Copy-Item -LiteralPath $backup -Destination $target -Force}
      elseif(-not $entry.existed){Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue}
    }
  }
}
try {
  try{Wait-Process -Id $OldProcessId -Timeout 120 -ErrorAction SilentlyContinue}catch{}
  if(Get-Process -Id $OldProcessId -ErrorAction SilentlyContinue){throw 'Application is still running.'}
  # Recover an interrupted previous installation before trying any newer plan.
  if(Test-Path -LiteralPath $applying){
    Restore-Previous
    Remove-Item -LiteralPath $applying,$journal,$pending -Force -ErrorAction SilentlyContinue
    $null=Start-App $false
    exit 0
  }
  $plan=Get-Content -LiteralPath $pending -Raw -Encoding UTF8 | ConvertFrom-Json
  if($plan.executableName -ne $ExecutableName -or @($plan.files).Count -lt 1 -or @($plan.files).Count -gt 128){throw 'Invalid prepared update.'}
  $destinations=@{}
  foreach($file in $plan.files){
    Assert-Target $file.path
    if($destinations.ContainsKey($file.path)){throw 'Duplicate prepared destination.'}
    $destinations[$file.path]=$true
    $target=Resolve-Safe $file.path
    $staged=[IO.Path]::GetFullPath($file.stagedPath)
    if(-not $staged.StartsWith($updates+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid staging directory.'}
    $staged=Resolve-Safe $staged.Substring($root.Length)
    if(-not $staged.StartsWith($updates+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $staged).Length -ne $file.size -or (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne $file.sha256){throw 'Prepared update failed verification.'}
  }
  Move-Item -LiteralPath $pending -Destination $applying -Force
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  foreach($file in @($plan.files | Sort-Object @{Expression={if($_.path -eq $ExecutableName){1}else{0}}})){
    $target=Resolve-Safe $file.path
    $staged=[IO.Path]::GetFullPath($file.stagedPath)
    $backupRelative='.updates/previous/'+$file.path
    $backup=Resolve-Safe $backupRelative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target),(Split-Path -Parent $backup) | Out-Null
    $existed=Test-Path -LiteralPath $target
    if($existed){Copy-Item -LiteralPath $target -Destination $backup -Force}
    $changes+=@{path=$file.path;backup=$backupRelative;existed=[bool]$existed}
    $changes | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($journal+'.next') -Encoding UTF8
    Move-Item -LiteralPath ($journal+'.next') -Destination $journal -Force
    # ReplaceFile keeps the EXE path present if the machine loses power during replacement.
    if($existed){[IO.File]::Replace($staged,$target,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($staged,$target)}
  }
  $newProcess=Start-App $true
  $ready=$false
  for($i=0;$i -lt 90;$i++){
    if(Test-Path -LiteralPath $marker){$ready=$true;break}
    if($newProcess.HasExited){break}
    Start-Sleep -Milliseconds 500
    $newProcess.Refresh()
  }
  if(-not $ready){throw 'New application did not confirm startup.'}
  Remove-Item -LiteralPath $applying,$journal,$marker,$pending -Force -ErrorAction SilentlyContinue
  foreach($entry in $changes){Remove-Item -LiteralPath (Resolve-Safe $entry.backup) -Force -ErrorAction SilentlyContinue}
  foreach($file in $plan.files){
    $relative=$file.stagedPath.Substring($updates.Length+1).Split([char]'\')[0]
    if($relative -match '^\d+(\.\d+){1,3}-[a-fA-F0-9]{16}$'){
      $cache=Resolve-Safe ('.updates/'+$relative)
      Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}catch{
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $updates 'last-error.txt') -Encoding UTF8
  if($newProcess){
    if(-not $newProcess.HasExited){Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue}
    if(-not $newProcess.WaitForExit(10000)){throw 'Replacement application did not stop; recovery journal retained.'}
    $newProcess.Dispose()
    $newProcess=$null
  }
  Restore-Previous
  Remove-Item -LiteralPath $applying,$journal,$marker,$pending -Force -ErrorAction SilentlyContinue
  $null=Start-App $false
}
""";
}

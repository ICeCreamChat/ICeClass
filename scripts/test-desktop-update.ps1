param([string]$Dotnet = '')
$ErrorActionPreference = 'Stop'
$desktopProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Dotnet) {
    $Dotnet = Join-Path $desktopProjectRoot '.tools\desktop-sdk\runtime\dotnet.exe'
    if (-not (Test-Path -LiteralPath $Dotnet)) { $Dotnet = 'dotnet' }
}
if ($PSVersionTable.PSEdition -eq 'Core') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Dotnet $Dotnet
    if ($LASTEXITCODE -ne 0) { throw 'Desktop updater checks failed.' }
    return
}
$desktopTestRoot = Join-Path $desktopProjectRoot ('.tools\desktop-update-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $desktopTestRoot | Out-Null
try {
    $desktopApplyScript = Join-Path $desktopTestRoot 'apply.ps1'
    & $Dotnet run --project (Join-Path $desktopProjectRoot 'tests\DesktopChecks\DesktopChecks.csproj') -c Release --no-launch-profile -- --export-updater $desktopApplyScript
    if ($LASTEXITCODE -ne 0) { throw 'Could not export update helper.' }
    $desktopFixtures = @{}
    foreach ($desktopVariant in @('old', 'ready', 'failed')) {
        $desktopType = 'DesktopUpdateFixture' + $desktopVariant + [Guid]::NewGuid().ToString('N')
        $desktopFixture = Join-Path $desktopTestRoot ($desktopVariant + '.exe')
        $desktopSource = @"
using System;
using System.IO;
public class $desktopType {
  [STAThread] public static void Main(string[] args) {
    File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launched.txt"), "$desktopVariant\n" + string.Join("\n", args) + "\n");
    int marker = Array.IndexOf(args, "--update-marker");
    if ("$desktopVariant" == "ready" && marker >= 0 && marker + 1 < args.Length) File.WriteAllText(args[marker+1], "ready");
  }
}
"@
        Add-Type -TypeDefinition $desktopSource -OutputAssembly $desktopFixture -OutputType WindowsApplication
        $desktopFixtures[$desktopVariant] = $desktopFixture
    }
    foreach ($desktopCase in @('ready', 'failed', 'integrity')) {
        $desktopCaseRoot = Join-Path $desktopTestRoot $desktopCase
        $desktopUpdates = Join-Path $desktopCaseRoot '.updates'
        New-Item -ItemType Directory -Path $desktopUpdates | Out-Null
        $desktopCurrent = Join-Path $desktopCaseRoot 'ICeClass.Desktop.exe'
        $desktopDownloaded = Join-Path $desktopUpdates 'new.download'
        $desktopHelper = Join-Path $desktopUpdates 'apply.ps1'
        Copy-Item -LiteralPath $desktopFixtures.old -Destination $desktopCurrent
        $desktopNext = if ($desktopCase -eq 'failed') { $desktopFixtures.failed } else { $desktopFixtures.ready }
        Copy-Item -LiteralPath $desktopNext -Destination $desktopDownloaded
        Copy-Item -LiteralPath $desktopApplyScript -Destination $desktopHelper
        $desktopDigest = (Get-FileHash -LiteralPath $desktopDownloaded -Algorithm SHA256).Hash
        if ($desktopCase -eq 'integrity') { $desktopDigest = '0' * 64 }
        $desktopProfile = Join-Path $desktopCaseRoot 'profile with spaces'
        $desktopResume = '"--data-dir" "' + $desktopProfile + '" "--server" "http://127.0.0.1:8838"'
        $desktopEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($desktopResume))
        $desktopOldProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -Command "Start-Sleep -Milliseconds 700"' -WindowStyle Hidden -PassThru
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desktopHelper $desktopOldProcess.Id $desktopCurrent $desktopDownloaded $desktopDigest $desktopEncoded
        if ($LASTEXITCODE -ne 0) { throw "Update helper failed: $desktopCase" }
        $desktopExpected = if ($desktopCase -eq 'ready') { $desktopFixtures.ready } else { $desktopFixtures.old }
        if ((Get-FileHash -LiteralPath $desktopCurrent).Hash -ne (Get-FileHash -LiteralPath $desktopExpected).Hash) { throw "Wrong executable after $desktopCase" }
        if ($desktopCase -ne 'integrity') {
            $desktopProof = Join-Path $desktopCaseRoot 'launched.txt'
            for ($desktopAttempt = 0; $desktopAttempt -lt 20; $desktopAttempt++) {
                if (Test-Path -LiteralPath $desktopProof) {
                    $desktopObserved = Get-Content -LiteralPath $desktopProof -Raw
                    if ($desktopObserved.Contains($desktopProfile) -and ($desktopCase -ne 'failed' -or $desktopObserved.Contains("old`n"))) { break }
                }
                Start-Sleep -Milliseconds 100
            }
            $desktopLaunched = Get-Content -LiteralPath $desktopProof -Raw
            if (-not $desktopLaunched.Contains($desktopProfile)) { throw "Profile arguments lost: $desktopCase" }
            if ($desktopCase -eq 'failed' -and -not $desktopLaunched.Contains("old`n")) { throw 'Previous version did not restart.' }
        }
        Write-Host "Desktop update $desktopCase passed."
    }
} finally {
    Get-CimInstance Win32_Process -Filter "Name='ICeClass.Desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($desktopTestRoot + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 5 -ErrorAction SilentlyContinue }
    $desktopResolved = [IO.Path]::GetFullPath($desktopTestRoot)
    $desktopAllowed = [IO.Path]::GetFullPath((Join-Path $desktopProjectRoot '.tools')).TrimEnd('\') + '\'
    if ($desktopResolved.StartsWith($desktopAllowed, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $desktopResolved)) {
        Remove-Item -LiteralPath $desktopResolved -Recurse -Force
    }
}

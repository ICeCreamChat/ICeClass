#Requires -Version 7.0
param([string]$ArtifactRoot)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageScript = Join-Path $PSScriptRoot 'package-video-booth-plugin.ps1'
if (!$ArtifactRoot) {
    $ArtifactRoot = Join-Path $projectRoot ('.tools/video-booth-workbench/package-guard-' + [guid]::NewGuid().ToString('N'))
}
$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if (Test-Path -LiteralPath $ArtifactRoot) { throw "测试目录已存在：$ArtifactRoot" }
New-Item -ItemType Directory -Path $ArtifactRoot | Out-Null

# Stop at the first SDK invocation; never run an SDK or publish a package.
function Invoke-PackageSdkSentinel {
    [IO.File]::AppendAllText($sdkMarker, ($args -join ' ') + [Environment]::NewLine)
    throw 'PACKAGE_TEST_SDK_BOUNDARY'
}

$failures = @()
$passed = 0
foreach ($rid in @('win-x64', 'win-x86')) {
    $caseIndex = 0
    foreach ($legacyPath in @('VideoBooth.exe', 'nested/VideoBooth.exe', 'vIdEoBoOtH.ExE', 'nested/deeper/VIDEOBOOTH.EXE', $null)) {
        $caseIndex++
        $name = if ($null -eq $legacyPath) { 'healthy' } else { $legacyPath.Replace('/', '-') }
        $caseRoot = Join-Path $ArtifactRoot "$rid-$caseIndex-$name"
        $browser = Join-Path $caseRoot 'browser'
        $output = Join-Path $caseRoot 'output'
        $sdkMarker = Join-Path $caseRoot 'sdk-boundary.txt'
        New-Item -ItemType Directory -Path $browser | Out-Null

        # Minimal PE data accepted by the production architecture check.
        $pe = [byte[]]::new(70)
        $pe[0] = 77; $pe[1] = 90; $pe[60] = 64; $pe[64] = 80; $pe[65] = 69
        if ($rid -eq 'win-x64') { $pe[68] = 0x64; $pe[69] = 0x86 }
        else { $pe[68] = 0x4c; $pe[69] = 0x01 }
        [IO.File]::WriteAllBytes((Join-Path $browser 'msedgewebview2.exe'), $pe)
        if ($null -ne $legacyPath) {
            $legacy = Join-Path $browser $legacyPath
            New-Item -ItemType Directory -Path (Split-Path -Parent $legacy) -Force | Out-Null
            [IO.File]::WriteAllBytes($legacy, $pe)
        } else {
            # The current entry name must not match the old filename guard.
            [IO.File]::WriteAllBytes((Join-Path $browser 'ICeClass.VideoBooth.exe'), $pe)
        }

        $caught = $null
        try {
            & $packageScript -Runtime $rid -Dotnet Invoke-PackageSdkSentinel -OutputRoot $output -BrowserX64 $browser -BrowserX86 $browser
        } catch { $caught = $_.Exception.Message }
        $sdkReached = Test-Path -LiteralPath $sdkMarker
        $outputCreated = Test-Path -LiteralPath $output
        $valid = if ($null -eq $legacyPath) {
            $caught -eq 'PACKAGE_TEST_SDK_BOUNDARY' -and $sdkReached -and
                (Get-Content -LiteralPath $sdkMarker -Raw).Trim() -eq '--version' -and !$outputCreated
        } else {
            $caught -like '*旧展台入口*' -and $caught.Contains($legacy) -and !$sdkReached -and !$outputCreated
        }
        if ($valid) {
            $passed++
            Write-Output "PASS $rid $name; SDK reached=$sdkReached; output created=$outputCreated"
        } else {
            $failures += "$rid $name; error=$caught; SDK reached=$sdkReached; output created=$outputCreated"
            Write-Output "FAIL $($failures[-1])"
        }
    }
}
Write-Output "Artifacts retained: $ArtifactRoot"
if ($failures.Count) { throw "$($failures.Count) package guard checks failed; $passed passed." }
Write-Output "PASS $passed package guard checks; no SDK or publish executed."

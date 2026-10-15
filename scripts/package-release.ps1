param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
if (-not $SkipBuild) {
    $env:ICECLASS_NO_PAUSE = '1'
    & (Join-Path $projectRoot 'build.bat')
    if ($LASTEXITCODE -ne 0) { throw '教室端构建失败。' }
}

$receiver = Join-Path $projectRoot 'dist\receiver\ICeClass.exe'
if (-not (Test-Path -LiteralPath $receiver)) { throw '缺少 dist\receiver\ICeClass.exe，请先构建。' }
$project = [xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Receiver\Receiver.csproj') -Raw -Encoding UTF8)
$version = [string]$project.Project.PropertyGroup.Version
$releaseRoot = Join-Path $projectRoot 'dist\release'
$stage = Join-Path $releaseRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
$windowsRoot = Join-Path $stage 'ICeClass'
$serverRoot = Join-Path $stage 'ICeClass-server'
New-Item -ItemType Directory -Force -Path $windowsRoot, $serverRoot | Out-Null
try {
    & (Join-Path $PSScriptRoot 'prepare-delivery.ps1') -Unconfigured -OutputDirectory $windowsRoot
    foreach ($directory in @('server', 'cloud\migrations', 'receiver_release')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $serverRoot $directory) | Out-Null
    }
    foreach ($name in @('app.py', 'reading.py', 'management.py', 'requirements.txt', 'install-ubuntu.sh')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "server\$name") -Destination (Join-Path $serverRoot "server\$name")
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'web_controller') -Destination $serverRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'cloud\migrations\0001_initial.sql') -Destination (Join-Path $serverRoot 'cloud\migrations\0001_initial.sql')
    Copy-Item -LiteralPath $receiver -Destination (Join-Path $serverRoot 'receiver_release\ICeClass.exe')
    $manifest = [ordered]@{ version = $version; sha256 = (Get-FileHash -LiteralPath $receiver -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $receiver).Length } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $serverRoot 'receiver_release\manifest.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
    foreach ($name in @('README.md', 'LICENSE', 'docs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $serverRoot -Recurse
    }
    $windowsZip = Join-Path $releaseRoot "ICeClass-$version-windows-x64.zip"
    $serverZip = Join-Path $releaseRoot "ICeClass-$version-server.zip"
    Compress-Archive -LiteralPath $windowsRoot -DestinationPath $windowsZip -Force
    Compress-Archive -LiteralPath $serverRoot -DestinationPath $serverZip -Force
    Write-Host '班伴发布包已生成：' -ForegroundColor Green
    Write-Host $windowsZip
    Write-Host $serverZip
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedReleaseRoot = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedReleaseRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}

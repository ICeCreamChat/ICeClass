param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
if (-not $SkipBuild) {
    $env:ICECLASS_NO_PAUSE = '1'
    & (Join-Path $projectRoot 'build.bat')
    if ($LASTEXITCODE -ne 0) { throw '教室端构建失败。' }
    & (Join-Path $PSScriptRoot 'build-desktop.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Windows 教师端构建失败。' }
}
$desktopExecutable = Join-Path $projectRoot 'dist\desktop\ICeClass.Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable)) { throw '缺少Windows 教师端，请先运行 build-desktop.bat。' }
$receiver = Join-Path $projectRoot 'dist\receiver\ICeClass.exe'
if (-not (Test-Path -LiteralPath $receiver)) { throw '缺少 dist\receiver\ICeClass.exe，请先构建。' }
$project = [xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Receiver\Receiver.csproj') -Raw -Encoding UTF8)
$version = [string]$project.Project.PropertyGroup.Version
$releaseRoot = Join-Path $projectRoot 'dist\release'
$stage = Join-Path $releaseRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
$windowsRoot = Join-Path $stage 'ICeClass'
$serverRoot = Join-Path $stage 'ICeClass-server'
$classroomRoot = Join-Path $stage 'classroom\ICeClass'
New-Item -ItemType Directory -Force -Path $windowsRoot, $serverRoot | Out-Null
try {
    & (Join-Path $PSScriptRoot 'prepare-delivery.ps1') -Unconfigured -OutputDirectory $windowsRoot
    New-Item -ItemType Directory -Force -Path (Join-Path $classroomRoot '教室端') | Out-Null
    foreach ($name in @('ICeClass.exe', '一步使用说明.txt')) {
        Copy-Item -LiteralPath (Join-Path $windowsRoot "教室端\$name") -Destination (Join-Path $classroomRoot "教室端\$name")
    }
    [IO.File]::WriteAllText((Join-Path $classroomRoot '网页端.url'), "[InternetShortcut]`r`nURL=https://iceclass.icecreamchat.top/`r`n", [Text.Encoding]::ASCII)
    foreach ($directory in @('server', 'cloud\migrations', 'receiver_release', 'desktop_release', 'scripts')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $serverRoot $directory) | Out-Null
    }
    $serverModules = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'server') -File |
        Where-Object { $_.Extension -eq '.py' -and $_.Name -notlike 'test_*' -and $_.Name -ne 'preview.py' }
    foreach ($module in $serverModules) {
        Copy-Item -LiteralPath $module.FullName -Destination (Join-Path $serverRoot 'server')
    }
    foreach ($name in @('requirements.txt', 'install-ubuntu.sh')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "server\$name") -Destination (Join-Path $serverRoot 'server')
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-ubuntu.sh') -Destination (Join-Path $serverRoot 'scripts\update-ubuntu.sh')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'web_controller') -Destination $serverRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot 'cloud\migrations\0001_initial.sql') -Destination (Join-Path $serverRoot 'cloud\migrations\0001_initial.sql')
    Copy-Item -LiteralPath $receiver -Destination (Join-Path $serverRoot 'receiver_release\ICeClass.exe')
    $manifest = [ordered]@{ version = $version; sha256 = (Get-FileHash -LiteralPath $receiver -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $receiver).Length } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $serverRoot 'receiver_release\manifest.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
    Copy-Item -LiteralPath $desktopExecutable -Destination (Join-Path $serverRoot 'desktop_release\ICeClass.Desktop.exe')
    $desktopProject = [xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Desktop\ICeClass.Desktop.csproj') -Raw -Encoding UTF8)
    $desktopManifest = [ordered]@{ version = [string]$desktopProject.Project.PropertyGroup.Version; sha256 = (Get-FileHash -LiteralPath $desktopExecutable -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $desktopExecutable).Length } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $serverRoot 'desktop_release\manifest.json'), $desktopManifest, (New-Object Text.UTF8Encoding($false)))
    foreach ($name in @('README.md', 'LICENSE', 'docs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $serverRoot -Recurse
    }
    $windowsZip = Join-Path $releaseRoot "ICeClass-$version-windows-x64.zip"
    $serverZip = Join-Path $releaseRoot "ICeClass-$version-server.zip"
    $classroomZip = Join-Path $releaseRoot "ICeClass-$version-classroom.zip"
    $desktopZip = Join-Path $releaseRoot "ICeClass-$version-desktop-windows-x64.zip"
    Compress-Archive -LiteralPath $windowsRoot -DestinationPath $windowsZip -Force
    Compress-Archive -LiteralPath $serverRoot -DestinationPath $serverZip -Force
    Compress-Archive -LiteralPath $classroomRoot -DestinationPath $classroomZip -Force
    Compress-Archive -LiteralPath (Join-Path $windowsRoot 'Windows教师端') -DestinationPath $desktopZip -Force
    Write-Host 'ICeClass 班伴发布包已生成：' -ForegroundColor Green
    Write-Host $windowsZip
    Write-Host $serverZip
    Write-Host $classroomZip
    Write-Host $desktopZip
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedReleaseRoot = [IO.Path]::GetFullPath($releaseRoot).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedReleaseRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}

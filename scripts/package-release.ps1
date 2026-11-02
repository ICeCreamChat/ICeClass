param(
    [switch]$SkipBuild,
    [string]$DistributionDirectory = '',
    [string]$PreviousServerDirectory = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
if ($DistributionDirectory -and -not $SkipBuild) { throw '使用已有构建目录时请同时传入 -SkipBuild。' }
$distributionRoot = if ($DistributionDirectory) { [IO.Path]::GetFullPath($DistributionDirectory) } else { Join-Path $projectRoot 'dist' }
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build-classroom.ps1')
    & (Join-Path $PSScriptRoot 'build-desktop.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Windows 教师端构建失败。' }
}
$desktopExecutable = Join-Path $distributionRoot 'desktop\ICeClass.Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable)) { throw '缺少Windows 教师端，请先运行 build-desktop.bat。' }
$receiver = Join-Path $distributionRoot 'receiver\ICeClass.exe'
if (-not (Test-Path -LiteralPath $receiver)) { throw '缺少 dist\receiver\ICeClass.exe，请先构建。' }
$receiverCore = Join-Path $distributionRoot 'receiver-core\ICeClass.exe'
if (-not (Test-Path -LiteralPath $receiverCore -PathType Leaf)) { throw '缺少 receiver-core\ICeClass.exe，请运行 build.bat 生成精简更新核心。' }
$payloadPython = 'python.exe'
if ($env:ICECLASS_PYTHON) { $payloadPython = $env:ICECLASS_PYTHON }
$previousServerRoot = if ($PreviousServerDirectory) { [IO.Path]::GetFullPath($PreviousServerDirectory) } else { '' }
if ($previousServerRoot) {
    foreach ($directory in @('receiver_release', 'desktop_release')) {
        if (-not (Test-Path -LiteralPath (Join-Path $previousServerRoot "$directory\update-plan.json") -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $previousServerRoot "$directory\payloads") -PathType Container)) {
            throw "上一版服务端缺少 $directory 的 update-plan.json 或 payloads：$previousServerRoot"
        }
    }
}
$project = [xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Receiver\Receiver.csproj') -Raw -Encoding UTF8)
$version = [string]$project.Project.PropertyGroup.Version
$releaseRoot = Join-Path $distributionRoot 'release'
$stage = Join-Path $releaseRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
$windowsRoot = Join-Path $stage 'ICeClass'
$serverRoot = Join-Path $stage 'ICeClass-server'
$classroomRoot = Join-Path $stage 'classroom\ICeClass'
New-Item -ItemType Directory -Force -Path $windowsRoot, $serverRoot | Out-Null
try {
    & (Join-Path $PSScriptRoot 'prepare-delivery.ps1') -Unconfigured -OutputDirectory $windowsRoot -DistributionDirectory $distributionRoot
    New-Item -ItemType Directory -Force -Path (Join-Path $classroomRoot '教室端') | Out-Null
    foreach ($name in @('ICeClass.exe', '一步使用说明.txt', 'install.ps1', '安装或升级.cmd', 'program-manifest.json')) {
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
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'cloud\migrations') -Filter '*.sql' -File |
        Copy-Item -Destination (Join-Path $serverRoot 'cloud\migrations')
    Copy-Item -LiteralPath $receiver -Destination (Join-Path $serverRoot 'receiver_release\ICeClass.exe')
    foreach ($name in @('install.ps1', '安装或升级.cmd', 'program-manifest.json', '一步使用说明.txt')) {
        Copy-Item -LiteralPath (Join-Path $windowsRoot "教室端\$name") -Destination (Join-Path $serverRoot "receiver_release\$name")
    }
    $manifest = [ordered]@{ version = $version; sha256 = (Get-FileHash -LiteralPath $receiver -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $receiver).Length } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $serverRoot 'receiver_release\manifest.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
    Copy-Item -LiteralPath $desktopExecutable -Destination (Join-Path $serverRoot 'desktop_release\ICeClass.Desktop.exe')
    $desktopProject = [xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Desktop\ICeClass.Desktop.csproj') -Raw -Encoding UTF8)
    $desktopManifest = [ordered]@{ version = [string]$desktopProject.Project.PropertyGroup.Version; sha256 = (Get-FileHash -LiteralPath $desktopExecutable -Algorithm SHA256).Hash.ToLowerInvariant(); size = (Get-Item -LiteralPath $desktopExecutable).Length } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $serverRoot 'desktop_release\manifest.json'), $desktopManifest, (New-Object Text.UTF8Encoding($false)))
    $receiverPayloadArguments = @(
        (Join-Path $PSScriptRoot 'prepare-update-payloads.py'),
        '--project', (Join-Path $projectRoot 'Receiver\Receiver.csproj'),
        '--executable', $receiverCore,
        '--voice-directory', (Join-Path $projectRoot 'Receiver\Assets\Voice'),
        '--release-directory', (Join-Path $serverRoot 'receiver_release')
    )
    $desktopPayloadArguments = @(
        (Join-Path $PSScriptRoot 'prepare-update-payloads.py'),
        '--project', (Join-Path $projectRoot 'Desktop\ICeClass.Desktop.csproj'),
        '--executable', $desktopExecutable,
        '--release-directory', (Join-Path $serverRoot 'desktop_release')
    )
    if ($previousServerRoot) {
        $receiverPayloadArguments += @('--previous-release-directory', (Join-Path $previousServerRoot 'receiver_release'))
        $desktopPayloadArguments += @('--previous-release-directory', (Join-Path $previousServerRoot 'desktop_release'))
    }
    & $payloadPython @receiverPayloadArguments
    if ($LASTEXITCODE -ne 0) { throw '教室端文件更新计划或 MSDelta 验证失败，未生成本次发布包。' }
    & $payloadPython @desktopPayloadArguments
    if ($LASTEXITCODE -ne 0) { throw '教师端文件更新计划或 MSDelta 验证失败，未生成本次发布包。' }
    foreach ($name in @('README.md', 'LICENSE', 'docs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $serverRoot -Recurse
    }
    # The repository's local operations guide is intentionally excluded from delivery as well as Git.
    $localOperationsGuide = Join-Path $serverRoot 'docs\腾讯云API运维.md'
    if (Test-Path -LiteralPath $localOperationsGuide) { Remove-Item -LiteralPath $localOperationsGuide -Force }
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

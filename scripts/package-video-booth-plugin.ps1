#Requires -Version 7.0
param(
    [ValidateSet('win-x64', 'win-x86')][string[]]$Runtime = @('win-x64', 'win-x86'),
    [string]$Dotnet = 'dotnet',
    [string]$OutputRoot,
    [string]$BrowserX64,
    [string]$BrowserX86,
    [string]$PreparationService = 'https://icecreamchat.top/videobooth-preparation/',
    [string]$CameraDomain = 'camera.icecreamchat.top',
    [string]$OnlineService = 'https://icecreamchat.top/videobooth-connect'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $projectRoot 'plugins/VideoBooth'
$project = Join-Path $pluginRoot 'ICeClass.VideoBooth.csproj'
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot ('output/video-booth-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw "输出目录已存在，请使用新目录：$OutputRoot" }
if ($Runtime.Count -ne @($Runtime | Select-Object -Unique).Count) { throw 'Runtime 不得重复。' }

function Assert-NoLinks([string]$Path) {
    for ($ancestor = [IO.Path]::GetFullPath($Path); $ancestor; $ancestor = Split-Path -Parent $ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "路径不能包含链接或目录联接：$ancestor"
        }
    }
}
function Assert-PublicFiles([string]$Root) {
    Assert-NoLinks $Root
    foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "不能打包链接：$($item.FullName)" }
        if (!$item.PSIsContainer -and $item.Name -ieq 'VideoBooth.exe') {
            throw "新插件包不得包含旧展台入口：$($item.FullName)"
        }
        if (($item.PSIsContainer -and $item.Name -in @('data', 'preserved-data', 'User Data', 'UserData', 'browser-profile', 'cache', 'caches')) -or
            (!$item.PSIsContainer -and ($item.Name -in @('config.json', 'settings.json', 'state.json', 'video-booth-state.json') -or
                $item.Extension -in @('.pfx', '.p12', '.key', '.pem', '.ppk', '.jks', '.keystore', '.dpapi', '.db')))) {
            throw "分发目录含私人资料或状态，未生成 ZIP：$($item.FullName)"
        }
    }
}
function Assert-Executable([IO.Stream]$Stream, [string]$Rid) {
    $reader = [IO.BinaryReader]::new($Stream, [Text.Encoding]::UTF8, $true)
    try {
        $header = $reader.ReadBytes(64)
        if ($header.Length -ne 64 -or $header[0] -ne 77 -or $header[1] -ne 90) { throw '入口不是 Windows 程序。' }
        $offset = [BitConverter]::ToInt32($header, 60)
        if ($offset -lt 64 -or $offset -gt 1048576) { throw '程序头无效。' }
        if ($reader.ReadBytes($offset - 64).Length -ne ($offset - 64) -or $reader.ReadUInt32() -ne 0x4550) { throw '程序头无效。' }
        $expected = if ($Rid -eq 'win-x64') { 0x8664 } else { 0x14c }
        if ($reader.ReadUInt16() -ne $expected) { throw "程序架构不符：$Rid" }
    } finally { $reader.Dispose() }
}

Assert-NoLinks $OutputRoot
foreach ($endpoint in @($PreparationService, $OnlineService)) {
    $uri = [uri]$endpoint
    if (!$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw '公共服务配置必须为无凭据的 HTTPS 地址。'
    }
}
if ([uri]::CheckHostName($CameraDomain) -ne 'Dns') { throw 'CameraDomain 必须为域名。' }
$version = ([xml](Get-Content -LiteralPath $project -Raw)).Project.PropertyGroup.Version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw '插件版本必须为三段非负整数。' }
foreach ($notice in @('README.md', 'NOTICE.md', 'licenses')) {
    if (!(Test-Path -LiteralPath (Join-Path $pluginRoot $notice))) { throw "缺少分发说明：$notice" }
}
$browsers = @{}
foreach ($rid in $Runtime) {
    $source = if ($rid -eq 'win-x64') { $BrowserX64 } else { $BrowserX86 }
    if (!$source) { throw "请指定 $rid 的固定 WebView2 路径。" }
    $source = [IO.Path]::GetFullPath($source)
    Assert-PublicFiles $source
    $stream = [IO.File]::OpenRead((Join-Path $source 'msedgewebview2.exe'))
    try { Assert-Executable $stream $rid } finally { $stream.Dispose() }
    $browsers[$rid] = $source
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Push-Location $pluginRoot
try {
    $sdk = & $Dotnet --version
    if ($LASTEXITCODE -ne 0 -or $sdk -notmatch '^10\.') { throw '视频展台构建需要 .NET 10 SDK。' }
    New-Item -ItemType Directory -Path $OutputRoot | Out-Null
    foreach ($rid in $Runtime) {
        $package = Join-Path $OutputRoot "ICeClass-VideoBooth-$rid"
        & $Dotnet publish $project -c Release -r $rid --self-contained true -o $package --nologo -v minimal `
            '-p:DebugType=None' '-p:DebugSymbols=false' '-p:UseSharedCompilation=false' '-m:1'
        if ($LASTEXITCODE -ne 0) { throw "$rid 发布失败，未生成插件 ZIP。" }
        Copy-Item -LiteralPath $browsers[$rid] -Destination (Join-Path $package 'browser') -Recurse
        Copy-Item -LiteralPath (Join-Path $pluginRoot 'README.md') -Destination $package
        Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $package
        @{schemaVersion = 1; id = 'iceclass.video-booth'; name = '视频展台'; version = $version; hostApiVersion = 1; runtime = $rid; entryPoint = 'ICeClass.VideoBooth.exe'} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $package 'plugin.json') -Encoding utf8NoBOM
        @{url = $PreparationService; cameraDomain = $CameraDomain} | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $package 'preparation-service.json') -Encoding utf8NoBOM
        @{url = $OnlineService} | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $package 'online-service.json') -Encoding utf8NoBOM
        Assert-PublicFiles $package
        if (Test-Path -LiteralPath (Join-Path $package 'VideoBooth.exe')) { throw '新插件包不得包含旧展台入口。' }
        $zipPath = Join-Path $OutputRoot "ICeClass-VideoBooth-$rid.zip"
        [IO.Compression.ZipFile]::CreateFromDirectory($package, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
        $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($entry in $archive.Entries) {
                if (!$names.Add($entry.FullName)) { throw "ZIP 路径重复：$($entry.FullName)" }
            }
            foreach ($required in @('plugin.json', 'ICeClass.VideoBooth.exe', 'browser/msedgewebview2.exe')) {
                if (!$names.Contains($required)) { throw "插件 ZIP 缺少：$required" }
            }
            $stream = $archive.GetEntry('ICeClass.VideoBooth.exe').Open()
            try { Assert-Executable $stream $rid } finally { $stream.Dispose() }
        } finally { $archive.Dispose() }
        Write-Output $zipPath
    }
} finally { Pop-Location }

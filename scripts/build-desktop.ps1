param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
Set-Location $desktopRoot
$desktopDotnet = 'dotnet'
if (Test-Path '.tools\dotnet\dotnet.exe') { $desktopDotnet = (Resolve-Path '.tools\dotnet\dotnet.exe').Path }
if (Test-Path '.tools\desktop-sdk\runtime\dotnet.exe') { $desktopDotnet = (Resolve-Path '.tools\desktop-sdk\runtime\dotnet.exe').Path }
if ($env:ICECLASS_DOTNET) { $desktopDotnet = $env:ICECLASS_DOTNET }
if (-not $SkipBuild) {
    & $desktopDotnet publish 'Desktop\ICeClass.Desktop.csproj' -c Release -r win-x64 --self-contained true -o 'dist\desktop' -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Windows 教师端构建失败。' }
}
$desktopExecutable = Join-Path $desktopRoot 'dist\desktop\ICeClass.Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable)) { throw '找不到Windows 教师端 EXE。' }
$desktopPackage = Join-Path $desktopRoot 'dist\desktop-delivery\ICeClass 班伴 教师端'
New-Item -ItemType Directory -Force -Path $desktopPackage | Out-Null
Copy-Item -LiteralPath $desktopExecutable -Destination $desktopPackage -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-desktop.ps1') -Destination (Join-Path $desktopPackage 'install.ps1') -Force
[IO.File]::WriteAllText((Join-Path $desktopPackage '安装到本机.cmd'), "@echo off`r`ncd /d `"%~dp0`"`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0install.ps1`"`r`nif errorlevel 1 pause`r`n", [Text.Encoding]::ASCII)
$desktopInstructions = @'
ICeClass 班伴 · 教师端 · Windows 10/11 64 位

双击“安装到本机.cmd”，会安装到当前 Windows 用户的应用目录，并创建桌面和开始菜单图标，无需管理员权限。
也可以将本文件夹放到固定位置，直接双击 ICeClass.Desktop.exe 使用。

使用学校平台原有账号、密码登录。教师、主任、校长与超级管理员沿用网站权限，不需要教室绑定码。
晨读统计、通知、教室来音和班班与学校平台使用同一份数据；软件本身不会把个人电脑绑定成教室白板。
工作台连接学校服务器使用，查询、发送通知、播放云端来音和 AI 分析均需要联网。关闭窗口后收起到托盘；从桌面或托盘再次打开，托盘菜单“退出 ICeClass 班伴 · 教师端”才结束程序。

学校平台地址通常无需修改。不同部署可在顶部“桌面设置”中修改网址；班班的 Base URL、API Key 和模型仍在班班自己的连接设置中填写。
导出 XLSX 时选择保存位置。语音功能首次使用时由页面询问麦克风权限。
网页登录和桌面端的登录资料独立，电脑端不直接沿用浏览器的登录状态。

网页功能随学校平台更新。桌面程序可以从托盘或“关于 → 检查桌面更新”下载并安装新版本，先保存尚未提交的内容，更新不清理登录资料。
弱网时请稍候或手动重试；此客户端不提供离线发送通知、播放云端来音或离线 AI 分析。
如提示缺少 WebView2，点击官方运行组件入口安装后重新打开；无需安装 .NET、Python 或 Node.js。

可在 Windows“已安装的应用”中卸载“ICeClass 班伴 · 教师端”。卸载保留本机登录资料；退出学校账号请先在工作台右上角点击“退出”。
许可与第三方说明在顶部“关于”中查看。
'@
Set-Content -LiteralPath (Join-Path $desktopPackage '使用说明.txt') -Value $desktopInstructions -Encoding utf8
$desktopProject = [xml](Get-Content -LiteralPath 'Desktop\ICeClass.Desktop.csproj' -Raw -Encoding UTF8)
$desktopVersion = [string]$desktopProject.Project.PropertyGroup.Version
New-Item -ItemType Directory -Force -Path 'dist\release' | Out-Null
$desktopZip = Join-Path $desktopRoot "dist\release\ICeClass-$desktopVersion-desktop-windows-x64.zip"
Compress-Archive -LiteralPath $desktopPackage -DestinationPath $desktopZip -Force
Write-Host "Windows 教师端：$desktopExecutable"
Write-Host "安装文件夹：$desktopPackage"
Write-Host "分发压缩包：$desktopZip"

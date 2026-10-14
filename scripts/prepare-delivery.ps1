param(
    [string]$Endpoint = '',
    [switch]$Unconfigured,
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Read-Endpoint {
    $savedPath = Join-Path (Get-Location) 'dist\delivery\cloud-url.txt'
    if (Test-Path -LiteralPath $savedPath) {
        $saved = (Get-Content -LiteralPath $savedPath -Raw).Trim()
        if ($saved) { return $saved.TrimEnd('/') }
    }

    $entered = Read-Host '请输入部署完成后的班伴 HTTPS 网址'
    $entered = $entered.Trim().TrimEnd('/')
    $parsed = $null
    if (-not [Uri]::TryCreate($entered, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne [Uri]::UriSchemeHttps) {
        throw '网址无效。请使用部署完成后显示的 https:// 正式地址。'
    }
    return $entered
}

$receiver = Join-Path (Get-Location) 'dist\receiver\ICeClass.exe'
if (-not (Test-Path -LiteralPath $receiver)) {
    throw '找不到 dist\receiver\ICeClass.exe。请先在管理员电脑运行 build.bat。'
}

if ($Unconfigured) { $Endpoint = '' }
elseif (-not $Endpoint) { $Endpoint = Read-Endpoint }
if ($Endpoint) {
    $Endpoint = $Endpoint.Trim().TrimEnd('/')
    $parsedEndpoint = $null
    if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$parsedEndpoint) -or $parsedEndpoint.Scheme -ne [Uri]::UriSchemeHttps) {
        throw '正式交付地址必须是有效的 HTTPS 网址。'
    }
}
$receiverVersion = ''
$receiverVersionMatch = Select-String -LiteralPath (Join-Path (Get-Location) 'Receiver\Receiver.csproj') -Pattern '<Version>([^<]+)</Version>'
if ($receiverVersionMatch) { $receiverVersion = $receiverVersionMatch.Matches[0].Groups[1].Value }
$delivery = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path (Get-Location) 'dist\delivery' }
$classroom = Join-Path $delivery '教室端'
New-Item -ItemType Directory -Force -Path $classroom | Out-Null
Copy-Item -LiteralPath $receiver -Destination (Join-Path $classroom 'ICeClass.exe') -Force
if ($Endpoint) {
    Set-Content -LiteralPath (Join-Path $delivery 'cloud-url.txt') -Value $Endpoint -Encoding utf8
    Set-Content -LiteralPath (Join-Path $classroom 'cloud-url.txt') -Value $Endpoint -Encoding utf8

$shortcut = @"
[InternetShortcut]
URL=$Endpoint
IconFile=$Endpoint/favicon.svg
IconIndex=0
"@
Set-Content -LiteralPath (Join-Path $delivery '教师端.url') -Value $shortcut -Encoding ascii
} else {
    foreach ($relative in @('cloud-url.txt', '教室端\cloud-url.txt', '教师端.url')) {
        Remove-Item -LiteralPath (Join-Path $delivery $relative) -Force -ErrorAction SilentlyContinue
    }
}

$classroomReadme = @'
教室电脑一步使用

1. 把这个文件夹复制到教室电脑的固定位置，例如 D:\ICeClass。
2. 双击 ICeClass.exe。
3. 若未预置网址，先输入管理员提供的班伴 HTTPS 网址。
4. 在 ICe 管理网页的“班级管理”中生成该班的一次性绑定码，并在窗口中输入。
5. 点击“绑定并开始接收”。以后电脑开机后会自动在后台连接平台。

早读陪伴

点击教室工具窗口或托盘菜单中的“打开早读陪伴”，允许浏览器使用麦克风，选择模式后开始。
管理员统一设置早读时段和玩法参数。只有指定时段内、页面可见且正在运行的活动计入统计。

每个绑定码只能使用一次，15 分钟后失效。不要把 config.json 或绑定码发到公开群聊。

以后更新

管理员更新服务器后，教室端会在后台自动检查并安装新版。也可以右键系统托盘图标，点击“检查更新”，或在设置窗口点击同名按钮。
更新不会删除本机 config.json、班级绑定或开机自启动设置。更新过程中程序会自动重启，通常不需要重新绑定。

通知声音

普通通知只在右下角显示，不播放声音。重要通知显示顶部横幅并播放声音，紧急通知全屏显示并播放声音。

学生向老师留言

教室端启动后会直接打开“向老师语音留言”窗口；如果窗口被关闭，单击或双击托盘图标即可重新打开。点击“点击开始录音”，再次点击“点击结束并发送”，学生语音不会在教室端外放，教师在网页“教室来音”中点击“播放语音”。每段最多 30 秒。
'@
Set-Content -LiteralPath (Join-Path $classroom '一步使用说明.txt') -Value $classroomReadme -Encoding utf8

$teacherReadme = @'
教师端一步使用

正式地址配置后，双击同目录的“教师端.url”，或打开管理员提供的网址，输入账号和密码。
手机可在浏览器中打开同一网址，再选择“添加到主屏幕”。

登录后可在“早读统计”查看授权班级的每天使用次数、有效发声时长和各模式完成量。
比赛按管理员时段内的有效发声时长排序；教师可以选择模式和内容，但不能调整声量门槛与目标参数。

普通通知只显示静音弹窗；重要和紧急通知会播放声音。语音喊话只能使用重要或紧急。
禁言上课时间内，网页会在发送前提醒；取消后教室端什么都不会出现，确认“仍然发送”后才会正常送达。
教师可以在“教室来音”中播放学生从教室端发送的语音留言；录音最多保留 30 分钟或至授权教师听过。
'@
Set-Content -LiteralPath (Join-Path $delivery '教师端使用说明.txt') -Value $teacherReadme -Encoding utf8

$adminReadme = @'
ICeClass · 班伴 交付包

教室端：把“教室端”文件夹复制到每间教室电脑，双击 EXE，只需输入一次管理员生成的绑定码。
教师端：打开管理员提供的网址或“教师端.url”，登录后可查看统计、通知和学生留言。
早读：从已绑定的教室端打开，四种模式共用管理员统计规则。
远程控制：ICe 可设置白板播放音量 30%/50%，或远程打开在线教室的早读页面。
通用发布包未配置正式地址，需要管理员完成部署后提供网址。

管理员保留本文件夹，不要公开发送部署初始化密钥、账号密码或教室端 config.json。
最高管理员 ICe 可在网页“禁言时间”中维护全校公共时间表，教师只能查看。
'@
Set-Content -LiteralPath (Join-Path $delivery '交付说明.txt') -Value $adminReadme -Encoding utf8
Copy-Item -LiteralPath (Join-Path (Get-Location) 'docs') -Destination $delivery -Recurse -Force
foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path (Get-Location) $name) -Destination $delivery -Force
}

Write-Host ''
Write-Host '交付包已生成：' -ForegroundColor Green
Write-Host "  $delivery"
if ($receiverVersion) { Write-Host "已包含教室端版本：$receiverVersion" }
Write-Host '教室电脑只需复制“教室端”文件夹并双击 EXE。'
if ($Endpoint) { Write-Host '教师只需双击“教师端.url”并登录。' }
else { Write-Host '这是未配置地址的通用包，首次绑定需要管理员提供班伴平台网址。' }

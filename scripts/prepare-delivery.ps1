param(
    [string]$Endpoint = 'https://iceclass.icecreamchat.top',
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
if ($Endpoint -and $Endpoint -ne 'https://iceclass.icecreamchat.top') {
    Set-Content -LiteralPath (Join-Path $classroom 'cloud-url.txt') -Value $Endpoint -Encoding utf8
} else {
    Remove-Item -LiteralPath (Join-Path $classroom 'cloud-url.txt') -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath (Join-Path $delivery 'cloud-url.txt') -Force -ErrorAction SilentlyContinue
if ($Endpoint) {

$shortcut = @"
[InternetShortcut]
URL=$Endpoint
IconFile=$Endpoint/favicon.ico?v=4
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
4. 输入管理员开放的全校绑定码（本次为 mas22），点击“读取班级”，依次下拉选择年级、本教室班级。无需管理员逐班生成绑定码。
5. 点击“绑定并开始陪伴”。以后电脑开机后会自动在后台连接平台。
6. 首次运行自动创建“班伴教室端”桌面快捷图标，同时显示系统托盘图标。点窗口“×”只收起到托盘，仍然接收通知；再点桌面图标可打开已有窗口。托盘菜单“退出”才真正退出。

早读陪伴

点击教室首页“开始早读陪伴”或托盘菜单“打开早读陪伴”，内容直接在班伴内铺满屏幕，全屏时隐藏两层顶栏。选择模式并点击开始，首次使用时允许麦克风。没有键盘时，在屏幕空白处长按 2 秒退出全屏，按住显示圆环进度，松手取消；滑动、双指、按钮和滑块不会触发退出。退出全屏后早读继续，点窗口里的“全屏”可恢复；点“返回”才会结束采音并返回教室首页，通知接收继续。键盘 Esc 仍可退出全屏。
Windows 10/11 64 位电脑需有 Microsoft Edge WebView2；大多数电脑已安装。缺少时会给出“安装运行组件”入口，安装后重新打开班伴即可。早读内容从平台加载，需要联网。
ICe 可在后台启用到点提醒。晨读时段内，新版教室端弹出“开始晨读 / 暂不开始”；同一时段只提醒一次，关闭提醒不会退出程序。开始后仍需选择模式并允许麦克风，提醒本身不计成绩。
ICe 在后台设置统计时段和统计声量门槛。目标、时长、速度等玩法设置仍由原本地操作面板保存，后台不会覆盖。只有指定时段内、页面可见且正在运行的活动计入统计。

全校码可在管理员设定的有效期内供多间教室使用；单班一次性码是备选，有效 15 分钟。不要把 config.json 或绑定码发到公开群聊。ICe 可在后台核实电脑名称、设备编号和实际位置，并远程改绑班级。

以后更新

学校初始预设：高一 16 班、高二 14 班、高三 14 班。班级名单来自后台，增减或更名后在绑定页点击“刷新班级”，不需要重装 EXE。

管理员更新服务器后，教室端会在后台自动检查并安装新版。也可以右键系统托盘图标，点击“检查更新”，或在设置窗口点击同名按钮。
班级绑定保存到本机用户数据目录，更新和替换 EXE 会保留。旧版 config.json 首次迁移成功后自动移走；不要手动先删旧配置。更新过程中程序会自动重启，通常不需要重新绑定。

通知声音

普通通知只在右下角显示，不播放声音。重要通知显示顶部横幅并播放声音，紧急通知全屏显示并播放声音。

学生向老师留言

教室端启动后打开教室首页；从首页点击“开始语音留言”，再次点击“点击结束并发送”，学生语音不会在教室端外放，教师在网页“教室来音”中点击“播放语音”。每段最多 30 秒。收起后可从桌面图标或托盘重新打开。
'@
Set-Content -LiteralPath (Join-Path $classroom '一步使用说明.txt') -Value $classroomReadme -Encoding utf8

$teacherReadme = @'
教师端一步使用

正式地址配置后，双击同目录的“教师端.url”，或打开管理员提供的网址，输入账号和密码。
手机可在浏览器中打开同一网址，再选择“添加到主屏幕”。

登录后可在“早读统计”查看授权班级的每天使用次数、有效发声时长和各模式完成量。
比赛按 ICe 统计时段内的有效发声时长排序。后台统计规则只供 ICe 查看和调整；教师继续在早读陪伴原本地操作面板中设置玩法目标、时长、速度等参数。

普通通知只显示静音弹窗；重要和紧急通知会播放声音。语音喊话只能使用重要或紧急。
禁言上课时间内，网页会在发送前提醒；取消后教室端什么都不会出现，确认“仍然发送”后才会正常送达。
教师可以在“教室来音”中播放学生从教室端发送的语音留言；录音最多保留 30 分钟或至授权教师听过。
'@
Set-Content -LiteralPath (Join-Path $delivery '教师端使用说明.txt') -Value $teacherReadme -Encoding utf8

$adminReadme = @'
ICeClass · 班伴 交付包

教室端：把“教室端”文件夹复制到每间教室电脑，双击 EXE，输入全校绑定码并选择本班。首次运行创建桌面快捷图标；窗口关闭后常驻托盘，仍接收通知。
教师端：打开管理员提供的网址或“教师端.url”，登录后可查看统计、通知和学生留言。
早读：从已绑定的教室端打开，四种模式共用管理员统计规则。
远程控制：ICe 可设置白板播放音量 30%/50%，或远程打开在线教室的早读页面。
客户端已内置班伴正式网址；其他平台可在连接设置中修改。

管理员保留本文件夹，不要公开发送部署初始化密钥、账号密码或教室端 config.json。
最高管理员 ICe 可在网页“禁言时间”中维护全校公共时间表，教师只能查看。
ICe 可创建、停用和删除账号；维护班级年度升班、更名、删除；核实电脑、改绑班级、停用和删除设备；按日期清理班级记录。升班保留原编号及历史，换教室时单独改绑电脑。
'@
Set-Content -LiteralPath (Join-Path $delivery '交付说明.txt') -Value $adminReadme -Encoding utf8
Copy-Item -LiteralPath (Join-Path (Get-Location) 'docs') -Destination $delivery -Recurse -Force
# Application and dependency notices are embedded in the EXE and available from “关于班伴”.

Write-Host ''
Write-Host '交付包已生成：' -ForegroundColor Green
Write-Host "  $delivery"
if ($receiverVersion) { Write-Host "已包含教室端版本：$receiverVersion" }
Write-Host '教室电脑只需复制“教室端”文件夹并双击 EXE。'
if ($Endpoint) { Write-Host '教师只需双击“教师端.url”并登录。' }
else { Write-Host '客户端内置班伴正式网址，也可在连接设置中修改。' }

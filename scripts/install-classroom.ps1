param([string]$InstallDirectory = '', [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$classroomSource = Join-Path $PSScriptRoot 'ICeClass.exe'
$classroomManifestPath = Join-Path $PSScriptRoot 'program-manifest.json'
if (-not (Test-Path -LiteralPath $classroomSource) -or -not (Test-Path -LiteralPath $classroomManifestPath)) {
    throw '请先完整解压教室端安装包，再运行“安装或升级”。'
}
$classroomManifest = Get-Content -LiteralPath $classroomManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$classroomHash = (Get-FileHash -LiteralPath $classroomSource -Algorithm SHA256).Hash
if ((Get-Item -LiteralPath $classroomSource).Length -ne $classroomManifest.size -or $classroomHash -ine $classroomManifest.sha256) {
    throw '安装文件校验失败，请重新解压或下载完整安装包。'
}
# Prefer the existing installation so legacy bindings beside the EXE stay in place.
if (-not $InstallDirectory) {
    $classroomLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'ICeClass 班伴 教室端.lnk'
    if (Test-Path -LiteralPath $classroomLink) {
        $classroomShell = New-Object -ComObject WScript.Shell
        try {
            $classroomShortcut = $classroomShell.CreateShortcut($classroomLink)
            $classroomExisting = $classroomShortcut.TargetPath
            if ($classroomExisting -and [IO.Path]::GetFileName($classroomExisting) -ieq 'ICeClass.exe' -and (Test-Path -LiteralPath $classroomExisting)) {
                $InstallDirectory = Split-Path -Parent $classroomExisting
            }
        } finally {
            if ($classroomShortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($classroomShortcut) }
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($classroomShell)
        }
    }
    if (-not $InstallDirectory) {
        $classroomRun = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name ICeClass -ErrorAction SilentlyContinue).ICeClass
        if ($classroomRun -match '^"([^"]+\\ICeClass\.exe)"(?:\s|$)' -and (Test-Path -LiteralPath $Matches[1])) {
            $InstallDirectory = Split-Path -Parent $Matches[1]
        }
    }
    if (-not $InstallDirectory) { $InstallDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\ICeClass' }
}
$classroomInstall = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($classroomInstall -eq [IO.Path]::GetPathRoot($classroomInstall).TrimEnd('\')) { throw '请选择应用文件夹，不能直接安装到磁盘根目录。' }
$classroomTarget = Join-Path $classroomInstall 'ICeClass.exe'
$classroomSession = (Get-Process -Id $PID).SessionId
$classroomRunning = Get-Process -Name ICeClass -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $classroomSession }
if ($classroomRunning) { throw '请先在教室端托盘菜单点击“退出”，再运行安装或升级。绑定、课表和设置会保留。' }
if ((Test-Path -LiteralPath $classroomTarget) -and [version](Get-Item -LiteralPath $classroomTarget).VersionInfo.FileVersion -gt [version]$classroomManifest.version) {
    throw '本机已安装更新的版本，本安装包不会将它降级。'
}
New-Item -ItemType Directory -Force -Path $classroomInstall | Out-Null
$classroomStaged = Join-Path $classroomInstall ('ICeClass-install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$classroomBackup = $classroomTarget + '.previous'
$classroomUpdates = Join-Path $classroomInstall '.updates'
$classroomMarker = Join-Path $classroomUpdates ('installed-' + [Guid]::NewGuid().ToString('N') + '.ok')
$classroomMoved = $false
$classroomInstalled = $false
$classroomProcess = $null
$classroomDefaultSource = Join-Path $PSScriptRoot 'cloud-url.txt'
$classroomDefaultTarget = Join-Path $classroomInstall 'cloud-url.txt'
$classroomDefaultInstalled = $false
try {
    if ([IO.Path]::GetFullPath($classroomSource) -ine $classroomTarget) {
        Copy-Item -LiteralPath $classroomSource -Destination $classroomStaged
        if ((Get-FileHash -LiteralPath $classroomStaged -Algorithm SHA256).Hash -ine $classroomHash) { throw '复制安装文件后校验失败。' }
        if (Test-Path -LiteralPath $classroomTarget) {
            Move-Item -LiteralPath $classroomTarget -Destination $classroomBackup -Force
            $classroomMoved = $true
        }
        Move-Item -LiteralPath $classroomStaged -Destination $classroomTarget
        $classroomInstalled = $true
    }
    # Seed the package endpoint without overwriting an existing installation's defaults.
    if ((Test-Path -LiteralPath $classroomDefaultSource -PathType Leaf) -and -not (Test-Path -LiteralPath $classroomDefaultTarget)) {
        Copy-Item -LiteralPath $classroomDefaultSource -Destination $classroomDefaultTarget
        $classroomDefaultInstalled = $true
    }
    if (-not $NoLaunch) {
        New-Item -ItemType Directory -Force -Path $classroomUpdates | Out-Null
        $classroomProcess = Start-Process -FilePath $classroomTarget -ArgumentList ('--update-marker="' + $classroomMarker + '"') -WorkingDirectory $classroomInstall -WindowStyle Hidden -PassThru
        $classroomStarted = $false
        for ($classroomAttempt = 0; $classroomAttempt -lt 120; $classroomAttempt++) {
            if (Test-Path -LiteralPath $classroomMarker) { $classroomStarted = $true; break }
            $classroomProcess.Refresh()
            if ($classroomProcess.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $classroomStarted) { throw '新版未能确认启动，已尝试恢复原程序。请查看本机日志后重试。' }
        if ($classroomMoved) { Remove-Item -LiteralPath $classroomBackup -Force }
    }
    Write-Host ('教室端 ' + $classroomManifest.version + ' 已安装到：' + $classroomInstall)
    Write-Host '原有班级绑定、课表、登录与语音设置已保留。'
    if ($NoLaunch -and $classroomMoved) { Write-Host '尚未启动验证；旧程序保留为 ICeClass.exe.previous。' }
} catch {
    if ($classroomProcess) {
        $classroomProcess.Refresh()
        if (-not $classroomProcess.HasExited) { Stop-Process -Id $classroomProcess.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($classroomDefaultInstalled) { Remove-Item -LiteralPath $classroomDefaultTarget -Force -ErrorAction SilentlyContinue }
    if ($classroomInstalled) { Remove-Item -LiteralPath $classroomTarget -Force -ErrorAction SilentlyContinue }
    if ($classroomMoved -and (Test-Path -LiteralPath $classroomBackup)) {
        Move-Item -LiteralPath $classroomBackup -Destination $classroomTarget -Force
    }
    throw
} finally {
    Remove-Item -LiteralPath $classroomStaged -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $classroomMarker -Force -ErrorAction SilentlyContinue
}

param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$desktopSource = Join-Path $PSScriptRoot 'ICeClass.Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopSource)) { throw '请将安装脚本和 ICeClass.Desktop.exe 放在同一个文件夹。' }
$desktopInstall = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\ICeClassDesktop'
$desktopTarget = Join-Path $desktopInstall 'ICeClass.Desktop.exe'
$desktopRunning = Get-CimInstance Win32_Process -Filter "Name='ICeClass.Desktop.exe'" | Where-Object { $_.ExecutablePath -eq $desktopTarget }
if ($desktopRunning) { throw '请先从系统托盘退出 ICeClass 班伴 · 教师端，再运行安装。' }
New-Item -ItemType Directory -Force -Path $desktopInstall | Out-Null
if ([IO.Path]::GetFullPath($desktopSource) -ne [IO.Path]::GetFullPath($desktopTarget)) { Copy-Item -LiteralPath $desktopSource -Destination $desktopTarget -Force }
$desktopShell = New-Object -ComObject WScript.Shell
foreach ($desktopShortcutFolder in @([Environment]::GetFolderPath('DesktopDirectory'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'ICeClass'))) {
    New-Item -ItemType Directory -Force -Path $desktopShortcutFolder | Out-Null
    foreach ($desktopPreviousName in @('班伴工作台.lnk', '班伴教师端.lnk')) {
        $desktopPreviousLink = Join-Path $desktopShortcutFolder $desktopPreviousName
        if (Test-Path -LiteralPath $desktopPreviousLink) {
            $desktopPreviousShortcut = $desktopShell.CreateShortcut($desktopPreviousLink)
            if ($desktopPreviousShortcut.TargetPath -eq $desktopTarget) { Remove-Item -LiteralPath $desktopPreviousLink -Force }
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopPreviousShortcut)
        }
    }
    $desktopShortcut = $desktopShell.CreateShortcut((Join-Path $desktopShortcutFolder 'ICeClass 班伴 教师端.lnk'))
    if ($desktopShortcut.TargetPath -and [IO.Path]::GetFileName($desktopShortcut.TargetPath) -ne 'ICeClass.Desktop.exe') { continue }
    $desktopShortcut.TargetPath = $desktopTarget
    $desktopShortcut.WorkingDirectory = $desktopInstall
    $desktopShortcut.IconLocation = $desktopTarget + ',0'
    $desktopShortcut.Description = 'ICeClass 班伴 · 教师与管理员工作台'
    $desktopShortcut.Save()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopShortcut)
}
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopShell)
$desktopUninstaller = @'
$ErrorActionPreference='Stop'
$desktopInstall=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\ICeClassDesktop'
if([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($desktopInstall)){throw 'Uninstall path does not match the installed application.'}
$desktopAnswer=Read-Host '卸载 ICeClass 班伴 · 教师端？将保留本机登录资料。输入 Y 确认'
if($desktopAnswer -ne 'Y'){exit}
$desktopTarget=Join-Path $desktopInstall 'ICeClass.Desktop.exe'
Get-CimInstance Win32_Process -Filter "Name='ICeClass.Desktop.exe'" | Where-Object {$_.ExecutablePath -eq $desktopTarget} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
$desktopShell=New-Object -ComObject WScript.Shell
foreach($desktopFolder in @([Environment]::GetFolderPath('DesktopDirectory'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'ICeClass'))){
  foreach($desktopLinkName in @('班伴工作台.lnk','班伴教师端.lnk','ICeClass 班伴 教师端.lnk')){
    $desktopLink=Join-Path $desktopFolder $desktopLinkName
    if(Test-Path -LiteralPath $desktopLink){
      $desktopShortcut=$desktopShell.CreateShortcut($desktopLink)
      if($desktopShortcut.TargetPath -eq $desktopTarget){Remove-Item -LiteralPath $desktopLink -Force}
      [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopShortcut)
    }
  }
}
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopShell)
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ICeClassDesktop' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $desktopInstall -Recurse -Force
Write-Host 'ICeClass 班伴 · 教师端已卸载。'
'@
Set-Content -LiteralPath (Join-Path $desktopInstall 'Uninstall.ps1') -Value $desktopUninstaller -Encoding utf8
$desktopUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ICeClassDesktop'
New-Item -Path $desktopUninstallKey -Force | Out-Null
$desktopVersion = (Get-Item -LiteralPath $desktopTarget).VersionInfo.ProductVersion
foreach ($desktopProperty in @{
    DisplayName='ICeClass 班伴 · 教师端'; DisplayVersion=$desktopVersion; Publisher='ICeCreamChat'; InstallLocation=$desktopInstall;
    DisplayIcon=($desktopTarget+',0'); UninstallString=('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $desktopInstall 'Uninstall.ps1')+'"')
}.GetEnumerator()) { New-ItemProperty -LiteralPath $desktopUninstallKey -Name $desktopProperty.Key -Value $desktopProperty.Value -PropertyType String -Force | Out-Null }
New-ItemProperty -LiteralPath $desktopUninstallKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -LiteralPath $desktopUninstallKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host 'ICeClass 班伴 · 教师端安装完成，桌面图标已创建。'
if (-not $NoLaunch) { Start-Process -FilePath $desktopTarget -WindowStyle Hidden }

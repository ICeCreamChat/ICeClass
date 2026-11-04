param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$opticsRoot = Split-Path -Parent $PSScriptRoot
$opticsOutput = [IO.Path]::GetFullPath($OutputDirectory)
$opticsSource = Join-Path $opticsRoot 'Receiver\Native\IslandGlassCapture.cpp'
$opticsVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $opticsVsWhere)) { throw 'Glass capture requires Visual Studio C++ Build Tools and the Windows SDK.' }
$opticsVisualStudio = & $opticsVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $opticsVisualStudio) { throw 'Visual Studio C++ x64 tools were not found.' }
$opticsEnvironment = Join-Path $opticsVisualStudio 'VC\Auxiliary\Build\vcvars64.bat'
New-Item -ItemType Directory -Path $opticsOutput -Force | Out-Null
$opticsCommandFile = Join-Path $opticsOutput 'build.cmd'
$opticsCommand = @"
@echo off
chcp 65001 >nul
call "$opticsEnvironment" >nul
if errorlevel 1 exit /b %errorlevel%
cl /nologo /EHsc /std:c++20 /utf-8 /O2 /MT /LD /DUNICODE /D_UNICODE "$opticsSource" /Fe:"$opticsOutput\ICeClass.Glass.dll" /Fo:"$opticsOutput\IslandGlassCapture.obj" /link d3d11.lib dxgi.lib windowsapp.lib user32.lib gdi32.lib dwmapi.lib
"@
[IO.File]::WriteAllText($opticsCommandFile, $opticsCommand, [Text.UTF8Encoding]::new($false))
& $opticsCommandFile
if ($LASTEXITCODE -ne 0) { throw 'Native glass capture build failed.' }

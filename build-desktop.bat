@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-desktop.ps1"
if errorlevel 1 exit /b 1
if /i not "%ICECLASS_NO_PAUSE%"=="1" pause

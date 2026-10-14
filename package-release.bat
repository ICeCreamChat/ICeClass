@echo off
setlocal
cd /d "%~dp0"
title ICeClass Release Package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-release.ps1"
if errorlevel 1 (
  echo Release package failed. Read the error above.
  pause
  exit /b 1
)
pause

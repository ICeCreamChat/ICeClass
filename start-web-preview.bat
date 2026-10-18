@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-review.ps1" -Client Web
if errorlevel 1 pause

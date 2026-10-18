@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-review.ps1" -Client Classroom
if errorlevel 1 pause

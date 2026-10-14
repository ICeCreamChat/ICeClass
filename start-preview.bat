@echo off
setlocal
cd /d "%~dp0"
title ICeClass Local Preview
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-preview.ps1"
if errorlevel 1 pause

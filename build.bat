@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-classroom.ps1"
if errorlevel 1 (
  echo.
  echo Build failed. Read the error above.
  if /i not "%ICECLASS_NO_PAUSE%"=="1" pause
  exit /b 1
)

echo.
echo Build succeeded:
echo   %CD%\dist\receiver\ICeClass.exe
echo   %CD%\dist\receiver-core\ICeClass.exe
echo Copy dist\receiver\ICeClass.exe to each classroom computer and double-click it.
echo The receiver-core EXE is used by packaged file updates.
if /i not "%ICECLASS_NO_PAUSE%"=="1" pause

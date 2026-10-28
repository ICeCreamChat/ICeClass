@echo off
setlocal
cd /d "%~dp0"

set "DOTNET_EXE=dotnet"
if exist ".tools\dotnet\dotnet.exe" set "DOTNET_EXE=.tools\dotnet\dotnet.exe"
if defined ICECLASS_DOTNET set "DOTNET_EXE=%ICECLASS_DOTNET%"

echo [1/3] Checking .NET SDK...
"%DOTNET_EXE%" --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: .NET 8 SDK was not found.
  echo Install it from https://dotnet.microsoft.com/download/dotnet/8.0 and run this file again.
  if /i not "%ICECLASS_NO_PAUSE%"=="1" pause
  exit /b 1
)

echo [2/3] Preparing verified offline voice assets...
set "PYTHON_EXE=python"
if defined ICECLASS_PYTHON set "PYTHON_EXE=%ICECLASS_PYTHON%"
"%PYTHON_EXE%" "scripts\prepare-banban-voice.py"
if errorlevel 1 (
  echo Voice asset preparation failed. Python 3.11 or newer and network access are required for a clean build.
  if /i not "%ICECLASS_NO_PAUSE%"=="1" pause
  exit /b 1
)

echo [3/3] Building the Windows 10/11 single-file receiver...
if exist "dist\receiver" rmdir /s /q "dist\receiver"
"%DOTNET_EXE%" publish "Receiver\Receiver.csproj" -c Release -r win-x64 --self-contained true -o "dist\receiver" -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false
if errorlevel 1 (
  echo.
  echo Build failed. Read the error above.
  if /i not "%ICECLASS_NO_PAUSE%"=="1" pause
  exit /b 1
)

echo.
echo Build succeeded:
echo   %CD%\dist\receiver\ICeClass.exe
echo Copy this EXE to each classroom computer and double-click it.
if /i not "%ICECLASS_NO_PAUSE%"=="1" pause

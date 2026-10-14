param(
    [string]$PythonPath = '',
    [int]$Port = 8837,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not $PythonPath) {
    $bundledVenv = Join-Path $projectRoot '.tools\preview-venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $bundledVenv) { $PythonPath = $bundledVenv }
    else {
        foreach ($name in @('py.exe', 'python.exe')) {
            $candidate = Get-Command $name -ErrorAction SilentlyContinue
            if ($candidate) {
                & $candidate.Source --version 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { $PythonPath = $candidate.Source; break }
            }
        }
    }
}
if (-not $PythonPath) { throw '本地演示需要 Python 3.10 或更新版本。请从 https://www.python.org/downloads/ 安装并勾选 Add Python to PATH。教室端 EXE 不需要 Python。' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw '本地端口需要在 1024 至 65535 之间。' }

$previewPython = Join-Path $projectRoot '.tools\preview-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $previewPython)) {
    & $PythonPath -m venv (Join-Path $projectRoot '.tools\preview-venv')
    if ($LASTEXITCODE -ne 0) { throw '无法建立本地演示环境。' }
}
& $previewPython -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('aiohttp') else 1)"
if ($LASTEXITCODE -ne 0) {
    & $previewPython -m pip install --disable-pip-version-check -r server\requirements.txt
    if ($LASTEXITCODE -ne 0) { throw '本地演示依赖安装失败，请检查网络。' }
}
Write-Host '班伴本地演示：示例数据只存放在 .tools\preview\demo.db，不使用正式数据库。' -ForegroundColor Cyan
Write-Host '管理员：ICe / LocalDemo2026    教师：teacher1 / LocalTeacher2026'
Write-Host '关闭本窗口即可停止演示。'
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
& $previewPython server\preview.py --port $Port
if ($LASTEXITCODE -ne 0) { throw '本地演示启动失败。请检查端口是否已经被占用。' }

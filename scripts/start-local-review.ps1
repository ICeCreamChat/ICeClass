param([ValidateSet('Web', 'Classroom', 'Teacher')][string]$Client = 'Web')
$ErrorActionPreference = 'Stop'
$reviewRepository = Split-Path -Parent $PSScriptRoot
$reviewFolder = Join-Path $reviewRepository 'dist\local-review-2.3.0'
$reviewUrl = 'http://127.0.0.1:8838/'

function Get-ReviewResponse {
    try { return Invoke-WebRequest -UseBasicParsing -Uri ($reviewUrl + 'api/bootstrap') -TimeoutSec 2 }
    catch { if ($_.Exception.Response) { return $_.Exception.Response }; return $null }
}

$reviewResponse = Get-ReviewResponse
if (-not $reviewResponse) {
    $reviewPython = Join-Path $reviewRepository '.tools\preview-venv\Scripts\python.exe'
    $reviewServer = Join-Path $reviewRepository '.tools\review-offline-server.py'
    if (-not (Test-Path -LiteralPath $reviewPython) -or -not (Test-Path -LiteralPath $reviewServer)) {
        throw '找不到本机验收环境，请从完整项目目录打开。'
    }
    New-Item -ItemType Directory -Force -Path $reviewFolder | Out-Null
    Start-Process -FilePath $reviewPython -ArgumentList @('-X', 'utf8', ('"' + $reviewServer + '"')) -WorkingDirectory $reviewRepository -WindowStyle Hidden -RedirectStandardOutput (Join-Path $reviewFolder 'server-output.log') -RedirectStandardError (Join-Path $reviewFolder 'server-error.log') | Out-Null
    for ($reviewAttempt = 0; $reviewAttempt -lt 20; $reviewAttempt++) {
        Start-Sleep -Milliseconds 250
        $reviewResponse = Get-ReviewResponse
        if ($reviewResponse) { break }
    }
}
if (-not $reviewResponse -or $reviewResponse.Headers['X-ICeClass-Review'] -ne '2.3.0') {
    throw '本地验收服务未就绪，或 8838 端口由其他程序占用。请查看 dist\local-review-2.3.0\server-error.log。'
}

switch ($Client) {
    'Web' { Start-Process $reviewUrl }
    'Classroom' {
        $reviewExecutable = Join-Path $reviewFolder 'ICeClass-2.3.0-ui-review.exe'
        if (-not (Test-Path -LiteralPath $reviewExecutable)) { $reviewExecutable = Join-Path $reviewFolder 'ICeClass-2.3.0.exe' }
        if (-not (Test-Path -LiteralPath $reviewExecutable)) { throw '找不到本地教室端验收程序。' }
        Start-Process -FilePath $reviewExecutable -WorkingDirectory $reviewFolder -WindowStyle Hidden
    }
    'Teacher' {
        $reviewExecutable = Join-Path $reviewRepository 'dist\desktop\ICeClass.Desktop.exe'
        if (-not (Test-Path -LiteralPath $reviewExecutable)) { throw '请先运行 build-desktop.bat 构建 Windows 教师端。' }
        $reviewProfile = Join-Path $reviewRepository '.tools\desktop-native-review'
        Start-Process -FilePath $reviewExecutable -ArgumentList @('--server', $reviewUrl.TrimEnd('/'), '--data-dir', ('"' + $reviewProfile + '"')) -WorkingDirectory $reviewRepository -WindowStyle Hidden
    }
}

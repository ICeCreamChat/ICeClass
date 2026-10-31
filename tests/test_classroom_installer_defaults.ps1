param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $testRoot) { throw 'Choose a new dedicated test directory.' }
$testPackage = Join-Path $testRoot 'package'
New-Item -ItemType Directory -Path $testPackage -Force | Out-Null
$testInstaller = Join-Path $testPackage 'install.ps1'
[IO.File]::WriteAllText($testInstaller, (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../scripts/install-classroom.ps1') -Raw -Encoding UTF8), (New-Object Text.UTF8Encoding($true)))
$testProgram = Join-Path $testPackage 'ICeClass.exe'
[IO.File]::WriteAllText($testProgram, 'current-program-fixture')
$testManifest = @{ version='2.5.1'; size=(Get-Item -LiteralPath $testProgram).Length;
    sha256=(Get-FileHash -LiteralPath $testProgram -Algorithm SHA256).Hash }
[IO.File]::WriteAllText((Join-Path $testPackage 'program-manifest.json'), ($testManifest | ConvertTo-Json))
$testDefault = Join-Path $testPackage 'cloud-url.txt'
$testEndpoint = 'https://school.example.test'
[IO.File]::WriteAllText($testDefault, $testEndpoint)
$testChecks = New-Object 'Collections.Generic.List[string]'
function Check([bool]$condition, [string]$description) {
    if (-not $condition) { throw $description }
    $testChecks.Add($description)
    Write-Output ('PASS ' + $description)
}
# Keep the real file operations; isolate process discovery from the user's running client.
function Get-Process {
    [CmdletBinding()]
    param([int]$Id, [string]$Name)
    if ($PSBoundParameters.ContainsKey('Id')) { Microsoft.PowerShell.Management\Get-Process -Id $Id }
    elseif ($Name -ne 'ICeClass') { throw 'Unexpected process lookup in installation test.' }
}
# Exercise the installer's real rollback without launching a fixture executable.
function Start-Process {
    [CmdletBinding()]
    param([string]$FilePath, [string]$ArgumentList, [string]$WorkingDirectory,
        [string]$WindowStyle, [switch]$PassThru)
    throw 'Fixture startup failure'
}
try {
    $fresh = Join-Path $testRoot 'fresh installation'
    & $testInstaller -InstallDirectory $fresh -NoLaunch
    $freshDefault = Join-Path $fresh 'cloud-url.txt'
    Check ((Test-Path -LiteralPath $freshDefault) -and [IO.File]::ReadAllText($freshDefault) -eq $testEndpoint) 'fresh installation carries the packaged custom server address'

    $existingEndpoint = 'https://existing.example.test'
    [IO.File]::WriteAllText($freshDefault, $existingEndpoint)
    $binding = Join-Path $fresh 'config.json'
    [IO.File]::WriteAllText($binding, '{"fixture":"original-binding"}')
    & $testInstaller -InstallDirectory $fresh -NoLaunch
    Check ([IO.File]::ReadAllText($freshDefault) -eq $existingEndpoint) 'upgrade preserves the existing server default'
    Check ([IO.File]::ReadAllText($binding) -eq '{"fixture":"original-binding"}') 'upgrade preserves the existing binding byte for byte'

    & $testInstaller -InstallDirectory $testPackage -NoLaunch
    Check ([IO.File]::ReadAllText($testDefault) -eq $testEndpoint) 'installing in place preserves the packaged server address'

    $rollback = Join-Path $testRoot 'failed startup'
    New-Item -ItemType Directory -Path $rollback | Out-Null
    $previous = Join-Path $rollback 'ICeClass.exe'
    [IO.File]::WriteAllText($previous, 'previous-program-fixture')
    try { & $testInstaller -InstallDirectory $rollback; throw 'Startup failure was accepted.' }
    catch { if ($_.Exception.Message -ne 'Fixture startup failure') { throw } }
    Check ([IO.File]::ReadAllText($previous) -eq 'previous-program-fixture') 'failed startup restores the previous program'
    Check (-not (Test-Path -LiteralPath (Join-Path $rollback 'cloud-url.txt'))) 'failed startup removes only the newly introduced server default'

    Remove-Item -LiteralPath $testDefault
    $standard = Join-Path $testRoot 'standard installation'
    & $testInstaller -InstallDirectory $standard -NoLaunch
    Check (-not (Test-Path -LiteralPath (Join-Path $standard 'cloud-url.txt'))) 'a standard package does not create a custom server default'
} finally {
    [IO.File]::WriteAllText((Join-Path $testRoot 'checks.json'), (@{ checks=$testChecks.ToArray() } | ConvertTo-Json))
}

param(
    [Parameter(Mandatory=$true)][string]$CurrentExecutable,
    [Parameter(Mandatory=$true)][string]$LegacyExecutable,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$Dotnet = 'dotnet'
)
$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $testRoot) { throw 'Choose a new dedicated test directory.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
$testChecks = New-Object 'Collections.Generic.List[string]'
function Check([bool]$condition, [string]$description) {
    if (-not $condition) { throw $description }
    $testChecks.Add($description)
    Write-Output ('PASS ' + $description)
}
$testPackage = Join-Path $testRoot 'package'
New-Item -ItemType Directory -Path $testPackage | Out-Null
$testInstaller = Join-Path $testPackage 'install.ps1'
[IO.File]::WriteAllText($testInstaller, (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../scripts/install-classroom.ps1') -Raw -Encoding UTF8), (New-Object Text.UTF8Encoding($true)))
function Package([string]$program) {
    Copy-Item -LiteralPath $program -Destination (Join-Path $testPackage 'ICeClass.exe') -Force
    $manifest = @{ version = (Get-Item -LiteralPath $program).VersionInfo.FileVersion; size = (Get-Item -LiteralPath $program).Length;
        sha256 = (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $testPackage 'program-manifest.json'), $manifest)
}
function Install([string]$target, [bool]$failure = $false, [bool]$launch = $false) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testInstaller, '-InstallDirectory', $target)
    if (-not $launch) { $arguments += '-NoLaunch' }
    & "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" @arguments *> (Join-Path $testRoot ('install-' + [Guid]::NewGuid().ToString('N') + '.log'))
    if (($LASTEXITCODE -ne 0) -ne $failure) { throw ('Unexpected installer exit code: ' + $LASTEXITCODE) }
}
try {
    Package $CurrentExecutable
    $testHash = (Get-FileHash -LiteralPath $CurrentExecutable -Algorithm SHA256).Hash
    $testLegacyHash = (Get-FileHash -LiteralPath $LegacyExecutable -Algorithm SHA256).Hash
    $fresh = Join-Path $testRoot 'fresh installation with spaces'
    Install $fresh
    Check ((Get-FileHash -LiteralPath (Join-Path $fresh 'ICeClass.exe') -Algorithm SHA256).Hash -eq $testHash) 'first install copies the exact verified program under Windows PowerShell 5.1'
    $upgrade = Join-Path $testRoot 'legacy installation'
    New-Item -ItemType Directory -Path $upgrade | Out-Null
    Copy-Item -LiteralPath $LegacyExecutable -Destination (Join-Path $upgrade 'ICeClass.exe')
    foreach ($file in @('config.json','island-settings.json','voice-test-setting.json')) {
        [IO.File]::WriteAllText((Join-Path $upgrade $file), '{"fixture":"retain-original-data"}')
    }
    Install $upgrade
    Check ((Get-FileHash -LiteralPath (Join-Path $upgrade 'ICeClass.exe') -Algorithm SHA256).Hash -eq $testHash) 'a fixed legacy program upgrades to the current candidate'
    Check ((Get-FileHash -LiteralPath (Join-Path $upgrade 'ICeClass.exe.previous') -Algorithm SHA256).Hash -eq $testLegacyHash) 'without a verified launch the previous program remains recoverable'
    Check (@(Get-ChildItem -LiteralPath $upgrade -Filter '*.json' | Where-Object { [IO.File]::ReadAllText($_.FullName) -ne '{"fixture":"retain-original-data"}' }).Count -eq 0) 'installation preserves all fixture bindings and preferences byte for byte'
    $manifestPath = Join-Path $testPackage 'program-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.sha256 = '0' * 64
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json))
    Install $fresh $true
    Check ((Get-FileHash -LiteralPath (Join-Path $fresh 'ICeClass.exe') -Algorithm SHA256).Hash -eq $testHash) 'a damaged package is rejected before changing the installed program'
    Package $LegacyExecutable
    Install $fresh $true
    Check ((Get-FileHash -LiteralPath (Join-Path $fresh 'ICeClass.exe') -Algorithm SHA256).Hash -eq $testHash) 'an older genuine program cannot downgrade the candidate'
    $fixture = Join-Path $testRoot 'failing-startup-source'
    New-Item -ItemType Directory -Path $fixture | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'failure.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><OutputType>WinExe</OutputType><AssemblyName>ICeClass</AssemblyName><Version>99.0.0</Version><EnableCompressionInSingleFile>true</EnableCompressionInSingleFile></PropertyGroup></Project>')
    [IO.File]::WriteAllText((Join-Path $fixture 'Program.cs'), 'return 3;')
    $fixtureOutput = Join-Path $fixture 'program'
    & $Dotnet publish (Join-Path $fixture 'failure.csproj') -c Release -r win-x64 --self-contained true -o $fixtureOutput --artifacts-path (Join-Path $testRoot 'fixture-artifacts') -p:PublishSingleFile=true -p:DebugType=None -p:DebugSymbols=false --nologo *> (Join-Path $testRoot 'fixture-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Startup failure fixture build failed.' }
    Package (Join-Path $fixtureOutput 'ICeClass.exe')
    Install $fresh $true $true
    Check ((Get-FileHash -LiteralPath (Join-Path $fresh 'ICeClass.exe') -Algorithm SHA256).Hash -eq $testHash) 'a real process that exits without confirming startup restores the original executable'
    Check (-not (Test-Path -LiteralPath (Join-Path $fresh 'ICeClass.exe.previous'))) 'rollback leaves one restored executable without a stale pending backup'
    Install ([IO.Path]::GetPathRoot($testRoot)) $true
    Check $true 'installation directly into a drive root is refused'
} finally {
    [IO.File]::WriteAllText((Join-Path $testRoot 'checks.json'), (@{checks=$testChecks.ToArray()} | ConvertTo-Json))
}

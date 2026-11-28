param(
    [Parameter(Mandatory=$true)][string]$Package,
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [switch]$VerifyWebView2
)
$ErrorActionPreference = 'Stop'
$targetProgram = Join-Path $InstallDirectory 'ICeClass.exe'

# Keep the installer guard for this test installation while leaving other classroom processes alone.
function Get-Process {
    [CmdletBinding()]param([int]$Id,[string]$Name)
    if ($PSBoundParameters.ContainsKey('Id')) { Microsoft.PowerShell.Management\Get-Process -Id $Id }
    elseif ($Name -eq 'ICeClass') {
        Microsoft.PowerShell.Management\Get-Process -Name $Name -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $targetProgram }
    }
    else { throw 'Unexpected process query in classroom package verification.' }
}

& (Join-Path $Package 'install.ps1') -InstallDirectory $InstallDirectory -NoLaunch
if (-not $VerifyWebView2) { return }

$manifest = Get-Content -LiteralPath (Join-Path $Package 'program-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.webView2.version
$runtime = Join-Path $InstallDirectory ('WebView2\' + $version)
$browser = Join-Path $runtime 'msedgewebview2.exe'
$marker = Get-Item -LiteralPath (Join-Path $runtime '.iceclass-cab-sha256')
if ([IO.File]::ReadAllText($marker.FullName) -cne $manifest.webView2.sha256 -or
    (Get-Item -LiteralPath $browser).VersionInfo.ProductVersion -ne $version -or
    (Get-AuthenticodeSignature -LiteralPath $browser).Status -ne 'Valid' -or
    (Get-FileHash -LiteralPath $targetProgram -Algorithm SHA256).Hash -ine $manifest.sha256) {
    throw 'Installed classroom program or WebView2 failed verification.'
}
$sandboxIdentities = (Get-Acl -LiteralPath $runtime).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($sandbox in @('S-1-15-2-1','S-1-15-2-2')) {
    if (-not ($sandboxIdentities | Where-Object { $_.IdentityReference.Value -eq $sandbox -and
        $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq
        [Security.AccessControl.FileSystemRights]::ReadAndExecute })) {
        throw 'Fixed WebView2 runtime is missing a sandbox read/execute grant.'
    }
}

$timestamp = $marker.LastWriteTimeUtc
& $targetProgram '--install-classroom-webview2' $InstallDirectory (Join-Path $Package 'WebView2-x64.cab') | Out-Null
if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $marker.FullName).LastWriteTimeUtc -ne $timestamp) {
    throw 'A valid local runtime was not reused.'
}
Write-Output "PASS signed WebView2 $version installed from the complete ZIP and reused on repair."

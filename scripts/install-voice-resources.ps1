function Install-VoiceResources {
    param([string]$PackageDirectory, [string]$InstallDirectory, [switch]$ValidateOnly)
    $ErrorActionPreference = 'Stop'
    $voicePackage = [IO.Path]::GetFullPath($PackageDirectory)
    $voiceInstall = [IO.Path]::GetFullPath($InstallDirectory)
    $voiceManifest = Join-Path $voicePackage 'voice-resources.json'
    if (-not (Test-Path -LiteralPath $voiceManifest -PathType Leaf)) { return }
    function Assert-VoicePath([string]$Path) {
        $voiceAncestor = [IO.Path]::GetFullPath($Path)
        while ($voiceAncestor) {
            if ((Test-Path -LiteralPath $voiceAncestor) -and ((Get-Item -LiteralPath $voiceAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Voice resources cannot use linked files or folders.'
            }
            $voiceParent = Split-Path -Parent $voiceAncestor
            if ($voiceParent -eq $voiceAncestor) { break }
            $voiceAncestor = $voiceParent
        }
    }
    Assert-VoicePath $voiceManifest
    Assert-VoicePath $voiceInstall
    $voiceData = Get-Content -LiteralPath $voiceManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $voiceFiles = @($voiceData.files)
    $voiceNames = @('VoiceResources/Asr/model.int8.onnx', 'VoiceResources/Asr/tokens.txt')
    if ($voiceFiles.Count -ne 2 -or @($voiceFiles.path | Select-Object -Unique).Count -ne 2) { throw 'Invalid offline voice resource list.' }
    # Validate every source before changing any installed model.
    foreach ($voiceFile in $voiceFiles) {
        if ($voiceFile.path -cnotin $voiceNames -or $voiceFile.size -isnot [ValueType] -or $voiceFile.size -le 0 -or $voiceFile.size -gt 1073741824 -or
            $voiceFile.sha256 -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid offline voice resource metadata.' }
        $voiceSource = Join-Path $voicePackage $voiceFile.path
        Assert-VoicePath $voiceSource
        Assert-VoicePath (Join-Path $voiceInstall $voiceFile.path)
        if (-not (Test-Path -LiteralPath $voiceSource -PathType Leaf) -or (Get-Item -LiteralPath $voiceSource).Length -ne $voiceFile.size -or
            (Get-FileHash -LiteralPath $voiceSource -Algorithm SHA256).Hash -ine $voiceFile.sha256) { throw 'Offline voice resource integrity check failed.' }
    }
    if ($ValidateOnly) { return }
    foreach ($voiceFile in $voiceFiles) {
        $voiceSource = Join-Path $voicePackage $voiceFile.path
        $voiceTarget = Join-Path $voiceInstall $voiceFile.path
        if ([IO.Path]::GetFullPath($voiceSource) -eq [IO.Path]::GetFullPath($voiceTarget)) { continue }
        if ((Test-Path -LiteralPath $voiceTarget -PathType Leaf) -and (Get-FileHash -LiteralPath $voiceTarget -Algorithm SHA256).Hash -ieq $voiceFile.sha256) { continue }
        New-Item -ItemType Directory -Path (Split-Path -Parent $voiceTarget) -Force | Out-Null
        $voiceStage = $voiceTarget + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            Copy-Item -LiteralPath $voiceSource -Destination $voiceStage
            if ((Get-FileHash -LiteralPath $voiceStage -Algorithm SHA256).Hash -ine $voiceFile.sha256) { throw 'Copied voice resource integrity check failed.' }
            Move-Item -LiteralPath $voiceStage -Destination $voiceTarget -Force
        } finally { if (Test-Path -LiteralPath $voiceStage) { Remove-Item -LiteralPath $voiceStage -ErrorAction Stop } }
    }
}

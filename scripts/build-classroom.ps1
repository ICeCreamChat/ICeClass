param([string]$DistributionDirectory = '')
$ErrorActionPreference = 'Stop'
$classroomProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location $classroomProjectRoot
$classroomDistributionRoot = if ($DistributionDirectory) { [IO.Path]::GetFullPath($DistributionDirectory) } else { Join-Path $classroomProjectRoot 'dist' }
$classroomBuildRoot = Join-Path $classroomProjectRoot '.tools\classroom-build'
$classroomWorkDirectory = Join-Path $classroomBuildRoot ('run-' + [Guid]::NewGuid().ToString('N'))

function Assert-ClassroomWorkspaceDirectory([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $workspacePrefix = $classroomProjectRoot.TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build directory is outside the workspace: $absolute"
    }
    $ancestor = $absolute
    while (-not $ancestor.Equals($classroomProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Build directory must not contain links or junctions: $ancestor"
            }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}

Assert-ClassroomWorkspaceDirectory $classroomWorkDirectory
$classroomDotnet = 'dotnet'
if (Test-Path -LiteralPath '.tools\dotnet\dotnet.exe') { $classroomDotnet = (Resolve-Path -LiteralPath '.tools\dotnet\dotnet.exe').Path }
if (Test-Path -LiteralPath '.tools\desktop-sdk\runtime\dotnet.exe') { $classroomDotnet = (Resolve-Path -LiteralPath '.tools\desktop-sdk\runtime\dotnet.exe').Path }
if ($env:ICECLASS_DOTNET) { $classroomDotnet = $env:ICECLASS_DOTNET }
$classroomPython = 'python.exe'
if ($env:ICECLASS_PYTHON) { $classroomPython = $env:ICECLASS_PYTHON }

Write-Host '[1/3] Checking .NET SDK...'
& $classroomDotnet --version
if ($LASTEXITCODE -ne 0) { throw '.NET 8 SDK was not found.' }
Write-Host '[2/3] Preparing verified offline voice assets...'
& $classroomPython (Join-Path $PSScriptRoot 'prepare-banban-voice.py')
if ($LASTEXITCODE -ne 0) { throw 'Voice asset preparation failed.' }

New-Item -ItemType Directory -Path $classroomWorkDirectory -Force | Out-Null
try {
    Write-Host '[3/3] Building full offline receiver and update core...'
    foreach ($variant in @('full', 'core')) {
        $embedVoice = ($variant -eq 'full').ToString().ToLowerInvariant()
        $publishDirectory = Join-Path $classroomWorkDirectory "$variant-publish"
        # .NET 8 artifacts paths isolate NuGet/obj/bin for each variant and invocation.
        $artifactsDirectory = Join-Path $classroomWorkDirectory "$variant-artifacts"
        & $classroomDotnet publish (Join-Path $classroomProjectRoot 'Receiver\Receiver.csproj') `
            -c Release -r win-x64 --self-contained true -o $publishDirectory `
            --artifacts-path $artifactsDirectory "-p:EmbedVoiceResources=$embedVoice" `
            -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
            -p:PublishTrimmed=false -p:DebugType=None -p:DebugSymbols=false --nologo
        if ($LASTEXITCODE -ne 0) { throw "Classroom $variant build failed." }
        if (-not (Test-Path -LiteralPath (Join-Path $publishDirectory 'ICeClass.exe') -PathType Leaf)) {
            throw "Classroom $variant build did not produce ICeClass.exe."
        }
    }
    foreach ($variant in @('full', 'core')) {
        $outputName = if ($variant -eq 'full') { 'receiver' } else { 'receiver-core' }
        $outputDirectory = Join-Path $classroomDistributionRoot $outputName
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $classroomWorkDirectory "$variant-publish\ICeClass.exe") -Destination (Join-Path $outputDirectory 'ICeClass.exe') -Force
        Write-Host (Join-Path $outputDirectory 'ICeClass.exe')
    }
} finally {
    # Only remove our unique temporary directory, after validating its absolute ancestry.
    Assert-ClassroomWorkspaceDirectory $classroomWorkDirectory
    if ((Split-Path -Parent $classroomWorkDirectory) -ne $classroomBuildRoot -or
        (Split-Path -Leaf $classroomWorkDirectory) -notmatch '^run-[0-9a-f]{32}$') {
        throw "Refusing to remove an unexpected build path: $classroomWorkDirectory"
    }
    if (Test-Path -LiteralPath $classroomWorkDirectory) {
        Remove-Item -LiteralPath $classroomWorkDirectory -Recurse -Force
    }
}

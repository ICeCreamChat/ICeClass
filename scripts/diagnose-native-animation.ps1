param()

# Read-only: no SPI_SET calls, registry writes, application settings, or network.
$ErrorActionPreference = 'Stop'
if (-not ('ICeClassNativeAnimationProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ICeClassNativeAnimationProbe
{
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetParameter(uint action, uint parameter, out int value, uint flags);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    [DllImport("dwmapi.dll")]
    public static extern int DwmIsCompositionEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);
}
'@
}

$animationValue = 0
$animationSucceeded = [ICeClassNativeAnimationProbe]::GetParameter(0x1042, 0, [ref]$animationValue, 0)
$animationError = if ($animationSucceeded) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
$effectsValue = 0
$effectsSucceeded = [ICeClassNativeAnimationProbe]::GetParameter(0x103E, 0, [ref]$effectsValue, 0)
$compositionEnabled = $false
$compositionResult = [ICeClassNativeAnimationProbe]::DwmIsCompositionEnabled([ref]$compositionEnabled)
$os = Get-CimInstance Win32_OperatingSystem -Property Caption, Version, BuildNumber
$graphics = @(Get-CimInstance Win32_VideoController -Property Name, DriverVersion, DriverDate, VideoModeDescription |
    Select-Object Name, DriverVersion, DriverDate, VideoModeDescription)

[ordered]@{
    OS = $os.Caption
    Version = $os.Version
    BuildNumber = $os.BuildNumber
    ClientAreaAnimationQuerySucceeded = $animationSucceeded
    ClientAreaAnimationQueryError = $animationError
    ClientAreaAnimationEnabled = $(if ($animationSucceeded) { $animationValue -ne 0 } else { $null })
    ReceiverAnimationsEnabled = -not $animationSucceeded -or $animationValue -ne 0
    UIEffectsEnabled = $(if ($effectsSucceeded) { $effectsValue -ne 0 } else { $null })
    RemoteSession = [ICeClassNativeAnimationProbe]::GetSystemMetrics(0x1000) -ne 0
    DesktopCompositionEnabled = $(if ($compositionResult -eq 0) { $compositionEnabled } else { $null })
    Graphics = $graphics
    Note = 'Receiver 2.5.2 gates native motion on ClientAreaAnimationEnabled; UIEffects/RemoteSession/composition are diagnostic context only. No settings changed.'
} | ConvertTo-Json -Depth 4

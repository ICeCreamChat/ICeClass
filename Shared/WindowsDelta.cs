using System.ComponentModel;
using System.Runtime.InteropServices;

namespace ICeClass.Updates;

internal static class WindowsDelta
{
    // Windows SDK msdelta.h: DELTA_FLAG_TYPE is a signed 64-bit integer.
    [DllImport("msdelta.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ApplyDeltaW(long flags, string source, string delta, string target);

    internal static void Apply(string source, string delta, string target)
    {
        if (!ApplyDeltaW(0, source, delta, target))
            throw new InvalidDataException("更新补丁无法还原，原程序保持不变。", new Win32Exception(Marshal.GetLastWin32Error()));
    }
}

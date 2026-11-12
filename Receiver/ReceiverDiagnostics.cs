using System.Runtime.InteropServices;
using System.Text;
using ICeClass.Diagnostics;
using Microsoft.Win32;

namespace ICeClass.Receiver;

internal static class ReceiverDiagnostics
{
    internal static Task<string> CollectAsync(string state, CancellationToken token) => Task.Run(() =>
    {
        token.ThrowIfCancellationRequested();
        var text = new StringBuilder("ICeClass 教室端诊断报告\n");
        text.AppendLine($"整理时间：{DateTimeOffset.Now:O}");
        text.AppendLine("【运行环境】");
        text.AppendLine($"版本：{ReceiverUpdateService.CurrentVersionText}");
        text.AppendLine($"系统：{RuntimeInformation.OSDescription} / {RuntimeInformation.ProcessArchitecture}");
        text.AppendLine($"运行时：.NET {Environment.Version}；系统架构 {RuntimeInformation.OSArchitecture}");
        text.AppendLine($"逻辑处理器：{Environment.ProcessorCount}；进程内存：{Environment.WorkingSet / 1024 / 1024} MB");
        text.AppendLine($"系统时区：{TimeZoneInfo.Local.Id}");
        text.AppendLine($"Windows 动画：{(DesktopStyle.AnimationsEnabled() ? "开启" : "关闭")}");
        text.AppendLine($"Windows 高对比度：{DesktopStyle.HighContrastEnabled()}；系统透明效果：{TransparencyPreference()}");
        if (OperatingSystem.IsWindows()) text.AppendLine($"DWM 桌面合成：{(DwmIsCompositionEnabled(out var composition) == 0 ? composition.ToString() : "读取失败")}");
        text.AppendLine("【当前状态】");
        text.AppendLine(state.Length > 0 ? state : "未提供主窗口状态。");
        text.AppendLine("诊断存储：" + AppLog.StorageStatus);
        text.AppendLine("【近期运行与错误日志】");
        text.AppendLine("本机日志按容量轮换；下方最多收录当前文件最近 256 KB 和上一文件最近 128 KB，不能还原未记录的历史。");
        text.AppendLine(AppLog.ReadRecent());
        token.ThrowIfCancellationRequested();
        return SupportDiagnostics.Redact(text.ToString());
    }, token);

    private static string TransparencyPreference()
    {
        if (!OperatingSystem.IsWindows()) return "不适用";
        try
        {
            return Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency", null) switch
            { 1 => "开启", 0 => "关闭", _ => "未设置" };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        { return "读取失败（" + error.GetType().Name + "）"; }
    }

    [DllImport("dwmapi.dll")] private static extern int DwmIsCompositionEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);
}

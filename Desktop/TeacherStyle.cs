using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

internal static class TeacherStyle
{
    internal static void Apply(Window window, bool floating = false)
    {
        window.Foreground = DesktopStyle.Ink;
        window.FontFamily = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI");
        window.FontSize = 16;
        RenderOptions.SetTextRenderingMode(window, TextRenderingMode.Antialias);
        if (floating) window.Classes.Add("teacher-surface");
        else ClassroomGlassHost.Apply(window, teacher: true);
    }
}

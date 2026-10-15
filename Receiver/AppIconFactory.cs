using System.Reflection;

namespace ICeClass.Receiver;

internal static class AppIconFactory
{
    public static Stream CreateStream() => Open("app.ico");
    public static Stream CreateBitmapStream() => Open("app-icon.png");
    private static Stream Open(string name) => Assembly.GetExecutingAssembly()
        .GetManifestResourceStream("ICeClass.Branding." + name)
        ?? throw new InvalidOperationException("应用图标资源缺失。");
}

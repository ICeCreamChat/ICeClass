using Avalonia.Controls;
namespace ICeClass.Receiver;

internal sealed class AboutWindow : Window
{
    internal static readonly (string Title, string Resource)[] Notices = AboutContent.Notices;
    internal static string ReadNotice(int index) => AboutContent.ReadNotice(index);

    public AboutWindow(Func<CancellationToken, Task<string>>? collectDiagnostics = null,
        Func<string, CancellationToken, Task<string>>? submitDiagnostics = null,
        string? acknowledgementsEndpoint = null)
    {
        ClassroomStyle.Apply(this);
        Title = "关于 ICeClass 班伴 · 教室端";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 740; Height = 660; MinWidth = 600; MinHeight = 500;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = DesktopStyle.Brush("#F5F7FB");
        DesktopStyle.KeepWindowInWorkingArea(this);
        Content = AboutContent.Build("教室端", ReceiverUpdateService.CurrentVersionText,
            () => Close(),
            collectDiagnostics: collectDiagnostics ?? (token => ReceiverDiagnostics.CollectAsync("", token)), submitDiagnostics: submitDiagnostics,
            acknowledgementsEndpoint: acknowledgementsEndpoint);
    }
}

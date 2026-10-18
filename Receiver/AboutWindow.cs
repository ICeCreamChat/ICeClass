using Avalonia.Controls;
namespace ICeClass.Receiver;

internal sealed class AboutWindow : Window
{
    internal static readonly (string Title, string Resource)[] Notices = AboutContent.Notices;
    internal static string ReadNotice(int index) => AboutContent.ReadNotice(index);

    public AboutWindow()
    {
        ClassroomStyle.Apply(this);
        Title = "关于 ICeClass 班伴 · 教室端";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 740; Height = 660; MinWidth = 600; MinHeight = 500;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = DesktopStyle.Brush("#F5F7FB");
        DesktopStyle.KeepWindowInWorkingArea(this);
        Content = AboutContent.Build("教室端", ReceiverUpdateService.CurrentVersionText,
            "接收班级通知、开展早读活动，也可以给本班老师留言。",
            "关闭窗口后收起到托盘。检查更新请前往“教室设置 → 客户端更新”。", () => Close());
    }
}

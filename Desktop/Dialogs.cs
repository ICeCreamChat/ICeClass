using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Automation;
using Avalonia.Layout;
using Avalonia.Media;
using ICeClass.Receiver;

namespace ICeClass.Desktop;

internal static class Dialogs
{
    internal static Button Button(string text, bool primary = false)
    {
        var button = DesktopStyle.Button(text, primary); button.FontSize = 14; button.MinHeight = 40; return button;
    }
    internal static Window Window(string title, double width = 480)
    {
        var window = new Window { Title = title, Width = width, SizeToContent = SizeToContent.Height, CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = DesktopStyle.Brush("#F5F8FC"), Icon = new WindowIcon(AppIconFactory.CreateStream()) };
        window.KeyDown += (_, args) => { if (args.Key == Key.Escape) { args.Handled = true; window.Close(); } };
        return window;
    }
    internal static async Task<bool> Confirm(Window owner, string title, string message, string action)
    {
        return await CreateConfirmation(title, message, action).ShowDialog<bool>(owner);
    }
    internal static Window CreateConfirmation(string title, string message, string action)
    {
        var window = Window(title); var cancel = Button("取消"); var accept = Button(action, true);
        cancel.Click += (_, _) => window.Close(false); accept.Click += (_, _) => window.Close(true);
        var buttons = new Grid { ColumnDefinitions = new ColumnDefinitions("*,10,*") };
        buttons.Children.Add(cancel); Grid.SetColumn(accept, 2); buttons.Children.Add(accept);
        window.Content = new StackPanel { Margin = new Thickness(24, 20), Spacing = 16,
            Children = { DesktopStyle.Text(title, 20, true), DesktopStyle.Text(message, 14, muted: true), buttons } };
        window.Opened += (_, _) => cancel.Focus(); return window;
    }
    internal static async Task Message(Window owner, string title, string message)
    {
        await CreateMessage(title, message).ShowDialog(owner);
    }
    internal static Window CreateMessage(string title, string message)
    {
        var window = Window(title); var done = Button("知道了", true); done.Click += (_, _) => window.Close();
        window.Content = new StackPanel { Margin = new Thickness(24, 20), Spacing = 16, Children = { DesktopStyle.Text(title, 20, true), DesktopStyle.Text(message, 14, muted: true), done } };
        return window;
    }
}

internal sealed class SettingsWindow : Window
{
    internal SettingsWindow(DesktopSettings current)
    {
        Title = "桌面设置"; Width = 520; Height = 480; MinWidth = 380; MinHeight = 400; CanResize = true;
        WindowStartupLocation = WindowStartupLocation.CenterOwner; Background = DesktopStyle.Brush("#F5F8FC"); Icon = new WindowIcon(AppIconFactory.CreateStream());
        DesktopStyle.KeepWindowInWorkingArea(this);
        var endpoint = new TextBox { Text = current.Endpoint, Watermark = DesktopSettings.DefaultEndpoint, FontSize = 14 };
        AutomationProperties.SetName(endpoint, "学校平台地址");
        var tray = new CheckBox { Content = "关闭窗口后收起到托盘", IsChecked = current.CloseToTray, FontSize = 14 };
        var error = DesktopStyle.Text("", 13); error.Foreground = DesktopStyle.Brush("#AC3D32"); error.IsVisible = false;
        var cancel = Dialogs.Button("取消"); var save = Dialogs.Button("保存设置", true);
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { args.Handled = true; Close(null); } };
        cancel.Click += (_, _) => Close(null);
        save.Click += (_, _) =>
        {
            try { Close(new DesktopSettings { Endpoint = DesktopSettings.NormalizeEndpoint(endpoint.Text ?? ""), CloseToTray = tray.IsChecked == true }); }
            catch (ArgumentException invalid) { error.Text = invalid.Message; error.IsVisible = true; endpoint.Focus(); }
        };
        var buttons = new Grid { ColumnDefinitions = new ColumnDefinitions("*,10,*") };
        buttons.Children.Add(cancel); Grid.SetColumn(save, 2); buttons.Children.Add(save);
        var platform = new StackPanel { Spacing = 6, Children = { DesktopStyle.Text("学校平台地址", 14, true), endpoint,
            DesktopStyle.Text("填写学校工作台的网址，通常无需修改。班班的 API 地址和密钥请在班班的连接设置中填写。", 13, muted: true), error } };
        var behavior = new StackPanel { Spacing = 6, Children = { DesktopStyle.Text("窗口行为", 14, true), tray,
            DesktopStyle.Text("收起后，可从桌面图标或托盘重新打开。需要结束程序时，请在托盘菜单选择“退出 ICeClass 班伴 · 教师端”。", 13, muted: true) } };
        var form = new StackPanel { Spacing = 14, Children = { DesktopStyle.Card(platform, 14), DesktopStyle.Card(behavior, 14) } };
        var heading = new StackPanel { Spacing = 4, Children = { DesktopStyle.Text("桌面设置", 20, true), DesktopStyle.Text("仅影响这台电脑上的教师端。", 13, muted: true) } };
        var layout = new Grid { Margin = new Thickness(24, 20), RowDefinitions = new RowDefinitions("Auto,14,*") };
        layout.Children.Add(heading);
        var scroll = new ScrollViewer { Content = form, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        Grid.SetRow(scroll, 2); layout.Children.Add(scroll);
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        root.Children.Add(layout);
        var footer = DesktopStyle.DialogFooter(buttons);
        Grid.SetRow(footer, 1); root.Children.Add(footer); Content = root;
    }
}

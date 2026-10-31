using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ComputerControlSettingsWindow : Window
{
    internal ComputerControlSettingsWindow(ClassroomAgentService agent, ReceiverConfig? binding, ClassroomAgentPolicy? initialPolicy = null, Func<Task>? stopTask = null)
    {
        ClassroomStyle.Apply(this); Title = "班班电脑控制 · ICeClass 班伴";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 700; Height = 760; MinWidth = 440; MinHeight = 400;
        Background = DesktopStyle.Brush("#F5F7FB");
        DesktopStyle.KeepWindowInWorkingArea(this); WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var policy = initialPolicy ?? ClassroomAgentPolicy.Load();
        var enabled = new CheckBox { Content = "允许有本班操作权限的教师使用班班控制本机", IsChecked = policy.Enabled, FontSize = 14 };
        var interaction = new CheckBox { Content = "允许打开课件、操作应用与填写内容", IsChecked = policy.AllowInteraction, FontSize = 14 };
        var status = ClassroomStyle.Text(agent.Status, 14);
        AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
        var stop = ClassroomStyle.Button("立即停止电脑操作");
        stop.Classes.Add("native-stop");
        async Task StopTask()
        {
            stop.IsEnabled = false; stop.Content = "正在停止…";
            try { if (stopTask is not null) await stopTask(); else agent.Stop(); }
            finally { status.Text = agent.Status; stop.Content = "立即停止电脑操作"; stop.IsEnabled = true; }
        }
        stop.Click += async (_, _) => await StopTask();
        var error = ClassroomStyle.Caption("");
        AutomationProperties.SetLiveSetting(error, AutomationLiveSetting.Polite);
        var body = new StackPanel { Spacing = 18, Children = { ClassroomStyle.Title("班班电脑控制"),
            ClassroomStyle.SettingsSection("本机权限", new StackPanel { Spacing = 8, Children = { enabled, interaction,
                ClassroomStyle.Caption("仅操作已绑定教室和允许的应用。关闭此权限会立即停止后续输入。"), stop, status } }) } };
        var apps = new StackPanel { Spacing = 8 };
        var folders = new StackPanel { Spacing = 8 };
        var allFolders = new CheckBox { Content = "允许访问本机所有文件夹", IsChecked = policy.AllowAllFolders, FontSize = 14,
            Name = "AllowAllFolders" };
        void RenderApps()
        {
            apps.Children.Clear();
            foreach (var app in policy.Available(binding))
            {
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
                var copy = new StackPanel { Spacing = 3, Children = { ClassroomStyle.Text(app.Name, 14, true), ClassroomStyle.Text(app.Path, 12, muted: true) } };
                row.Children.Add(copy);
                if (policy.Applications.Contains(app.Path, StringComparer.OrdinalIgnoreCase))
                {
                    var remove = ClassroomStyle.Button("移除"); remove.Margin = new Thickness(8, 0, 0, 0);
                    remove.Click += (_, _) => { policy.Applications.RemoveAll(p => string.Equals(p, app.Path, StringComparison.OrdinalIgnoreCase)); RenderApps(); };
                    Grid.SetColumn(remove, 1); row.Children.Add(remove);
                }
                apps.Children.Add(row);
            }
            if (apps.Children.Count == 0) apps.Children.Add(ClassroomStyle.Caption("未发现可用应用，可手动添加本机程序。"));
        }
        void RenderFolders()
        {
            folders.Children.Clear();
            foreach (var folder in policy.Folders.ToArray())
            {
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
                row.Children.Add(ClassroomStyle.Text(folder, 14));
                var remove = ClassroomStyle.Button("移除"); remove.Margin = new Thickness(8, 0, 0, 0);
                remove.Click += (_, _) => { policy.Folders.Remove(folder); RenderFolders(); };
                Grid.SetColumn(remove, 1); row.Children.Add(remove); folders.Children.Add(row);
            }
            if (folders.Children.Count == 0) folders.Children.Add(ClassroomStyle.Caption("尚未选择文件夹。"));
        }
        var addApp = ClassroomStyle.Button("添加应用"); addApp.HorizontalAlignment = HorizontalAlignment.Left;
        addApp.Click += async (_, _) =>
        {
            try
            {
                var selected = await StorageProvider.OpenFilePickerAsync(new() { Title = "选择允许的应用", AllowMultiple = false,
                    FileTypeFilter = [new FilePickerFileType("Windows 应用") { Patterns = ["*.exe"] }] });
                var path = selected.FirstOrDefault()?.TryGetLocalPath();
                if (path is not null && File.Exists(path) && Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase))
                { policy.Applications.Add(Path.GetFullPath(path)); RenderApps(); }
            }
            catch (Exception exception) { error.Text = exception.Message; }
        };
        var addFolder = ClassroomStyle.Button("选择文件夹"); addFolder.HorizontalAlignment = HorizontalAlignment.Left;
        addFolder.Click += async (_, _) =>
        {
            try
            {
                var selected = await StorageProvider.OpenFolderPickerAsync(new() { Title = "允许班班访问的文件夹", AllowMultiple = false });
                var path = selected.FirstOrDefault()?.TryGetLocalPath();
                if (path is not null && !policy.Folders.Contains(path, StringComparer.OrdinalIgnoreCase)) { policy.Folders.Add(path); RenderFolders(); }
            }
            catch (Exception exception) { error.Text = exception.Message; }
        };
        RenderApps(); RenderFolders();
        var appDetails = new Expander { Header = "已识别的应用", Content = apps, HorizontalAlignment = HorizontalAlignment.Stretch };
        body.Children.Add(ClassroomStyle.SettingsSection("应用", new StackPanel { Spacing = 12, Children = { appDetails, addApp,
            ClassroomStyle.Caption("自动识别常用教学应用，并沿用浮岛允许的程序；其他程序在本机添加。WPS 和希沃的实际操作取决于安装版本。") } }));
        var selectedFolders = new StackPanel { Spacing = 12, Children = { folders, addFolder } };
        var folderHint = ClassroomStyle.Caption("");
        void RenderAccess()
        {
            selectedFolders.IsVisible = allFolders.IsChecked != true;
            folderHint.Text = allFolders.IsChecked == true ? "使用当前 Windows 账号权限，可访问桌面、下载和各磁盘文件夹。" : "只访问下方选择的文件夹及其子文件夹。";
        }
        allFolders.IsCheckedChanged += (_, _) => RenderAccess();
        RenderAccess();
        body.Children.Add(ClassroomStyle.SettingsSection("文件访问", new StackPanel { Spacing = 12, Children = { allFolders, folderHint, selectedFolders } }));
        body.Children.Add(error);
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(24), Child = body }, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled });
        var footer = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), Margin = new Thickness(24, 12) };
        var cancel = ClassroomStyle.Button("取消"); cancel.IsCancel = true; cancel.HorizontalAlignment = HorizontalAlignment.Left; cancel.Click += (_, _) => Close(); footer.Children.Add(cancel);
        var save = ClassroomStyle.Button("保存本机设置", true); Grid.SetColumn(save, 1); footer.Children.Add(save);
        save.Click += async (_, _) =>
        {
            try { policy.Enabled = enabled.IsChecked == true; policy.AllowInteraction = interaction.IsChecked == true; policy.AllowAllFolders = allFolders.IsChecked == true; policy.Save(); if (!policy.Enabled || !policy.AllowInteraction) await StopTask(); Close(); }
            catch (Exception exception) { error.Text = "保存失败：" + exception.Message; }
        };
        Grid.SetRow(footer, 1); root.Children.Add(footer); Content = root;
        void Update(string text) => Dispatcher.UIThread.Post(() => status.Text = text);
        agent.StatusChanged += Update;
        Closed += (_, _) => agent.StatusChanged -= Update;
    }
}

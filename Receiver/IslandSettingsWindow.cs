using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Markup.Xaml.Styling;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using System.Text.Json;

namespace ICeClass.Receiver;

internal sealed class IslandSettingsWindow : Window
{
    public IslandSettingsWindow(IslandLocalSettings saved, IslandAppearance school, Action<IslandLocalSettings> apply, Action testReminder, Action? playDemo = null, Action? previewShout = null)
    {
        ClassroomStyle.Apply(this); Title = "教室浮岛设置 · ICeClass 班伴";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 760; Height = 780; MinWidth = 440; MinHeight = 400;
        Background = DesktopStyle.Brush("#F5F7FB");
        Classes.Add("island-settings");
        Styles.Add(new StyleInclude(new Uri("avares://ICeClass/")) { Source = new Uri("avares://ICeClass/IslandSettingsStyles.axaml") });
        DesktopStyle.KeepWindowInWorkingArea(this); WindowStartupLocation = WindowStartupLocation.CenterScreen;
        var local = JsonSerializer.Deserialize<IslandLocalSettings>(JsonSerializer.Serialize(saved, IslandProfile.Json), IslandProfile.Json)!;
        var appearance = local.Appearance ?? JsonSerializer.Deserialize<IslandAppearance>(JsonSerializer.Serialize(school, IslandProfile.Json), IslandProfile.Json)!;
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        var body = new StackPanel { Spacing = 16, MaxWidth = 656, HorizontalAlignment = HorizontalAlignment.Stretch };
        body.Children.Add(new StackPanel { Spacing = 4, Children = {
            ClassroomStyle.Title("教室浮岛设置"),
            ClassroomStyle.Caption("课表与提醒由教师端配置；在这里管理本机外观、自动化应用与预览。") } });
        var pairedFields = new List<(Grid Grid, Control Left, Control Right)>();
        var previewRows = new List<(Grid Grid, Control Action)>();
        Grid Pair(Control left, Control right)
        {
            var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*"), RowDefinitions = new RowDefinitions("Auto,Auto") };
            grid.Children.Add(left); Grid.SetColumn(right, 1); grid.Children.Add(right);
            pairedFields.Add((grid, left, right)); return grid;
        }
        Button ActionButton(string label)
        {
            var button = ClassroomStyle.Button(label); button.FontSize = 14; button.MinHeight = 40;
            button.Padding = new Thickness(12, 6); button.HorizontalAlignment = HorizontalAlignment.Left;
            return button;
        }
        Grid PreviewRow(string title, string description, Button action)
        {
            var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), RowDefinitions = new RowDefinitions("Auto,Auto") };
            row.Children.Add(new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center, Children = {
                ClassroomStyle.Text(title, 14, true), ClassroomStyle.Text(description, 13, muted: true) } });
            Grid.SetColumn(action, 1); row.Children.Add(action); previewRows.Add((row, action)); return row;
        }
        var independent = new CheckBox { Content = "本机使用独立外观", IsChecked = local.Appearance is not null, FontSize = 14 };
        var appearanceHint = ClassroomStyle.Caption("");
        var form = new StackPanel { Spacing = 12 };
        void UpdateAppearanceMode()
        {
            form.IsEnabled = independent.IsChecked == true;
            appearanceHint.Text = form.IsEnabled ? "以下调整仅应用于这台教室电脑。" : "当前跟随教师端外观；开启独立外观后可在本机调整。";
        }
        independent.IsCheckedChanged += (_, _) => UpdateAppearanceMode(); UpdateAppearanceMode();
        var positions = new[] { "top-center", "top-left", "top-right", "bottom-center" };
        var position = new ComboBox { ItemsSource = new[] { "顶部居中", "左上角", "右上角", "底部居中" }, SelectedIndex = Math.Max(0, Array.IndexOf(positions, appearance.Position)), HorizontalAlignment = HorizontalAlignment.Stretch };
        var themes = new[] { "dark", "light", "system" };
        var theme = new ComboBox { ItemsSource = new[] { "深色", "浅色", "跟随系统" }, SelectedIndex = Math.Max(0, Array.IndexOf(themes, appearance.Theme)), HorizontalAlignment = HorizontalAlignment.Stretch };
        var width = new NumericUpDown { Minimum = 380, Maximum = 1000, Increment = 20, Value = appearance.Width };
        var opacity = new NumericUpDown { Minimum = 30, Maximum = 100, Value = appearance.Opacity };
        var offsetX = new NumericUpDown { Minimum = -2000, Maximum = 2000, Value = appearance.OffsetX };
        var offsetY = new NumericUpDown { Minimum = -2000, Maximum = 2000, Value = appearance.OffsetY };
        AutomationProperties.SetName(position, "悬浮岛位置"); AutomationProperties.SetName(theme, "悬浮岛主题");
        AutomationProperties.SetName(width, "悬浮岛宽度"); AutomationProperties.SetName(opacity, "悬浮岛不透明度");
        AutomationProperties.SetName(offsetX, "悬浮岛水平偏移"); AutomationProperties.SetName(offsetY, "悬浮岛垂直偏移");
        form.Children.Add(Pair(ClassroomStyle.Field("位置", position), ClassroomStyle.Field("主题", theme)));
        form.Children.Add(Pair(ClassroomStyle.Field("宽度 (DIP)", width), ClassroomStyle.Field("不透明度 (%)", opacity)));
        form.Children.Add(Pair(ClassroomStyle.Field("水平偏移", offsetX), ClassroomStyle.Field("垂直偏移", offsetY)));
        var through = new CheckBox { Content = "允许鼠标穿透", IsChecked = appearance.ClickThrough, FontSize = 14 };
        var fullscreen = new CheckBox { Content = "全屏应用时自动隐藏", IsChecked = appearance.HideFullscreen, FontSize = 14 };
        var lessons = new CheckBox { Content = "上课时自动隐藏", IsChecked = appearance.HideDuringLessons, FontSize = 14 };
        form.Children.Add(ClassroomStyle.SettingsDivider());
        form.Children.Add(new StackPanel { Spacing = 0, Children = { through,
            ClassroomStyle.Text("启用后，从教室首页或托盘恢复悬浮岛操作。", 13, muted: true) } });
        form.Children.Add(fullscreen); form.Children.Add(lessons);
        body.Children.Add(ClassroomStyle.SettingsSection("外观与显示", new StackPanel { Spacing = 12, Children = {
            new StackPanel { Spacing = 2, Children = { independent, appearanceHint } }, ClassroomStyle.SettingsDivider(), form } }));

        var apps = new StackPanel { Spacing = 12 };
        void RenderApps()
        {
            apps.Children.Clear();
            foreach (var path in local.AllowedApplications.ToArray())
            {
                if (apps.Children.Count > 0) apps.Children.Add(ClassroomStyle.SettingsDivider());
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
                var name = ClassroomStyle.Text(Path.GetFileName(path), 14, true); name.TextWrapping = TextWrapping.NoWrap; name.TextTrimming = TextTrimming.CharacterEllipsis;
                var location = ClassroomStyle.Text(path, 13, muted: true); location.TextWrapping = TextWrapping.NoWrap; location.TextTrimming = TextTrimming.CharacterEllipsis;
                ToolTip.SetTip(location, path);
                row.Children.Add(new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center, Children = { name, location } });
                var remove = ActionButton("移除"); remove.Margin = new Thickness(12, 0, 0, 0); remove.VerticalAlignment = VerticalAlignment.Center;
                remove.Click += (_, _) => { local.AllowedApplications.Remove(path); RenderApps(); };
                Grid.SetColumn(remove, 1); row.Children.Add(remove); apps.Children.Add(row);
            }
            if (local.AllowedApplications.Count == 0) apps.Children.Add(ClassroomStyle.Caption("尚未允许任何本机应用。"));
        }
        RenderApps();
        var add = ActionButton("选择并允许应用…");
        var error = ClassroomStyle.Text("", 14); error.Foreground = DesktopStyle.Brush("#B42318"); error.IsVisible = false;
        error.PropertyChanged += (_, change) => { if (change.Property == TextBlock.TextProperty) error.IsVisible = !string.IsNullOrWhiteSpace(error.Text); };
        add.Click += async (_, _) =>
        {
            try
            {
                var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions { Title = "选择允许自动打开的应用", AllowMultiple = false,
                    FileTypeFilter = [new FilePickerFileType("Windows 应用") { Patterns = ["*.exe"] }] });
                var path = files.FirstOrDefault()?.TryGetLocalPath();
                if (path is not null && File.Exists(path) && Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase) && !local.AllowedApplications.Contains(path, StringComparer.OrdinalIgnoreCase))
                { local.AllowedApplications.Add(Path.GetFullPath(path)); RenderApps(); error.Text = ""; }
            }
            catch (Exception e) { error.Text = e.Message; }
        };
        body.Children.Add(ClassroomStyle.SettingsSection("自动化应用", new StackPanel { Spacing = 12, Children = {
            ClassroomStyle.Caption("只允许自动打开本机选择的应用，教师端填写的路径需与此一致。"), apps, add } }));
        var previews = new StackPanel { Spacing = 12 };
        if (playDemo is not null)
        {
            var demo = ActionButton("播放完整演示"); demo.Click += (_, _) => { Close(); playDemo(); };
            previews.Children.Add(PreviewRow("完整演示", "使用示例课表播放课前提醒、倒计时与上课。", demo));
            previews.Children.Add(ClassroomStyle.SettingsDivider());
        }
        var test = ActionButton("预览单条提醒（8 秒）"); test.Click += (_, _) => { testReminder(); Close(); };
        previews.Children.Add(PreviewRow("课前提醒", "仅在本机显示一条课前提示。", test));
        if (previewShout is not null)
        {
            previews.Children.Add(ClassroomStyle.SettingsDivider());
            var shout = ActionButton("预览班班喊话"); shout.Click += (_, _) => { Close(); previewShout(); };
            previews.Children.Add(PreviewRow("班班喊话", "查看普通、重要与紧急三种喊话。", shout));
        }
        body.Children.Add(ClassroomStyle.SettingsSection("演示与预览", previews));
        var recent = new StackPanel { Spacing = 10 };
        foreach (var entry in saved.RecentActions.TakeLast(10).Reverse())
        {
            if (recent.Children.Count > 0) recent.Children.Add(ClassroomStyle.SettingsDivider());
            recent.Children.Add(ClassroomStyle.Text(entry, 14));
        }
        if (saved.RecentActions.Count == 0) recent.Children.Add(ClassroomStyle.Caption("暂无自动化执行记录。"));
        body.Children.Add(ClassroomStyle.SettingsSection("最近执行", recent));
        root.Children.Add(new ScrollViewer { Content = new Border { Padding = new Thickness(28, 20), Child = body },
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled });
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        var cancel = ClassroomStyle.Button("取消"); cancel.MinWidth = 100; cancel.HorizontalAlignment = HorizontalAlignment.Left;
        cancel.Click += (_, _) => Close(); actions.Children.Add(cancel);
        var save = ClassroomStyle.Button("保存本机设置", true); save.MinWidth = 144; save.HorizontalAlignment = HorizontalAlignment.Right;
        save.Click += (_, _) =>
        {
            appearance.Position = positions[position.SelectedIndex]; appearance.Theme = themes[theme.SelectedIndex]; appearance.Width = (int)(width.Value ?? 640); appearance.Opacity = (int)(opacity.Value ?? 100);
            appearance.OffsetX = (int)(offsetX.Value ?? 0); appearance.OffsetY = (int)(offsetY.Value ?? 0);
            appearance.ClickThrough = through.IsChecked == true; appearance.HideFullscreen = fullscreen.IsChecked == true; appearance.HideDuringLessons = lessons.IsChecked == true;
            local.Appearance = independent.IsChecked == true ? appearance : null;
            try { apply(local); Close(); } catch (Exception e) { error.Text = e.Message; }
        };
        Grid.SetColumn(save, 1); actions.Children.Add(save);
        var errorBox = new Border { Background = DesktopStyle.Brush("#FFF1EF"), CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 10), Child = error, IsVisible = false };
        error.PropertyChanged += (_, change) => { if (change.Property == IsVisibleProperty) errorBox.IsVisible = error.IsVisible; };
        var footer = new StackPanel { Spacing = 8, MaxWidth = 656, HorizontalAlignment = HorizontalAlignment.Stretch, Children = { errorBox, actions } };
        var footerBox = DesktopStyle.DialogFooter(footer, 28); Grid.SetRow(footerBox, 1); root.Children.Add(footerBox); Content = root;
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { args.Handled = true; Close(); } };
        void ArrangeSettings()
        {
            var narrow = Bounds.Width < 600;
            foreach (var pair in pairedFields)
            {
                pair.Grid.ColumnDefinitions = new ColumnDefinitions(narrow ? "*" : "*,*");
                pair.Left.Margin = narrow ? new Thickness(0, 0, 0, 12) : new Thickness(0, 0, 6, 0);
                pair.Right.Margin = narrow ? new Thickness(0) : new Thickness(6, 0, 0, 0);
                Grid.SetColumn(pair.Right, narrow ? 0 : 1); Grid.SetRow(pair.Right, narrow ? 1 : 0);
            }
            foreach (var row in previewRows)
            {
                row.Grid.ColumnDefinitions = new ColumnDefinitions(narrow ? "*" : "*,Auto");
                Grid.SetColumn(row.Action, narrow ? 0 : 1); Grid.SetRow(row.Action, narrow ? 1 : 0);
                row.Action.Margin = narrow ? new Thickness(0, 10, 0, 0) : new Thickness(16, 0, 0, 0);
                row.Action.VerticalAlignment = VerticalAlignment.Center;
            }
        }
        SizeChanged += (_, _) => ArrangeSettings(); ArrangeSettings();
    }
}

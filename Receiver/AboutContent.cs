using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

// One layout for both native editions; only the product description and update action differ.
internal static class AboutContent
{
    internal static readonly (string Title, string Resource)[] Notices =
    [
        ("应用许可", "LICENSE"), ("第三方说明", "THIRD_PARTY_NOTICES.md"),
        ("WebView2 许可", "WebView2-LICENSE.txt"), ("WebView2 说明", "WebView2-NOTICE.txt"),
    ];

    internal static string ReadNotice(int index)
    {
        using var stream = typeof(AboutContent).Assembly.GetManifestResourceStream("ICeClass.Notices." + Notices[index].Resource)
            ?? throw new InvalidOperationException("应用内许可说明缺失。");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    internal static Control Build(string edition, string version, string description, string note, Action close, Action? checkUpdates = null)
    {
        var root = new Grid { RowDefinitions = new RowDefinitions("Auto,*,Auto") };
        var brand = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*"), Margin = new Thickness(28, 16) };
        brand.Children.Add(DesktopStyle.Logo(48));
        var metadata = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto") };
        metadata.Children.Add(DesktopStyle.Text($"{edition} · 版本 {version}", 14, muted: true));
        var registration = DesktopStyle.Text("皖ICP备2025106471号", 14, muted: true);
        registration.Margin = new Thickness(16, 0, 0, 0);
        registration.HorizontalAlignment = HorizontalAlignment.Right;
        registration.TextWrapping = TextWrapping.NoWrap;
        Grid.SetColumn(registration, 1); metadata.Children.Add(registration);
        var words = new StackPanel { Spacing = 3, Margin = new Thickness(16, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
            Children = { DesktopStyle.Text("ICeClass 班伴", 22, true), metadata } };
        Grid.SetColumn(words, 1); brand.Children.Add(words);
        root.Children.Add(new Border { Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E2E8F0"), BorderThickness = new Thickness(0, 0, 0, 1), Child = brand });

        var body = new Grid { Margin = new Thickness(28, 16), RowDefinitions = new RowDefinitions("Auto,14,Auto,8,Auto,10,*") };
        var summary = new StackPanel { Spacing = 6, Children = {
            DesktopStyle.Text(description, 15), DesktopStyle.Text(note, 14, muted: true) } };
        body.Children.Add(summary);
        var heading = DesktopStyle.Text("许可与第三方说明", 14, true);
        Grid.SetRow(heading, 2); body.Children.Add(heading);

        var document = new SelectableTextBlock { FontSize = 14, LineHeight = 24, TextWrapping = TextWrapping.Wrap,
            Foreground = DesktopStyle.Ink, FontFamily = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI") };
        var documentScroll = new ScrollViewer { Content = document,
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        AutomationProperties.SetName(document, "许可文档内容，可选择并复制");
        var choices = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*") };
        var buttons = new List<Button>();
        var selected = 0;
        void SelectDocument(int index)
        {
            selected = index; document.Text = ReadNotice(index); documentScroll.Offset = default;
            for (var n = 0; n < buttons.Count; n++)
            {
                buttons[n].Classes.Set("selected", n == index);
                AutomationProperties.SetName(buttons[n], Notices[n].Title + (n == index ? "，当前文档" : ""));
            }
        }
        for (var i = 0; i < Notices.Length; i++)
        {
            var index = i;
            var button = DesktopStyle.Button(Notices[i].Title); button.Classes.Add("native-document");
            button.Classes.Add("classroom-document"); button.Classes.Add("document-choice");
            button.Margin = new Thickness(i == 0 ? 0 : 2, 0, i == Notices.Length - 1 ? 0 : 2, 0);
            button.Click += (_, _) => SelectDocument(index);
            button.KeyDown += (_, args) =>
            {
                var next = args.Key switch { Key.Left => (selected + buttons.Count - 1) % buttons.Count,
                    Key.Right => (selected + 1) % buttons.Count, Key.Home => 0, Key.End => buttons.Count - 1, _ => -1 };
                if (next < 0) return;
                args.Handled = true; SelectDocument(next); buttons[next].Focus(NavigationMethod.Directional);
            };
            Grid.SetColumn(button, i); choices.Children.Add(button); buttons.Add(button);
        }
        var tabs = new Border { Background = DesktopStyle.Brush("#EDF2F8"), CornerRadius = new CornerRadius(11),
            Padding = new Thickness(4), Child = choices };
        Grid.SetRow(tabs, 4); body.Children.Add(tabs);
        var readerBox = new Border { Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E2E8F0"),
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(20, 12), Child = documentScroll };
        Grid.SetRow(readerBox, 6); body.Children.Add(readerBox);
        Grid.SetRow(body, 1); root.Children.Add(body);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, HorizontalAlignment = HorizontalAlignment.Right };
        if (checkUpdates is not null)
        {
            var update = DesktopStyle.Button("检查桌面更新"); update.MinWidth = 156;
            update.Click += (_, _) => checkUpdates(); actions.Children.Add(update);
        }
        var done = DesktopStyle.Button("完成", true); done.MinWidth = 104; done.IsCancel = true;
        done.Click += (_, _) => close(); actions.Children.Add(done);
        var footer = DesktopStyle.DialogFooter(actions, 28);
        Grid.SetRow(footer, 2); root.Children.Add(footer);
        SelectDocument(0);
        return root;
    }
}

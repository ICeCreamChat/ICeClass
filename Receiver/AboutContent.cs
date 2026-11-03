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
    internal const string GroupAcknowledgement = "感谢马鞍山市第二十二中学 AI建模社的全体成员";
    internal static readonly (string School, string Name)[] Acknowledgements =
    [
        ("马鞍山市第二十二中学", "高琦璐校长"),
        ("马鞍山市第二十二中学", "汪冰主任"),
        ("马鞍山市第二十二中学", "李善忠干事"),
        ("马鞍山市第二十二中学", "陈胜老师"),
        ("马鞍山市第二十二中学", "许斌老师"),
        ("马鞍山市理工学校", "李妮姗老师"),
    ];

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

    internal static Control Build(string edition, string version, string description, string note, Action close, Action? checkUpdates = null,
        Func<CancellationToken, Task<string>>? collectDiagnostics = null,
        Func<string, CancellationToken, Task<string>>? submitDiagnostics = null)
    {
        var root = new Grid { Background = Brushes.White, RowDefinitions = new RowDefinitions("Auto,*,Auto") };
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
        root.Children.Add(brand);

        var body = new Grid { Margin = new Thickness(28, 8, 28, 16), RowDefinitions = new RowDefinitions("Auto,12,*") };
        var summary = new StackPanel { Spacing = 6, Children = {
            DesktopStyle.Text(description, 15), DesktopStyle.Text(note, 14, muted: true) } };
        var thanksButton = DesktopStyle.Button("致谢名单");
        var licensesButton = DesktopStyle.Button("许可与说明");
        var historyButton = DesktopStyle.Button("更新记录");
        var diagnosticsButton = DesktopStyle.Button("诊断日志");
        var pageButtons = new[] { thanksButton, licensesButton, historyButton, diagnosticsButton };
        foreach (var button in pageButtons)
        {
            button.Classes.Add("native-document"); button.Classes.Add("document-choice");
        }
        var pages = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*") };
        for (var i = 0; i < pageButtons.Length; i++)
        {
            pageButtons[i].Margin = new Thickness(i == 0 ? 0 : 4, 0, i == pageButtons.Length - 1 ? 0 : 4, 0);
            Grid.SetColumn(pageButtons[i], i); pages.Children.Add(pageButtons[i]);
        }
        body.Children.Add(pages);
        var licenses = new Grid { RowDefinitions = new RowDefinitions("Auto,16,Auto,10,*"), IsVisible = false };
        licenses.Children.Add(summary);
        var thanks = BuildAcknowledgements(out var mascot);
        var history = DocumentReader(AboutReleaseNotes.Text, "版本更新与修复记录");
        var diagnostics = collectDiagnostics is null ? null : new AboutDiagnosticsView(edition, version, collectDiagnostics, submitDiagnostics);
        var diagnosticsPage = (Control?)diagnostics ?? DesktopStyle.Text("暂时无法读取本机日志，请重新打开主程序后重试。", 14);
        var pageViews = new[] { thanks, licenses, history, diagnosticsPage };
        var pageContent = new Grid();
        foreach (var page in pageViews) pageContent.Children.Add(page);
        Grid.SetRow(pageContent, 2); body.Children.Add(pageContent);
        var selectedPage = 0;
        void SelectPage(int index)
        {
            selectedPage = index;
            for (var i = 0; i < pageViews.Length; i++)
            {
                pageViews[i].IsVisible = i == index;
                pageButtons[i].Classes.Set("selected", i == index);
                AutomationProperties.SetName(pageButtons[i], pageButtons[i].Content + (i == index ? "，当前页面" : ""));
            }
            mascot.SetActive(index == 0); diagnostics?.SetActive(index == 3);
        }
        for (var i = 0; i < pageButtons.Length; i++)
        {
            var index = i; pageButtons[i].Click += (_, _) => SelectPage(index);
            pageButtons[i].KeyDown += (_, args) =>
            {
                var next = args.Key switch { Key.Left => (selectedPage + 3) % 4, Key.Right => (selectedPage + 1) % 4,
                    Key.Home => 0, Key.End => 3, _ => -1 };
                if (next < 0) return;
                SelectPage(next); pageButtons[next].Focus(NavigationMethod.Directional); args.Handled = true;
            };
        }

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
        Grid.SetRow(tabs, 2); licenses.Children.Add(tabs);
        var readerBox = new Border { Background = Brushes.White, BorderBrush = DesktopStyle.Brush("#E2E8F0"),
            BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(20, 12), Child = documentScroll };
        Grid.SetRow(readerBox, 4); licenses.Children.Add(readerBox);
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
        SelectPage(0);
        return root;
    }

    private static Control DocumentReader(string content, string accessibleName)
    {
        var text = new SelectableTextBlock { Text = content, FontSize = 14, LineHeight = 24, TextWrapping = TextWrapping.Wrap,
            Foreground = DesktopStyle.Ink, FontFamily = new FontFamily("Microsoft YaHei UI, Microsoft YaHei, Segoe UI") };
        AutomationProperties.SetName(text, accessibleName);
        return new Border { BorderBrush = DesktopStyle.Brush("#E2E8F0"), BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12), Padding = new Thickness(20, 12),
            Child = new ScrollViewer { Content = text, HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled } };
    }

    private static Control BuildAcknowledgements(out AboutThankYouMascot mascot)
    {
        mascot = new AboutThankYouMascot
        {
            Width = double.NaN, Height = 252,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var message = DesktopStyle.Text(GroupAcknowledgement, 17, true);

        var people = new StackPanel { Spacing = 24, VerticalAlignment = VerticalAlignment.Center };
        foreach (var school in Acknowledgements.GroupBy(person => person.School))
        {
            var names = new StackPanel { Spacing = 8 };
            foreach (var person in school)
            {
                names.Children.Add(DesktopStyle.Text(person.Name, 16));
            }
            var schoolName = DesktopStyle.Text(school.Key, 14, muted: true);
            people.Children.Add(new StackPanel { Spacing = 8, Children = { schoolName, names } });
        }
        var composition = new Grid { ColumnDefinitions = new ColumnDefinitions("1.6*,24,*"),
            RowDefinitions = new RowDefinitions("Auto,24,Auto"),
            Margin = new Thickness(28), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumnSpan(message, 3); composition.Children.Add(message);
        Grid.SetRow(people, 2); composition.Children.Add(people);
        Grid.SetRow(mascot, 2); Grid.SetColumn(mascot, 2); composition.Children.Add(mascot);
        var scroll = new ScrollViewer { Content = composition, Focusable = true,
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled };
        AutomationProperties.SetName(scroll, "致谢名单");
        return new Border { Background = DesktopStyle.Brush("#F4F8FD"), CornerRadius = new CornerRadius(12),
            ClipToBounds = true, Child = scroll };
    }
}

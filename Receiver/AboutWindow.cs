using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed class AboutWindow : Window
{
    internal static readonly (string Title, string Resource)[] Notices =
    [
        ("应用许可", "LICENSE"), ("第三方说明", "THIRD_PARTY_NOTICES.md"),
        ("WebView2 许可", "WebView2-LICENSE.txt"), ("WebView2 第三方说明", "WebView2-NOTICE.txt"),
    ];

    internal static string ReadNotice(int index)
    {
        using var stream = typeof(AboutWindow).Assembly.GetManifestResourceStream("ICeClass.Notices." + Notices[index].Resource)
            ?? throw new InvalidOperationException("应用内许可说明缺失。");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public AboutWindow()
    {
        Title = "关于班伴";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 780; Height = 640; MinWidth = 600; MinHeight = 440;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = DesktopStyle.Brush("#F5F5F7");
        var content = new TextBox
        {
            IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
            FontSize = 15, Padding = new Thickness(18), Background = Brushes.White,
            HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch,
        };
        var selector = new ComboBox { ItemsSource = Notices.Select(n => n.Title).ToArray(), HorizontalAlignment = HorizontalAlignment.Stretch, MinHeight = 46 };
        selector.SelectionChanged += (_, _) => { if (selector.SelectedIndex >= 0) content.Text = ReadNotice(selector.SelectedIndex); };
        var close = DesktopStyle.Button("完成", true);
        close.HorizontalAlignment = HorizontalAlignment.Right;
        close.MinWidth = 100;
        close.Click += (_, _) => Close();
        var grid = new Grid { Margin = new Thickness(24), RowDefinitions = new RowDefinitions("Auto,Auto,*,Auto") };
        var brand = DesktopStyle.Brand($"教室白板客户端 · {ReceiverUpdateService.CurrentVersionText}");
        brand.Margin = new Thickness(0, 0, 0, 20);
        selector.Margin = new Thickness(0, 0, 0, 14);
        close.Margin = new Thickness(0, 18, 0, 0);
        grid.Children.Add(brand);
        Grid.SetRow(selector, 1); grid.Children.Add(selector);
        Grid.SetRow(content, 2); grid.Children.Add(content);
        Grid.SetRow(close, 3); grid.Children.Add(close);
        Content = grid;
        selector.SelectedIndex = 0;
    }
}

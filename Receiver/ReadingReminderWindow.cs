using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ReadingReminderWindow : Window
{
    private readonly DispatcherTimer _expiry;
    private readonly Button _start = DesktopStyle.Button("开始晨读", true);
    private readonly TextBlock _error = DesktopStyle.Text("", 16);

    public ReadingReminderWindow(ReadingWindow period, Func<bool> isCurrent, Func<Task<bool>> openReading)
    {
        Title = "班伴 · 晨读提醒";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 600; SizeToContent = SizeToContent.Height; CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterScreen; Topmost = true;
        Background = DesktopStyle.Brush("#F5F8FC");
        var body = new StackPanel { Margin = new Thickness(36, 30), Spacing = 16 };
        body.Children.Add(DesktopStyle.Brand("一起开启今天的朗读"));
        body.Children.Add(new Border
        {
            Background = DesktopStyle.Brush("#E6F2FF"), CornerRadius = new CornerRadius(10), Padding = new Thickness(14, 8),
            HorizontalAlignment = HorizontalAlignment.Left,
            Child = DesktopStyle.Text($"晨读时段  {period.TimeLabel}  ·  北京时间", 17, true),
        });
        body.Children.Add(DesktopStyle.Text("晨读时间到了", 32, true));
        body.Children.Add(DesktopStyle.Text($"{period.ClassName}，现在开始今天的晨读吗？", 20));
        body.Children.Add(DesktopStyle.Text("开始后选择喜欢的陪伴模式。只有统计时段内的活动才计入本班记录。", 17, muted: true));
        _error.Foreground = DesktopStyle.Brush("#B33A32"); _error.IsVisible = false; body.Children.Add(_error);
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
        var later = DesktopStyle.Button("暂不开始"); later.Margin = new Thickness(0, 0, 6, 0); later.IsCancel = true;
        later.Click += (_, _) => Close(); actions.Children.Add(later);
        _start.Margin = new Thickness(6, 0, 0, 0); _start.IsDefault = true; Grid.SetColumn(_start, 1); actions.Children.Add(_start);
        _start.Click += async (_, _) =>
        {
            _start.IsEnabled = false; _start.Content = "正在打开…"; _error.IsVisible = false;
            try { if (await openReading()) Close(); else { _error.Text = "这个晨读时段已经结束或已被管理员调整。"; _error.IsVisible = true; } }
            catch (OperationCanceledException) { }
            catch (Exception error) { _error.Text = $"暂时无法打开：{error.Message}。请检查网络后重试。"; _error.IsVisible = true; }
            finally { _start.IsEnabled = true; _start.Content = "开始晨读"; }
        };
        body.Children.Add(actions);
        body.Children.Add(DesktopStyle.Text("本时段只提醒一次。选择暂不开始后，也可随时从教室首页打开。", 14, muted: true));
        Content = body;
        _expiry = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _expiry.Tick += (_, _) => { if (!isCurrent()) Close(); };
        Opened += (_, _) => _expiry.Start(); Closed += (_, _) => _expiry.Stop();
    }
}

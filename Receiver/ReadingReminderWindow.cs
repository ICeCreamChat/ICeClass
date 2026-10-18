using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ReadingReminderWindow : Window
{
    private readonly DispatcherTimer _expiry;
    private readonly Button _start = ClassroomStyle.Button("开始晨读", true);
    private readonly TextBlock _error = ClassroomStyle.Text("", 16);

    public ReadingReminderWindow(ReadingWindow period, Func<bool> isCurrent, Func<Task<bool>> openReading)
    {
        ClassroomStyle.Apply(this);
        Title = "ICeClass 班伴 · 晨读提醒";
        DesktopStyle.KeepWindowInWorkingArea(this);
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 600; Height = 400; CanResize = false;
        WindowStartupLocation = WindowStartupLocation.CenterScreen; Topmost = true;
        Background = DesktopStyle.Brush("#F5F5F7");
        var root = new Grid { RowDefinitions = new RowDefinitions("*,Auto") };
        var body = new StackPanel { Margin = new Thickness(24, 20), Spacing = 16 };
        var brand = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        brand.Children.Add(DesktopStyle.Logo(48));
        var brandWords = new StackPanel { Margin = new Thickness(12, 0, 0, 0), Spacing = 2,
            VerticalAlignment = VerticalAlignment.Center,
            Children = { ClassroomStyle.Text("ICeClass 班伴", 20, true), ClassroomStyle.Text("晨读提醒", 14, muted: true) } };
        Grid.SetColumn(brandWords, 1); brand.Children.Add(brandWords); body.Children.Add(brand);
        var message = new StackPanel { Spacing = 8 };
        message.Children.Add(ClassroomStyle.Text("晨读时间到了", 28, true));
        message.Children.Add(ClassroomStyle.Text($"{period.ClassName}，现在开始晨读吗？", 16));
        body.Children.Add(message);
        body.Children.Add(new Border
        {
            Background = DesktopStyle.Brush("#E8F2FF"), CornerRadius = new CornerRadius(12), Padding = new Thickness(14, 10),
            HorizontalAlignment = HorizontalAlignment.Left,
            Child = ClassroomStyle.Text($"{period.TimeLabel}  ·  北京时间", 14, true),
        });
        body.Children.Add(ClassroomStyle.Text("选择活动后即可朗读；统计时段内的活动计入本班记录。", 16, muted: true));
        body.Children.Add(ClassroomStyle.Text("本时段只提醒一次，您也可稍后从教室首页开始。", 14, muted: true));
        root.Children.Add(new ScrollViewer { Content = body,
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled });
        _error.Foreground = DesktopStyle.Brush("#B74C43"); _error.IsVisible = false;
        var actions = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*") };
        var later = ClassroomStyle.Button("暂不开始"); later.MinHeight = 44; later.Margin = new Thickness(0, 0, 6, 0); later.IsCancel = true;
        later.Click += (_, _) => Close(); actions.Children.Add(later);
        _start.MinHeight = 44; _start.Margin = new Thickness(6, 0, 0, 0); _start.IsDefault = true; Grid.SetColumn(_start, 1); actions.Children.Add(_start);
        _start.Click += async (_, _) =>
        {
            _start.IsEnabled = false; _start.Content = "正在打开…"; _error.IsVisible = false;
            try { if (await openReading()) Close(); else { _error.Text = "这个晨读时段已经结束或已被管理员调整。"; _error.IsVisible = true; } }
            catch (OperationCanceledException) { }
            catch (Exception error) { _error.Text = $"暂时无法打开：{error.Message}。请重试，或从教室首页打开。"; _error.IsVisible = true; }
            finally { _start.IsEnabled = true; _start.Content = "开始晨读"; }
        };
        var footer = DesktopStyle.DialogFooter(new StackPanel { Spacing = 8, Children = { _error, actions } });
        Grid.SetRow(footer, 1); root.Children.Add(footer); Content = root;
        _expiry = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _expiry.Tick += (_, _) => { if (!isCurrent()) Close(); };
        Opened += (_, _) => _expiry.Start(); Closed += (_, _) => _expiry.Stop();
    }
}

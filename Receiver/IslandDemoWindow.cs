using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed class IslandDemoWindow : Window
{
    private readonly TextBlock _status = ClassroomStyle.Text("课表", 18, true);
    private readonly TextBlock _time = ClassroomStyle.Caption("00:00 / 01:12");
    private readonly ProgressBar _progress = new() { Minimum = 0, Maximum = IslandDemoPlayback.Duration, Height = 4 };
    private readonly Button _play = ClassroomStyle.Button("暂停", true);
    private readonly Button _restart = ClassroomStyle.Button("从头播放");
    private readonly List<Button> _stages = [];

    public IslandDemoWindow(Action toggle, Action restart, Action<int> select)
    {
        ClassroomStyle.Apply(this);
        Title = "悬浮岛完整演示 · ICeClass 班伴";
        Icon = new WindowIcon(AppIconFactory.CreateStream());
        Width = 550; MinWidth = 380; CanResize = false; SizeToContent = SizeToContent.Height;
        Background = DesktopStyle.Brush("#FCFDFF");
        DesktopStyle.KeepWindowInWorkingArea(this);
        var body = new StackPanel { Spacing = 14, Margin = new Thickness(24, 20) };
        body.Children.Add(ClassroomStyle.SectionTitle("悬浮岛完整演示"));
        body.Children.Add(ClassroomStyle.Caption("请看屏幕顶部。点击下方阶段，可以停下来查看细节。"));
        var heading = new Grid { ColumnDefinitions = new("*,Auto") };
        heading.Children.Add(_status); _time.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(_time, 1); heading.Children.Add(_time); body.Children.Add(heading);
        body.Children.Add(_progress);
        var stages = new UniformGrid { Columns = 3, Rows = 2 };
        for (var index = 0; index < IslandDemoPlayback.Stages.Count; index++)
        {
            var selected = index;
            var button = ClassroomStyle.Button(IslandDemoPlayback.Stages[index].Title);
            button.FontSize = 14; button.MinHeight = 40; button.Margin = new Thickness(0, 0, 6, 6);
            button.Click += (_, _) => select(selected);
            _stages.Add(button); stages.Children.Add(button);
        }
        body.Children.Add(stages);
        body.Children.Add(ClassroomStyle.Caption("示例课表按 1 分钟课前提醒播放。退出后恢复本班课表。"));
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        _play.Click += (_, _) => toggle(); _restart.Click += (_, _) => restart();
        var close = ClassroomStyle.Button("结束演示"); close.Click += (_, _) => Close();
        actions.Children.Add(_play); actions.Children.Add(_restart); actions.Children.Add(close);
        body.Children.Add(actions);
        Content = body;
        KeyDown += (_, args) => { if (args.Key == Key.Escape) { Close(); args.Handled = true; } };
        Opened += (_, _) =>
        {
            var screen = Screens.Primary ?? Screens.ScreenFromWindow(this);
            if (screen is null) return;
            var work = screen.WorkingArea; var scale = screen.Scaling;
            Position = new PixelPoint(work.X + (int)((work.Width - Bounds.Width * scale) / 2),
                Math.Max(work.Y, work.Bottom - (int)((Bounds.Height + 64) * scale)));
        };
    }

    public void Update(IslandDemoPlayback playback, IslandDemoScene scene)
    {
        _status.Text = playback.Complete ? "演示结束，已恢复课表" :
            (playback.Playing ? "正在播放：" : "已暂停：") + IslandDemoPlayback.Stages[scene.Stage].Title;
        _time.Text = TimeSpan.FromSeconds(playback.Position).ToString(@"mm\:ss") + " / 01:12";
        _progress.Value = playback.Position;
        _play.Content = playback.Complete ? "重播演示" : playback.Playing ? "暂停" : "继续播放";
        _restart.IsVisible = !playback.Complete;
        for (var i = 0; i < _stages.Count; i++)
        {
            _stages[i].Background = DesktopStyle.Brush(i == scene.Stage ? "#EAF4FF" : "#FFFFFF");
            _stages[i].Foreground = DesktopStyle.Brush(i == scene.Stage ? "#005BB5" : "#536C85");
            _stages[i].FontWeight = i == scene.Stage ? FontWeight.SemiBold : FontWeight.Normal;
        }
    }
}

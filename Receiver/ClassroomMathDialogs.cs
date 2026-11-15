using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed record ClassroomQuestionWindow(string Id, string Title);
internal sealed record ClassroomQuestionSelection(int X, int Y, int Width, int Height);

internal static class ClassroomMathDialogs
{
    private static Window Create(string title, double width = 980, double height = 720)
    {
        var window = new Window { Title = title, Width = width, Height = height, MinWidth = Math.Min(width, 620), MinHeight = 420,
            Topmost = true, WindowStartupLocation = WindowStartupLocation.CenterScreen, Background = DesktopStyle.Brush("#E5F0F8") };
        ClassroomStyle.Apply(window); DesktopStyle.KeepWindowInWorkingArea(window);
        return window;
    }

    private static async Task<T?> Run<T>(Window window, TaskCompletionSource<T?> result, CancellationToken token) where T : class
    {
        token.ThrowIfCancellationRequested();
        window.KeyDown += (_, args) => { if (args.Key == Key.Escape) { args.Handled = true; window.Close(); } };
        window.Closed += (_, _) => result.TrySetResult(null);
        using var cancelled = token.Register(() => Dispatcher.UIThread.Post(window.Close));
        window.Show(); window.Activate();
        return await result.Task;
    }

    internal static Task<string?> ChooseWindowAsync(IReadOnlyList<ClassroomQuestionWindow> windows, CancellationToken token)
    {
        var result = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var window = Create("选择本次题目的 WPS 放映", 660, 460);
        var list = new StackPanel { Spacing = 12 };
        foreach (var candidate in windows)
        {
            var button = ClassroomStyle.Button(candidate.Title);
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.Click += (_, _) => { result.TrySetResult(candidate.Id); window.Close(); };
            list.Children.Add(button);
        }
        var cancel = ClassroomStyle.Button("取消"); cancel.Click += (_, _) => window.Close();
        window.Content = new StackPanel { Margin = new Thickness(24), Spacing = 18, Children = {
            ClassroomStyle.SectionTitle("选择正在讲评的课件"), ClassroomStyle.Caption("本次展台会话会记住这个窗口。"),
            new ScrollViewer { Content = list, MaxHeight = 250 }, cancel } };
        return Run(window, result, token);
    }

    internal static Task<ClassroomQuestionSelection?> SelectQuestionAsync(ClassroomMathImage image, CancellationToken token)
    {
        var result = new TaskCompletionSource<ClassroomQuestionSelection?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var window = Create("框选本次题目");
        var bitmap = new Bitmap(new MemoryStream(image.Bytes(), writable: false));
        var surface = new QuestionSelectionSurface(bitmap, image.Width, image.Height);
        window.Closed += (_, _) => bitmap.Dispose();
        var x = Field("左侧位置", image.Width - 1, 0); var y = Field("顶部位置", image.Height - 1, 0);
        var width = Field("选区宽度", image.Width, image.Width, 1); var height = Field("选区高度", image.Height, image.Height, 1);
        var syncing = false;
        void ReadFields()
        {
            if (syncing) return;
            surface.SetSelection(new((int)(x.Value ?? 0), (int)(y.Value ?? 0), (int)(width.Value ?? 1), (int)(height.Value ?? 1)));
        }
        foreach (var field in new[] { x, y, width, height }) field.ValueChanged += (_, _) => ReadFields();
        surface.SelectionChanged += selection => {
            syncing = true; x.Value = selection.X; y.Value = selection.Y; width.Value = selection.Width; height.Value = selection.Height; syncing = false;
        };
        var fields = new Grid { ColumnDefinitions = new ColumnDefinitions("*,*,*,*") };
        var labels = new[] { "左", "上", "宽", "高" }; var inputs = new[] { x, y, width, height };
        for (var index = 0; index < inputs.Length; index++)
        {
            var pair = new StackPanel { Spacing = 6, Margin = new Thickness(0, 0, index < 3 ? 12 : 0, 0), Children = { ClassroomStyle.Caption(labels[index]), inputs[index] } };
            Grid.SetColumn(pair, index); fields.Children.Add(pair);
        }
        var submit = ClassroomStyle.Button("点评所选题目", true); submit.IsDefault = true;
        var cancel = ClassroomStyle.Button("取消并继续展示");
        submit.Click += (_, _) => { result.TrySetResult(surface.Selection); window.Close(); };
        cancel.Click += (_, _) => window.Close();
        var layout = new Grid { Margin = new Thickness(24), RowDefinitions = new RowDefinitions("Auto,*,Auto,Auto") };
        layout.Children.Add(new StackPanel { Spacing = 8, Children = { ClassroomStyle.SectionTitle("框选完整题目"),
            ClassroomStyle.Caption("包含题干、条件、图形和本小问。可拖动框选，也可用下方坐标调整。") } });
        Grid.SetRow(surface, 1); layout.Children.Add(surface); Grid.SetRow(fields, 2); layout.Children.Add(fields);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, submit } };
        Grid.SetRow(actions, 3); layout.Children.Add(actions); window.Content = layout;
        foreach (var child in layout.Children.Take(3)) child.Margin = new Thickness(0, 0, 0, 16);
        return Run(window, result, token);
    }
    private static NumericUpDown Field(string name, int maximum, int value, int minimum = 0)
    {
        var field = new NumericUpDown { Minimum = minimum, Maximum = maximum, Value = value, Increment = 1, FormatString = "0", MinWidth = 90 };
        AutomationProperties.SetName(field, name); return field;
    }

    internal static async Task ShowQuestionAsync(ClassroomMathImage image, CancellationToken token)
    {
        var result = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var window = Create("本次题目");
        var bitmap = new Bitmap(new MemoryStream(image.Bytes(), writable: false));
        window.Closed += (_, _) => bitmap.Dispose();
        var close = ClassroomStyle.Button("返回讲评", true); close.Click += (_, _) => window.Close();
        var layout = new Grid { Margin = new Thickness(24), RowDefinitions = new RowDefinitions("Auto,*,Auto") };
        layout.Children.Add(ClassroomStyle.SectionTitle("本次点评的题目"));
        var picture = new Image { Source = bitmap, Stretch = Stretch.Uniform }; AutomationProperties.SetName(picture, "点击点评时固定的 WPS 题目截图");
        Grid.SetRow(picture, 1); layout.Children.Add(picture); Grid.SetRow(close, 2); layout.Children.Add(close); window.Content = layout;
        foreach (var child in layout.Children.Take(2)) child.Margin = new Thickness(0, 0, 0, 16);
        await Run(window, result, token);
    }

    private sealed class QuestionSelectionSurface : Control
    {
        private readonly Bitmap _image;
        private readonly int _width, _height;
        private Point? _origin;
        internal ClassroomQuestionSelection Selection { get; private set; }
        internal event Action<ClassroomQuestionSelection>? SelectionChanged;
        internal QuestionSelectionSurface(Bitmap image, int width, int height)
        {
            _image = image; _width = width; _height = height; Selection = new(0, 0, width, height);
            Focusable = true; ClipToBounds = true;
            AutomationProperties.SetName(this, "题目截图。方向键移动选区，Shift加方向键调整宽高，Ctrl加方向键每次调整十个像素。也可Tab到下方坐标。");
        }
        private Rect ImageBounds()
        {
            var scale = Math.Min(Bounds.Width / _width, Bounds.Height / _height);
            return new((Bounds.Width - _width * scale) / 2, (Bounds.Height - _height * scale) / 2, _width * scale, _height * scale);
        }
        internal void SetSelection(ClassroomQuestionSelection value)
        {
            var x = Math.Clamp(value.X, 0, _width - 1); var y = Math.Clamp(value.Y, 0, _height - 1);
            Selection = new(x, y, Math.Clamp(value.Width, 1, _width - x), Math.Clamp(value.Height, 1, _height - y));
            SelectionChanged?.Invoke(Selection); InvalidateVisual();
        }
        public override void Render(DrawingContext context)
        {
            var display = ImageBounds();
            if (display.Width <= 0 || display.Height <= 0) return;
            context.DrawRectangle(Brushes.White, null, new Rect(Bounds.Size));
            context.DrawImage(_image, new Rect(_image.Size), display);
            var scale = display.Width / _width; var selected = new Rect(display.X + Selection.X * scale, display.Y + Selection.Y * scale, Selection.Width * scale, Selection.Height * scale);
            context.DrawRectangle(new SolidColorBrush(Color.FromArgb(35, 0, 100, 215)), new Pen(DesktopStyle.Brush("#0064D7"), 2), selected);
        }
        private Point Pixel(Point position)
        {
            var rect = ImageBounds(); var scale = rect.Width / _width;
            return new(Math.Clamp((position.X - rect.X) / scale, 0, _width), Math.Clamp((position.Y - rect.Y) / scale, 0, _height));
        }
        protected override void OnPointerPressed(PointerPressedEventArgs args)
        {
            base.OnPointerPressed(args);
            if (!args.GetCurrentPoint(this).Properties.IsLeftButtonPressed || !ImageBounds().Contains(args.GetPosition(this))) return;
            Focus(); _origin = Pixel(args.GetPosition(this)); args.Pointer.Capture(this); args.Handled = true;
        }
        protected override void OnPointerMoved(PointerEventArgs args)
        {
            base.OnPointerMoved(args); if (_origin is not { } origin) return;
            var end = Pixel(args.GetPosition(this)); var left = (int)Math.Floor(Math.Min(origin.X, end.X)); var top = (int)Math.Floor(Math.Min(origin.Y, end.Y));
            SetSelection(new(left, top, (int)Math.Ceiling(Math.Max(origin.X, end.X)) - left, (int)Math.Ceiling(Math.Max(origin.Y, end.Y)) - top));
        }
        protected override void OnPointerReleased(PointerReleasedEventArgs args) { base.OnPointerReleased(args); _origin = null; args.Pointer.Capture(null); }
        protected override void OnKeyDown(KeyEventArgs args)
        {
            base.OnKeyDown(args); if (args.Key is not (Key.Left or Key.Right or Key.Up or Key.Down)) return;
            var step = args.KeyModifiers.HasFlag(KeyModifiers.Control) ? 10 : 1;
            var dx = args.Key == Key.Left ? -step : args.Key == Key.Right ? step : 0;
            var dy = args.Key == Key.Up ? -step : args.Key == Key.Down ? step : 0;
            SetSelection(args.KeyModifiers.HasFlag(KeyModifiers.Shift) ? Selection with { Width = Selection.Width + dx, Height = Selection.Height + dy }
                : Selection with { X = Selection.X + dx, Y = Selection.Y + dy }); args.Handled = true;
        }
    }
}

using System.Globalization;
using System.Xml.Linq;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;

namespace ICeClass.Receiver;

// The page supplies the labels and availability of its real classroom buttons.
internal sealed record CardQuizWheelAction(string Id, string Label, string Icon, bool Enabled);
internal sealed record CardQuizWheelState(bool HasSession, CardQuizWheelAction[] Actions, string Progress,
    string Status, string Feedback, bool Error, bool Multiple, bool MultiEnabled, bool CameraRunning);

/// <summary>A menu around the existing pet; it owns neither a mascot nor classroom state.</summary>
internal sealed class BanbanClassroomWheel : Canvas
{
    internal const double Diameter = 320, SurfaceHeight = 392;
    private readonly List<SectorButton> _buttons = [];
    private readonly TextBlock _status = new() { FontSize = 12, FontFamily = ClassroomStyle.Font,
        Foreground = DesktopStyle.Brush("#42647D"), TextTrimming = TextTrimming.CharacterEllipsis,
        HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 248 };
    private readonly Button _workbench = new() { Content = "开始课堂", MinHeight = 44, Padding = new Thickness(12, 4), FontSize = 13 };
    private readonly Button _multi = new() { Content = "收下一项", MinHeight = 44, Padding = new Thickness(12, 4), FontSize = 13, IsVisible = false };
    private readonly Border _footer;
    internal event Action<string>? ActionRequested;

    internal BanbanClassroomWheel()
    {
        Width = Diameter; Height = SurfaceHeight; IsVisible = false; ClipToBounds = false;
        _workbench.Classes.Add("native-button"); _multi.Classes.Add("native-button");
        _workbench.FontWeight = _multi.FontWeight = FontWeight.SemiBold;
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6,
            HorizontalAlignment = HorizontalAlignment.Center, Children = { _workbench, _multi } };
        _footer = new Border { Width = 264, Height = 68, CornerRadius = new CornerRadius(14),
            Background = DesktopStyle.Brush("#F5FAFF"), Padding = new Thickness(8, 3),
            Child = new StackPanel { Spacing = 1, Children = { _status, tools } } };
        SetLeft(_footer, (Diameter - _footer.Width) / 2); SetTop(_footer, Diameter + 4);
        Children.Add(_footer); _status.Text = "正在读取纸卡课堂…";
        _workbench.Click += (_, _) => ActionRequested?.Invoke("workbench");
        _multi.Click += (_, _) => ActionRequested?.Invoke("multi");
        AutomationProperties.SetName(this, "班班课堂功能");
    }

    internal void Update(CardQuizWheelState state)
    {
        var focused = _buttons.FirstOrDefault(button => button.IsKeyboardFocusWithin);
        // No parallel catalogue: build directly from the module's current controls.
        if (!_buttons.Select(b => b.ActionId).SequenceEqual(state.Actions.Select(a => a.Id)))
        {
            foreach (var button in _buttons) Children.Remove(button);
            _buttons.Clear();
            for (var index = 0; index < state.Actions.Length; index++)
            {
                var button = new SectorButton(state.Actions[index].Id, index);
                button.Click += (_, _) => ActionRequested?.Invoke(button.ActionId);
                button.KeyDown += (_, e) =>
                {
                    if (e.Key is Key.Left or Key.Right or Key.Up or Key.Down or Key.Home or Key.End)
                    { FocusAction(button, e.Key); e.Handled = true; }
                };
                Children.Insert(index, button); _buttons.Add(button);
            }
        }
        foreach (var action in state.Actions)
            _buttons.Single(b => b.ActionId == action.Id).Update(action);
        if (IsVisible && focused is { IsEnabled: false }) _workbench.Focus();
        _status.Text = state.Error ? state.Feedback : state.Multiple ? state.Status : state.Progress;
        _status.Foreground = DesktopStyle.Brush(state.Error ? "#9B3224" : "#42647D");
        ToolTip.SetTip(_status, string.Join(" · ", new[] { state.Progress, state.Status, state.Feedback }.Where(s => !string.IsNullOrEmpty(s))));
        AutomationProperties.SetHelpText(_status, state.Status + " " + state.Feedback);
        _workbench.Content = state.HasSession ? "工作台" : "开始课堂";
        _multi.IsVisible = state.Multiple; _multi.IsEnabled = state.MultiEnabled;
    }
    internal void ShowError(string message)
    {
        _status.Text = message; _status.Foreground = DesktopStyle.Brush("#9B3224"); ToolTip.SetTip(_status, message);
        foreach (var button in _buttons) button.IsEnabled = false;
        _multi.IsEnabled = false;
    }

    internal void FocusAction(Control? current, Key key)
    {
        var enabled = _buttons.Where(b => b.IsEnabled).ToArray();
        if (enabled.Length == 0) { _workbench.Focus(); return; }
        var index = Array.FindIndex(enabled, b => ReferenceEquals(b, current));
        var next = key == Key.Home ? 0 : key == Key.End ? enabled.Length - 1 :
            (index + (key is Key.Left or Key.Up ? -1 : 1) + enabled.Length) % enabled.Length;
        enabled[next].Focus();
    }

    internal bool ContainsInteractive(Point point)
    {
        var distance = Math.Sqrt(Math.Pow(point.X - Diameter / 2, 2) + Math.Pow(point.Y - Diameter / 2, 2));
        return distance is >= 72 and <= 158 || _footer.Bounds.Contains(point);
    }

    private sealed class SectorButton : Button
    {
        internal string ActionId { get; }
        private readonly Geometry _sector;
        private readonly TextBlock _label = new() { FontFamily = ClassroomStyle.Font, FontSize = 14,
            FontWeight = FontWeight.SemiBold, TextWrapping = TextWrapping.NoWrap,
            HorizontalAlignment = HorizontalAlignment.Center };
        private readonly Viewbox _icon = new() { Width = 24, Height = 24 };
        private string _iconName = "";
        private bool _primary;
        internal SectorButton(string id, int index)
        {
            ActionId = id; Name = "ClassroomWheel_" + id.Replace('-', '_');
            Width = Height = Diameter; Padding = new Thickness(0); BorderThickness = new Thickness(0);
            FocusAdorner = null; RenderTransformOrigin = RelativePoint.Center;
            var start = index * 45 - 22;
            var end = index * 45 + 22;
            _sector = new StreamGeometry();
            using (var path = ((StreamGeometry)_sector).Open())
            {
                Point PointAt(double radius, double angle) => new(Diameter / 2 + radius * Math.Sin(angle * Math.PI / 180),
                    Diameter / 2 - radius * Math.Cos(angle * Math.PI / 180));
                path.BeginFigure(PointAt(153, start), true);
                for (var step = 1; step <= 24; step++) path.LineTo(PointAt(153, start + (end - start) * step / 24));
                for (var step = 24; step >= 0; step--) path.LineTo(PointAt(72, start + (end - start) * step / 24));
                path.EndFigure(true);
            }
            Clip = _sector;
            var content = new StackPanel { Width = 78, Spacing = 3, Children = { _icon, _label }, IsHitTestVisible = false };
            var angle = index * Math.PI / 4;
            var canvas = new Canvas { Width = Diameter, Height = Diameter };
            SetLeft(content, Diameter / 2 + 113 * Math.Sin(angle) - 39);
            SetTop(content, Diameter / 2 - 113 * Math.Cos(angle) - 23);
            canvas.Children.Add(content); Content = canvas;
            Template = new FuncControlTemplate<Button>((button, _) => new ContentPresenter { Content = button.Content });
            PropertyChanged += (_, e) =>
            {
                if (e.Property == IsPointerOverProperty || e.Property == IsKeyboardFocusWithinProperty ||
                    e.Property == IsPressedProperty || e.Property == IsEnabledProperty) UpdateAppearance();
            };
        }
        internal void Update(CardQuizWheelAction action)
        {
            _label.Text = action.Label; _primary = ActionId == "collect";
            AutomationProperties.SetName(this, action.Label);
            ToolTip.SetTip(this, action.Enabled ? action.Label : action.Label + "（当前不可用）");
            if (_iconName != action.Icon) { _icon.Child = LoadIcon(action.Icon); _iconName = action.Icon; }
            IsEnabled = action.Enabled; UpdateAppearance();
        }
        private void UpdateAppearance()
        {
            var highlighted = IsEnabled && (IsPointerOver || IsKeyboardFocusWithin);
            Background = DesktopStyle.Brush(!IsEnabled ? "#EDF3F8" : _primary ? (highlighted ? "#1268BA" : "#2279C7") :
                ActionId == "end-session" ? (highlighted ? "#F6DDE3" : "#FAEBEF") : (highlighted ? "#D6E9F8" : "#EAF4FC"));
            Foreground = DesktopStyle.Brush(!IsEnabled ? "#60758A" : _primary ? "#FFFFFF" : ActionId == "end-session" ? "#9B3945" : "#244D70");
            _label.Foreground = Foreground;
            if (_icon.Child is Canvas canvas)
                foreach (var path in canvas.Children.OfType<Avalonia.Controls.Shapes.Path>()) path.Stroke = Foreground;
            RenderTransform = new ScaleTransform(highlighted ? (IsPressed ? 1.045 : 1.035) : 1, highlighted ? (IsPressed ? 1.045 : 1.035) : 1);
            ZIndex = highlighted ? 1 : 0; InvalidateVisual();
        }
        public override void Render(DrawingContext context)
        {
            context.DrawGeometry(Background, null, _sector);
            if (IsKeyboardFocusWithin)
            {
                var brush = this.TryFindResource("NativeFocusBrush", out var resource) ? resource as IBrush : DesktopStyle.Blue;
                context.DrawGeometry(null, new Pen(_primary ? Brushes.White : brush, 1.2), _sector);
            }
            base.Render(context);
        }
        private static Canvas LoadIcon(string name)
        {
            var canvas = new Canvas { Width = 24, Height = 24, IsHitTestVisible = false };
            var assembly = typeof(BanbanClassroomWheel).Assembly;
            var resource = assembly.GetManifestResourceNames().SingleOrDefault(path => path.Replace('\\', '/') == $"ICeClass.Local/card-quiz/icons/{name}.svg");
            using var stream = resource is null ? null : assembly.GetManifestResourceStream(resource);
            if (stream is null) return canvas;
            foreach (var shape in XDocument.Load(stream).Root!.Elements())
            {
                double Number(string key, double fallback = 0) => double.TryParse(shape.Attribute(key)?.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : fallback;
                Geometry? geometry = shape.Name.LocalName switch
                {
                    "path" => Geometry.Parse(shape.Attribute("d")!.Value),
                    "line" => new LineGeometry(new Point(Number("x1"), Number("y1")), new Point(Number("x2"), Number("y2"))),
                    "circle" => new EllipseGeometry(new Rect(Number("cx") - Number("r"), Number("cy") - Number("r"), Number("r") * 2, Number("r") * 2)),
                    "rect" => new RectangleGeometry(new Rect(Number("x"), Number("y"), Number("width"), Number("height")), Number("rx"), Number("rx")),
                    "polygon" => Geometry.Parse("M" + shape.Attribute("points")!.Value + "Z"),
                    _ => null
                };
                if (geometry is not null) canvas.Children.Add(new Avalonia.Controls.Shapes.Path { Data = geometry,
                    StrokeThickness = 1.8, StrokeLineCap = PenLineCap.Round, StrokeJoin = PenLineJoin.Round });
            }
            return canvas;
        }
    }
}

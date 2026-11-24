using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using SkiaSharp;
using System.Runtime.InteropServices;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

internal sealed record CardQuizCameraPreview(string Key, bool Phone, bool Folded);

internal sealed class BanbanCameraLens : Grid
{
    internal static readonly Size VideoSize = new(352, 198);
    private const int PixelWidth = 640, PixelHeight = 360;
    internal const int PixelBytes = PixelWidth * PixelHeight * 4;
    private byte[]? _pixels;
    private const double ToolbarHeight = 44;
    private const double SourceButtonWidth = 60;
    internal static readonly Size PreviewSize = new(VideoSize.Width, VideoSize.Height + ToolbarHeight);
    internal static readonly Size DockSize = new(48, 48);
    private const double Corner = 12;
    private readonly bool _contrast = DesktopStyle.HighContrastEnabled();
    private readonly Grid _aperture = new();
    private readonly StackPanel _choices = new()
    {
        Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Center, IsVisible = false
    };
    // Both the wide preview and an older sender's square crop include the detected card corners.
    private readonly Image _frame = new() { Stretch = Stretch.Uniform, IsHitTestVisible = false };
    private readonly Border _waiting;
    private readonly DispatcherTimer _staleFrame = new() { Interval = TimeSpan.FromSeconds(3) };
    private readonly Button _source, _fold, _dock, _phone, _board;
    private readonly ContentControl _sourceFace = new() { IsHitTestVisible = false };
    private readonly Viewbox _phoneCheck, _boardCheck;
    private readonly IBrush _accent, _secondary;
    private CardQuizCameraPreview? _state;
    internal Size Footprint => _state is null ? default : _state.Folded ? DockSize : PreviewSize;
    internal event Action<CardQuizWheelCommand>? ActionRequested;

    internal BanbanCameraLens()
    {
        IsVisible = false;
        _accent = _contrast ? Brushes.Black : ActionBlue;
        _secondary = _contrast ? Brushes.Black : SecondaryInk;
        var surface = _contrast ? Brushes.White : ToolFill;
        var rim = _contrast ? Brushes.Black : ToolEdge;
        _aperture.Width = PreviewSize.Width;
        _aperture.Height = PreviewSize.Height;
        _aperture.RowDefinitions = new RowDefinitions
        {
            new(VideoSize.Height, GridUnitType.Pixel), new(ToolbarHeight, GridUnitType.Pixel)
        };
        _aperture.Background = _contrast ? Brushes.Black : DesktopStyle.Brush("#24394A");
        _aperture.Clip = new RectangleGeometry(new Rect(PreviewSize), Corner, Corner);
        _waiting = new Border
        {
            Background = surface, IsHitTestVisible = false,
            Child = new StackPanel
            {
                VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center,
                Spacing = 6, Children = { Icon("camera", 26, _accent), Text("等待画面", 15, muted: true) }
            }
        };
        AutomationProperties.SetName(_frame, "相机实时取景");
        _aperture.Children.Add(_frame);
        _aperture.Children.Add(_waiting);

        var toolbar = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto,Auto") };
        var bar = new Border
        {
            Background = surface, Padding = new Thickness(4, 0), Child = toolbar
        };
        Grid.SetRow(bar, 1);
        _aperture.Children.Add(bar);
        _source = LensButton("相机来源", IconPair(_sourceFace, Glyph("chevron-down", 12, _secondary)),
            SourceButtonWidth, () => ShowChoices(true), fill: _contrast ? Brushes.White : ToolHover);
        _source.HorizontalAlignment = HorizontalAlignment.Left;
        toolbar.Children.Add(_source);

        _phoneCheck = Glyph("check", 14, _accent);
        _boardCheck = Glyph("check", 14, _accent);
        _phone = LensButton("暂停本轮，改用手机扫码", IconPair(Icon("phone", 20, _secondary), _phoneCheck),
            SourceButtonWidth, () => SelectSource(true));
        _board = LensButton("暂停本轮，改用电脑扫码", IconPair(Icon("monitor", 20, _secondary), _boardCheck),
            SourceButtonWidth, () => SelectSource(false));
        _choices.Children.Add(_phone);
        _choices.Children.Add(_board);
        _choices.Children.Add(LensButton("返回取景", Glyph("arrow-right", 18, _secondary, 180), 44, () => ShowChoices(false)));
        _choices.PropertyChanged += (_, e) =>
        {
            if (e.Property == IsKeyboardFocusWithinProperty && _choices.IsVisible && !_choices.IsKeyboardFocusWithin)
                ShowChoices(false, focus: false);
        };
        toolbar.Children.Add(_choices);

        _fold = LensButton("收起取景，继续扫码", Glyph("minimize-2", 18, _secondary), 44, () => Request("fold"));
        var stop = LensButton("关闭当前相机", Glyph("video-off", 18, _secondary), 44, () => Request("stop"));
        Grid.SetColumn(_fold, 1);
        Grid.SetColumn(stop, 2);
        toolbar.Children.Add(_fold);
        toolbar.Children.Add(stop);
        var outline = new Border
        {
            CornerRadius = new CornerRadius(Corner), BorderThickness = new Thickness(1), BorderBrush = rim,
            IsHitTestVisible = false
        };
        Grid.SetRowSpan(outline, 2);
        _aperture.Children.Add(outline);
        Children.Add(_aperture);
        _dock = LensButton("展开取景，正在扫码", Icon("scan-line", 22, _accent), DockSize.Width, () => Request("open"), dock: true);
        _dock.Clip = new RectangleGeometry(new Rect(DockSize), DockSize.Height / 2, DockSize.Height / 2);
        Children.Add(_dock);
        _staleFrame.Tick += (_, _) => ClearFrame();
        DetachedFromVisualTree += (_, _) => ClearFrame();
    }

    private Viewbox Icon(string glyph,double size,IBrush color)
    {
        if (glyph == "phone")
        {
            var phone = new Border { Width = 14,Height = 21,CornerRadius = new(3),BorderThickness = new(1.8),BorderBrush = color,
                Child = new Border { Width = 4,Height = 1.6,Margin = new(0,0,0,2),CornerRadius = new(1),Background = color,
                    HorizontalAlignment = HorizontalAlignment.Center,VerticalAlignment = VerticalAlignment.Bottom } };
            return new Viewbox { Width = size,Height = size,Child = phone,IsHitTestVisible = false };
        }
        return glyph is "camera" or "scan-line"
            ? ClassroomStyle.ResourceIcon($"ICeClass.Local/card-quiz/icons/{glyph}.svg",size,color) : Glyph(glyph,size,color);
    }

    private static StackPanel IconPair(Control device, Viewbox indicator) => new()
    {
        Orientation = Orientation.Horizontal, Spacing = 3, IsHitTestVisible = false,
        HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
        Children = { device, indicator }
    };

    private Button LensButton(string name, Control face, double width, Action action, bool dock = false, IBrush? fill = null)
    {
        var normal = fill ?? (dock ? (_contrast ? Brushes.White : ToolFill) : Brushes.Transparent);
        var edge = _contrast && (fill != null || dock) ? Brushes.Black : dock ? ToolEdge : Brushes.Transparent;
        var tint = _contrast ? Brushes.White : ToolHover;
        var pressed = _contrast ? Brushes.White : ToolPressed;
        var hover = fill == null ? tint : pressed;
        var height = dock ? DockSize.Height : ToolbarHeight;
        var faceHeight = dock ? height : 30;
        var skin = new Border
        {
            Width = width - (height - faceHeight), Height = faceHeight,
            CornerRadius = new(dock ? faceHeight / 2 : 9), BorderThickness = new Thickness(1), BorderBrush = edge,
            Background = normal, Child = face, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        face.HorizontalAlignment = HorizontalAlignment.Center;
        face.VerticalAlignment = VerticalAlignment.Center;
        var button = MakeButton(name);
        button.Width = width;
        button.Height = height;
        button.RenderTransform = null; // Press feedback stays inside the face; adjacent touch targets stay still.
        button.FocusAdorner = null; // Draw one focus rim on the visible face, inside the larger touch target.
        button.Padding = new Thickness(0);
        button.Content = skin;
        button.Template = new FuncControlTemplate<Button>((b, _) => new ContentPresenter { Background = Brushes.Transparent,
            Content = b.Content, HorizontalContentAlignment = HorizontalAlignment.Center, VerticalContentAlignment = VerticalAlignment.Center });
        button.PropertyChanged += (_, e) =>
        {
            if (e.Property != IsFocusedProperty && e.Property != IsPointerOverProperty && e.Property != Button.IsPressedProperty && e.Property != IsEnabledProperty) return;
            var outlined = button.IsFocused || button.IsPressed || (_contrast && (button.IsPointerOver || !button.IsEnabled));
            var outline = _accent;
            if (button.IsFocused && !_contrast && button.TryFindResource("NativeFocusBrush", out var focus) && focus is IBrush brush)
                outline = brush;
            skin.BorderBrush = outlined ? outline : edge;
            skin.Background = !button.IsEnabled ? tint : button.IsPressed ? pressed :
                button.IsPointerOver || button.IsFocused ? hover : normal;
        };
        button.Click += (_, _) => action();
        ToolTip.SetTip(button, name);
        return button;
    }

    private void Request(string action)
    {
        if (_state is { } current) ActionRequested?.Invoke(new("preview-"+action, Key:current.Key));
    }
    private void SelectSource(bool phone)
    {
        ShowChoices(false);
        if (_state?.Phone != phone) Request(phone ? "phone" : "board");
    }
    private void ShowChoices(bool open, bool focus = true)
    {
        _source.IsVisible = !open;
        _choices.IsVisible = open;
        if (focus) (open ? _state?.Phone == true ? _board : _phone : _source).Focus();
    }
    internal bool Back()
    {
        if (!IsVisible || !_choices.IsVisible) return false;
        ShowChoices(false);
        return true;
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.Handled) return;
        if (e.Key == Key.Escape && Back()) e.Handled = true;
        else if (_choices.IsKeyboardFocusWithin && e.Key is Key.Left or Key.Right or Key.Home or Key.End)
        {
            StepFocus(_choices.Children.OfType<Button>(), e.Source as Control, e.Key);
            e.Handled = true;
        }
    }

    internal void Update(CardQuizCameraPreview? view)
    {
        if (view == _state) return;
        var moveFocus = IsKeyboardFocusWithin;
        var sourceChanged = _state?.Phone != view?.Phone;
        ClearFrame();
        _state = view;
        ShowChoices(false, focus: false);
        IsVisible = view is not null;
        Width = Footprint.Width;
        Height = Footprint.Height;
        if (view is null) return;
        _aperture.IsVisible = !view.Folded;
        _dock.IsVisible = view.Folded;
        if (sourceChanged)
        {
            var name = view.Phone ? "手机" : "电脑";
            _sourceFace.Content = Icon(view.Phone ? "phone" : "monitor", 20, _accent);
            var description = name + "取景，选择相机来源";
            AutomationProperties.SetName(_source, description);
            ToolTip.SetTip(_source, description);
            SetChoice(_phone, _phoneCheck, "手机", view.Phone);
            SetChoice(_board, _boardCheck, "电脑", !view.Phone);
        }
        if (moveFocus) (view.Folded ? _dock : _fold).Focus();
    }

    private static void SetChoice(Button button, Viewbox check, string label, bool selected)
    {
        button.IsEnabled = !selected;
        button.Opacity = 1; // The disabled choice identifies the active device.
        check.IsVisible = selected;
        var name = selected ? label + "，当前来源" : "暂停本轮，改用" + label + "扫码";
        AutomationProperties.SetName(button, name);
        AutomationProperties.SetItemStatus(button, selected ? "当前来源" : "");
        ToolTip.SetTip(button, name);
        ToolTip.SetShowOnDisabled(button, true);
    }

    internal bool ContainsInteractive(Point p)
    {
        return _state is { } view && new RoundedRect(new Rect(Footprint), view.Folded ? DockSize.Height / 2 : Corner).ContainsExclusive(p);
    }

    internal void ShowFrame(string key,string data)
    {
        const string prefix = "data:image/jpeg;base64,";
        if (_state is not { Folded:false } view || view.Key != key || data.Length >= 65536 || !data.StartsWith(prefix,StringComparison.Ordinal)) return;
        try
        {
            var bytes = Convert.FromBase64String(data[prefix.Length..]);
            using var encoded = SKData.CreateCopy(bytes);
            using var codec = SKCodec.Create(encoded);
            if (codec?.EncodedFormat != SKEncodedImageFormat.Jpeg || codec.Info.Width != 288 || codec.Info.Height is not (162 or 288)) return;
            using var stream = new MemoryStream(bytes,false);
            var next = new Bitmap(stream);
            var old = _frame.Source as Bitmap;
            _frame.Source = next; old?.Dispose();
            _waiting.IsVisible = false;
            _staleFrame.Stop(); _staleFrame.Start();
        }
        catch (Exception e) when (e is FormatException or ArgumentException or InvalidDataException) { }
    }
    internal void ShowPixels(string key, Stream rgba)
    {
        if (_state is not { Folded:false } view || view.Key != key) return;
        _pixels ??= new byte[PixelBytes];
        rgba.ReadExactly(_pixels, 0, _pixels.Length);
        var bitmap = _frame.Source as WriteableBitmap;
        if (bitmap == null)
            bitmap = new WriteableBitmap(new PixelSize(PixelWidth, PixelHeight), new Vector(96,96), PixelFormat.Rgba8888, AlphaFormat.Opaque);
        using (var target = bitmap.Lock())
        {
            // RGBA rows in the shared buffer are packed. Honour any platform stride.
            const int row = PixelWidth * 4;
            if (target.RowBytes == row) Marshal.Copy(_pixels, 0, target.Address, PixelBytes);
            else for (var y=0; y<PixelHeight; y++)
                Marshal.Copy(_pixels, y*row, target.Address+y*target.RowBytes, row);
        }
        if (!ReferenceEquals(_frame.Source, bitmap))
        {
            var old = _frame.Source as Bitmap;
            _frame.Source = bitmap; old?.Dispose();
        }
        _frame.InvalidateVisual();
        _waiting.IsVisible = false;
        _staleFrame.Stop(); _staleFrame.Start();
    }
    private void ClearFrame()
    {
        _staleFrame.Stop();
        var old = _frame.Source as Bitmap;
        _frame.Source = null; old?.Dispose();
        _pixels = null;
        _waiting.IsVisible = true;
    }
}

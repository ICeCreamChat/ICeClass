using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Presenters;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Shapes;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;
using static ICeClass.Receiver.BanbanClassroomStyle;

namespace ICeClass.Receiver;

/// <summary>A wheel button whose face, pointer target and focus outline share the same geometry.</summary>
internal sealed class BanbanToolSector : Button
{
    internal enum Band { Tools, Shortcuts, Collection, Header, Footer, ReaderFooter, Setup }
    private const double Corner = 4, HalfGap = .019;
    private const double OuterRadius = BanbanClassroomWheel.Diameter / 2 - RimInset - SectorMargin;
    private readonly bool _contrast;
    private readonly IBrush _ink;
    private readonly double _inner, _legendRadius, _iconSize;
    private readonly Band _band;
    private readonly bool _primary;
    private readonly Border _symbol = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _caption = BanbanClassroomStyle.Text("", 15, true);
    private readonly Border _legend;
    private Geometry? _sector;
    private double _angle = double.NaN, _sweep;
    private string? _glyph;
    private string? _cardState;
    private UniformGrid? _cardDots;
    private int[]? _dotNumbers;
    private int? _pressedDot;
    internal int? ClickedCard { get; private set; }
    private int? _tally;
    private bool _quiet, _selected;
    private string? _mark;
    internal string ActionId { get; }

    internal BanbanToolSector(string id, bool contrast, IBrush ink, Band band = Band.Tools)
    {
        ActionId = id;
        _contrast = contrast;
        _primary = id == "primary";
        _ink = ink;
        _band = band;
        (_inner, _legendRadius, _iconSize) = band switch
        {
            Band.Tools => (36, 76, 22),
            Band.Shortcuts => (38, 76, 20),
            Band.Collection => (59, 81, 18),
            Band.Header => (60, 80, 18),
            Band.Setup => (56, 79, 18),
            Band.ReaderFooter => (59, 82, 15),
            _ => (58, 82, 16)
        };
        IsVisible = false;
        FocusAdorner = null;
        Padding = BorderThickness = new Thickness(0);
        _caption.TextAlignment = TextAlignment.Center;
        _caption.TextWrapping = TextWrapping.NoWrap;
        _caption.FontSize = band switch { Band.Footer or Band.ReaderFooter => 14, Band.Header => 16, _ => 15 };
        _caption.LineHeight = band switch { Band.Footer or Band.ReaderFooter => 17, Band.Header => 21, _ => 18 };
        var face = new StackPanel { Orientation = band == Band.Header ? Orientation.Horizontal : Orientation.Vertical,
            Spacing = band switch { Band.Footer or Band.ReaderFooter => 1, Band.Header => 4, _ => 2 }, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, Children = { _symbol, _caption } };
        _legend = new Border { Width = band == Band.Header ? 116 : 66, Height = 54, Child = face };
        Content = new Canvas { IsHitTestVisible = false, Children = { _legend } };
        Template = new FuncControlTemplate<Button>((button, _) => new ContentPresenter { Content = button.Content, IsHitTestVisible = false });
        PropertyChanged += (_, change) =>
        {
            if (change.Property == IsEnabledProperty) _legend.Opacity = IsEnabled || _primary ? 1 : .65;
            if (change.Property == IsPointerOverProperty || change.Property == IsFocusedProperty ||
                change.Property == IsPressedProperty || change.Property == IsEnabledProperty) InvalidateVisual();
        };
    }

    internal void SetAction(CardQuizWheelAction? action)
    {
        var name = ActionId switch { "voice" => "说话", "next" => "添加题目", _ => action!.Label };
        var (glyph, caption) = ActionId switch
        {
            "voice" => ("mic", "说话"),
            "next" => ("plus", "加题"),
            "exempt" => ("list-checks", "卡号"),
            "collect" => ("rotate-ccw", name == "讲解后练习" ? "练习" : "重收"),
            "source" => name == "换回本机" ? ("monitor", "本机") : ("scan-line", "扫码"),
            "edit" => name switch {
                "查看题目" => ("book-open", "看题"),
                "设置与揭晓答案" => ("check", "答案"),
                _ => ("file-pen-line", "题目")
            },
            "pause" => ("circle-pause", "暂停"),
            "seal" => ("square", "封存"),
            "options" => ("settings-2", "改项"),
            _ => throw new InvalidOperationException("未知课堂工具 " + ActionId)
        };
        SetFace(name, caption, glyph);
    }

    internal void SetFace(string name, string caption, string glyph, bool quiet = false, int? tally = null)
    {
        if (AutomationProperties.GetName(this) != name)
        {
            AutomationProperties.SetName(this, name);
            ToolTip.SetTip(this, name);
        }
        _caption.Text = caption;
        if (_glyph == glyph && _quiet == quiet && _tally == tally && _mark == null) return;
        _mark = null;
        _glyph = glyph;
        _quiet = quiet;
        _tally = tally;
        _symbol.IsVisible = true;
        var ink = (_primary || _selected) && !quiet ? Brushes.White : _ink;
        _caption.Foreground = ink;
        if (tally is int number)
        {
            var value = BanbanClassroomStyle.Text(number.ToString(), 17, true);
            value.Foreground = ink; value.LineHeight = _iconSize; value.TextAlignment = TextAlignment.Center;
            _symbol.Child = value;
        }
        else
            _symbol.Child = glyph is "scan-line" or "file-pen-line" or "camera" or "chart-no-axes-column" or "square" or "play" or "skip-forward"
                ? ClassroomStyle.ResourceIcon($"ICeClass.Local/card-quiz/icons/{glyph}.svg", _iconSize, ink)
                : glyph == "arrow-left" ? BanbanClassroomStyle.Glyph("arrow-right", _iconSize, ink, 180)
                : BanbanClassroomStyle.Glyph(glyph, _iconSize, ink);
        InvalidateVisual();
    }

    internal void SetChoice(string name, string caption, string icon, string? mark, bool selected)
    {
        if (_selected != selected)
        {
            _selected = selected;
            _glyph = _mark = null;
            Classes.Set("selected", selected);
            InvalidateVisual();
        }
        AutomationProperties.SetItemStatus(this, selected ? "已选" : "");
        if (string.IsNullOrEmpty(mark))
        {
            SetFace(name, caption, icon);
            return;
        }
        if (AutomationProperties.GetName(this) != name)
        {
            AutomationProperties.SetName(this, name);
            ToolTip.SetTip(this, name);
        }
        _caption.Text = caption;
        if (_mark == mark) return;
        _mark = mark;
        _glyph = null;
        var ink = selected ? Brushes.White : _ink;
        _caption.Foreground = ink;
        var value = BanbanClassroomStyle.Text(mark, mark.Length > 2 ? 13 : 18, true);
        value.LineHeight = 20;
        value.Foreground = ink;
        value.TextAlignment = TextAlignment.Center;
        _symbol.Child = value;
        _symbol.IsVisible = true;
        InvalidateVisual();
    }

    internal void SetOption(string name, string caption, string range)
    {
        _glyph = null;
        AutomationProperties.SetName(this, name);
        AutomationProperties.SetItemStatus(this, _primary ? "已选" : "");
        ToolTip.SetTip(this, name);
        _caption.Text = caption;
        var ink = _primary ? Brushes.White : _ink;
        if (_primary) _caption.Foreground = ink;
        _symbol.IsVisible = _primary || range.Length > 0;
        if (!_symbol.IsVisible) return;
        var marks = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        if (_primary) marks.Children.Add(BanbanClassroomStyle.Glyph("check", 13, ink));
        if (range.Length > 0)
        {
            var text = BanbanClassroomStyle.Text(range, 12, true);
            text.FontSize = 13;
            text.LineHeight = 16;
            text.Foreground = ink;
            marks.Children.Add(text);
        }
        _symbol.Child = marks;
    }

    private static string CardStatus(string state) => state switch {
        "received" => "已收", "exempt" => "免答", "partial" => "未完成", "unanswered" => "未答", "abstained" => "弃权", _ => "待收"
    };

    internal static Control CardMark(string state, double size, IBrush ink)
    {
        if (state == "exempt") return new Border { Width = size, Height = 2, Background = ink };
        var circle = new Ellipse { Width = size, Height = size, Stroke = ink, StrokeThickness = 1.5,
            Fill = state == "received" ? ink : null };
        if (state != "partial") return circle;
        return new Grid { Width = size, Height = size, Children = { circle, new Ellipse {
            Width = size, Height = size, Fill = ink, Clip = new RectangleGeometry(new Rect(0,0,size / 2,size)) } } };
    }

    internal void SetCard(int number, string state)
    {
        if (_cardState == state && _caption.Text == number.ToString()) return;
        _cardState = state;
        var received = state == "received";
        var ink = received ? Brushes.White : _ink;
        var status = CardStatus(state);
        _caption.Text = number.ToString();
        _caption.FontSize = 18; _caption.LineHeight = 22; _caption.Foreground = ink;
        _symbol.Child = received ? BanbanClassroomStyle.Glyph("check", 14, ink) : CardMark(state, 9, ink);
        var label = $"{number} 号卡，{status}";
        AutomationProperties.SetName(this, label);
        ToolTip.SetTip(this, label);
        InvalidateVisual();
    }

    internal void SetCardGroup(int start, CardQuizCardMark[] cards)
    {
        if (_cardDots is null)
        {
            _cardDots = new UniformGrid { Rows = 2, Columns = 5, Width = 43, Height = 18 };
            _dotNumbers = new int[10];
            for (var i = 0; i < 10; i++)
                _cardDots.Children.Add(new Border { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            _symbol.Child = _cardDots;
            _caption.FontSize = 13; _caption.LineHeight = 17;
            _caption.Text = cards[^1].Number == start ? start.ToString() : $"{start}-{cards[^1].Number}";
        }
        var changed = false;
        foreach (var card in cards)
        {
            var index = card.Number - start;
            _dotNumbers![index] = card.Number;
            var slot = (Border)_cardDots.Children[index];
            if (Equals(slot.Tag,card.State)) continue;
            slot.Tag = card.State;
            slot.Child = CardMark(card.State, 6.5, card.State is "received" or "partial" ? _ink :
                _contrast ? Brushes.Black : DesktopStyle.Brush("#52728A"));
            changed = true;
        }
        if (!changed) return;
        var label = _caption.Text + " 号卡";
        var summary = string.Join("，", cards.GroupBy(c => c.State).Select(group => CardStatus(group.Key) + " " + group.Count()));
        AutomationProperties.SetName(this, label);
        AutomationProperties.SetItemStatus(this, summary);
        ToolTip.SetTip(this, label + " · " + summary);
    }

    // The whole sector opens its range. A precise tap on the map locates that printed number.
    private int? DotAt(PointerEventArgs e)
    {
        if (_cardDots is null) return null;
        var p = e.GetPosition(_cardDots); var size = _cardDots.Bounds.Size;
        if (p.X < 0 || p.Y < 0 || p.X >= size.Width || p.Y >= size.Height) return null;
        var slot = 5 * (int)(2 * p.Y / size.Height) + (int)(5 * p.X / size.Width);
        return _dotNumbers![slot];
    }

    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        _pressedDot = DotAt(e);
        base.OnPointerPressed(e);
    }

    protected override void OnPointerReleased(PointerReleasedEventArgs e)
    {
        var released = DotAt(e);
        ClickedCard = released == _pressedDot ? released : 0;
        try { base.OnPointerReleased(e); }
        finally { ClickedCard = _pressedDot = null; }
    }

    internal void Place(int index, int count)
    {
        // Clockwise from twelve for a full ring, left to right across six for the footer.
        var sweep = _band switch {
            Band.Footer => Math.Clamp(114d / count, 36, 60) * Math.PI / 180,
            Band.ReaderFooter => Math.Clamp(90d / count, 36, 40) * Math.PI / 180,
            Band.Header => Math.PI * 84 / 180,
            _ => Math.Tau / count
        };
        var angle = _band is Band.Footer or Band.ReaderFooter ? Math.PI + ((count - 1) / 2d - index) * sweep : index * sweep;
        if (_angle == angle && _sweep == sweep) return;
        _angle = angle;
        _sweep = sweep;
        var start = angle - sweep / 2 + HalfGap;
        var end = angle + sweep / 2 - HalfGap;
        var geometry = new StreamGeometry();
        using (var path = geometry.Open())
        {
            var first = Polar(OuterRadius, start + Corner / OuterRadius);
            path.BeginFigure(first, true);
            path.ArcTo(Polar(OuterRadius, end - Corner / OuterRadius), new Size(OuterRadius, OuterRadius), 0, end - start - 2 * Corner / OuterRadius > Math.PI, SweepDirection.Clockwise);
            path.QuadraticBezierTo(Polar(OuterRadius, end), Polar(OuterRadius - Corner, end));
            path.LineTo(Polar(_inner + Corner, end));
            path.QuadraticBezierTo(Polar(_inner, end), Polar(_inner, end - Corner / _inner));
            path.ArcTo(Polar(_inner, start + Corner / _inner), new Size(_inner, _inner), 0, end - start - 2 * Corner / _inner > Math.PI, SweepDirection.CounterClockwise);
            path.QuadraticBezierTo(Polar(_inner, start), Polar(_inner + Corner, start));
            path.LineTo(Polar(OuterRadius - Corner, start));
            path.QuadraticBezierTo(Polar(OuterRadius, start), first);
            path.EndFigure(true);
        }
        var legend = Polar(_legendRadius, angle);
        // Upright side labels need room above the narrowing outer chord.
        if (_band is Band.Footer or Band.ReaderFooter && count == 3 && index != 1)
            legend = new Point(legend.X, legend.Y - 6);
        SetGeometry(geometry, legend);
    }

    private void SetGeometry(Geometry geometry, Point center)
    {
        // Tight button bounds give UI Automation a meaningful clickable point for each tool.
        var bounds = geometry.Bounds;
        var left = Math.Floor(bounds.X);
        var top = Math.Floor(bounds.Y);
        Width = Math.Ceiling(bounds.Right) - left;
        Height = Math.Ceiling(bounds.Bottom) - top;
        Canvas.SetLeft(this, left);
        Canvas.SetTop(this, top);
        geometry.Transform = new TranslateTransform(-left, -top);
        Clip = _sector = geometry;
        Canvas.SetLeft(_legend, center.X - left - _legend.Width / 2);
        Canvas.SetTop(_legend, center.Y - top - _legend.Height / 2);
        InvalidateVisual();
    }

    private static Point Polar(double radius, double angle) =>
        new(BanbanClassroomWheel.Diameter / 2 + radius * Math.Sin(angle),
            BanbanClassroomWheel.Diameter / 2 - radius * Math.Cos(angle));

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        if (_sector == null) return;
        var active = IsEnabled && (IsPointerOver || IsFocused);
        var fill = _contrast ? Brushes.White : IsPressed ? ToolPressed : active ? ToolHover : ToolFill;
        var marked = (_primary || _selected) && !_quiet || _cardState == "received";
        if (marked) fill = _contrast ? Brushes.Black : !IsEnabled ? DesktopStyle.Brush("#526B80")
            : IsPressed ? DesktopStyle.Brush("#0057A8") : active ? DesktopStyle.Brush("#005FBF") : DesktopStyle.Blue;
        var stroke = _contrast ? Brushes.Black : ToolEdge;
        if (_contrast && IsFocused && marked) stroke = Brushes.White;
        if (!_contrast && active && this.TryFindResource("NativeFocusBrush", out var focus) && focus is IBrush brush)
            stroke = brush;
        context.DrawGeometry(fill, new Pen(stroke, active ? 3 : 1.5), _sector);
    }
}

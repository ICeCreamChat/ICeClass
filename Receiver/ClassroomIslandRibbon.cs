using System.Diagnostics;
using System.Globalization;
using System.Xml.Linq;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// The desktop ribbon keeps a constant height. Transitions are painted inside a
// rounded clip, so notifications never measure or expand the controls panel.
internal sealed class ClassroomIslandRibbon : Control, IDisposable
{
    internal const double RibbonHeight = 48;
    private IslandRibbonFrame? _frame, _previous;
    private long _started, _presentedAt;
    private bool _queued, _disposed;
    private readonly Dictionary<(string, double, string, int), FormattedText> _text = new();
    private readonly Dictionary<string, Geometry[]> _icons = new();
    private string _shoutText = "";
    private int _shoutWidth;
    private IReadOnlyList<string> _shoutPages = [];
    public bool Light { get; set; }
    internal bool ImportantExpanded { get; set; }
    internal bool FullTextExpanded { get; set; }
    internal bool Animate { get; set; } = ClassroomIslandReveal.AnimationsEnabled();
    internal double? ReviewPhase { get; set; }
    internal IslandRibbonFrame? Frame => _frame;
    public event Action<string>? Attention;

    public ClassroomIslandRibbon() { Height = RibbonHeight; ClipToBounds = true; RenderOptions.SetTextRenderingMode(this,TextRenderingMode.Antialias); }

    public void Present(IslandRibbonFrame frame)
    {
        if (_disposed) return;
        if (_frame?.Key != frame.Key)
        {
            _previous = _frame; _started = Stopwatch.GetTimestamp();
            if (frame.Accent && _frame?.Key != frame.Key && Animate && IsEffectivelyVisible) Attention?.Invoke(Light && frame.Color == "#14FFFA" ? "#65B2ED" : frame.Color);
        }
        _frame = frame; _presentedAt=Stopwatch.GetTimestamp();
        AutomationProperties.SetName(this, frame.AccessibleText);
        ToolTip.SetTip(this, frame.AccessibleText + (frame.Shout is null ? " · 点击查看操作，Esc 收起" : " · 点击展开全文，Esc 收起喊话"));
        InvalidateVisual(); QueueFrame();
    }

    private double Phase => ReviewPhase ?? (!Animate || _previous is null ? 1 : Math.Clamp(Stopwatch.GetElapsedTime(_started).TotalSeconds / .55, 0, 1));
    private void QueueFrame()
    {
        var liveProgress=Animate && IsEffectivelyVisible && _frame is {Accent:false,Progress:>0,ProgressPerSecond:>0};
        if (_queued || _disposed || ReviewPhase.HasValue || Phase >= 1 && !liveProgress || TopLevel.GetTopLevel(this) is not { } top) return;
        _queued = true;
        top.RequestAnimationFrame(_ => { _queued = false; if (_disposed) return; InvalidateVisual(); QueueFrame(); });
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        if (_frame is null || Bounds.Width <= 0) return;
        var phase = Phase;
        var targetWidth=FrameWidth(_frame,Bounds.Width);
        var width=_previous is null ? targetWidth : FrameWidth(_previous,Bounds.Width)+(targetWidth-FrameWidth(_previous,Bounds.Width))*Ease(phase);
        var area = new Rect((Bounds.Width-width)/2, 0, width, RibbonHeight);
        using var offset=context.PushTransform(Matrix.CreateTranslation(area.X,0));
        area=new Rect(0,0,width,RibbonHeight);
        if (phase >= 1 || _previous is null) { Paint(context, _frame, area); return; }
        if (_frame.Accent || _previous.Accent)
        {
            // Reveal the destination through diagonal bands. The same mask runs
            // for arrival and departure, matching the reference's continuity.
            using (context.PushClip(new RoundedRect(area, 24)))
            {
                using (context.PushGeometryClip(Bands(area.Width, area.Height, Ease(phase), true))) Paint(context, _previous, area);
                using (context.PushGeometryClip(Bands(area.Width, area.Height, Ease(phase)))) Paint(context, _frame, area);
            }
        }
        else
        {
            var p = Ease(Math.Min(1, phase * .55 / .2));
            using (context.PushOpacity(1 - p))
            using (context.PushTransform(Matrix.CreateTranslation(0, 16 * p))) Paint(context, _previous, area);
            using (context.PushOpacity(p))
            using (context.PushTransform(Matrix.CreateTranslation(0, -16 * (1 - p)))) Paint(context, _frame, area);
        }
    }

    private void Paint(DrawingContext context, IslandRibbonFrame frame, Rect area)
    {
        var compact = Bounds.Width < 480;
        var bg = Light ? "#FCFDFF" : "#10141D";
        var ink = Light ? "#29486D" : "#F3F5F8";
        var muted = Light ? "#455D7B" : "#B2C1D5";
        var standardLight = Light && frame.Color == "#14FFFA";
        var accent = Brush(standardLight ? "#65B2ED" : frame.Color);
        var progressHeight = Light ? 2 : 3;
        if (frame.Shout is not null) { PaintShout(context, frame, area); return; }
        if (frame.Text.Length > 0)
        {
            using (context.PushClip(new RoundedRect(area, 24)))
            {
                context.DrawRectangle(frame.Accent ? Brush(standardLight ? "#DDF0FF" : frame.Color) : Brush(bg), null, area, 24, 24);
                if (frame.Accent)
                {
                    var titleArea = area.Deflate(new Thickness(52,0));
                    var cueInk = standardLight ? "#1C517F" : "#052A32";
                    var title = GetText(frame.Text,titleArea,20,cueInk);
                    var left=(area.Width-title.Width)/2;
                    Label(context, frame.Text, titleArea, 20, cueInk);
                    Icon(context,"info",left-31,13,cueInk);
                    if(frame.Text is "即将上课" or "上课" or "下课") Icon(context,"book-open",left+title.Width+9,13,cueInk);
                }
                else if (frame.Detail.Length > 0)
                {
                    var size=compact?14:20;
                    var emphasis=compact?18:22;
                    var primary=PrimaryRuns(frame.Text,size,emphasis);
                    var secondary=DetailRuns(frame.Detail,size,emphasis,compact?12:16);
                    var content=area.Deflate(new Thickness(compact?12:16,0));
                    var spacing=compact?8:16;
                    var first=compact?Math.Min(content.Width*.5,RunWidth(primary,ink)):Math.Max(1,(content.Width-spacing)/2);
                    RichLabel(context,primary,new Rect(content.X,0,first,area.Height),size,ink);
                    RichLabel(context,secondary,new Rect(content.X+first+spacing,0,Math.Max(1,content.Width-first-spacing),area.Height),size,ink);
                }
                else Label(context, frame.Text, area.Deflate(new Thickness(16, 0)), compact?14:20, ink);
                if (!frame.Accent)
                {
                    context.DrawRectangle(Brush(Light ? "#CFDFEE" : "#717782"), null, new Rect(0, area.Height - progressHeight, area.Width, progressHeight));
                    var progress=frame.Progress;
                    if(ReferenceEquals(frame,_frame) && Animate && !ReviewPhase.HasValue)
                        progress-=Stopwatch.GetElapsedTime(_presentedAt).TotalSeconds*frame.ProgressPerSecond;
                    context.DrawRectangle(accent, null, new Rect(0, area.Height - progressHeight, area.Width * Math.Clamp(progress, 0, 1), progressHeight));
                }
            }
            return;
        }
        var layout = Layout(frame,area.Width);
        var dateWidth = layout.DateWidth;
        var gap = layout.Gap;
        var border = Light ? new Pen(Brush("#DCE6F0"),1) : null;
        context.DrawRectangle(Brush(bg), border, new Rect(.5, .5, dateWidth-1, area.Height-1), 23.5, 23.5);
        var dateParts=frame.Date.Split(' ',2);
        if(dateParts.Length==2)
        {
            var weekdaySize=compact?14:16;
            var calendarSize=compact?16:18;
            var dateGap=compact?5:6;
            var weekday=GetText(dateParts[0],area,weekdaySize,ink);
            var calendar=GetText(dateParts[1],area,calendarSize,ink);
            var dateX=(dateWidth-weekday.Width-calendar.Width-dateGap)/2;
            Label(context,dateParts[0],new Rect(dateX,0,weekday.Width,area.Height),weekdaySize,muted);
            Label(context,dateParts[1],new Rect(dateX+weekday.Width+dateGap,0,calendar.Width,area.Height),calendarSize,ink);
        }
        else Label(context, frame.Date, new Rect(0, 0, dateWidth, area.Height), compact ? 14 : 16, ink);
        var courses = new Rect(dateWidth + gap, 0, Math.Max(1, area.Width - dateWidth - gap), area.Height);
        using (context.PushClip(new RoundedRect(courses, 24)))
        {
            context.DrawRectangle(Brush(bg), border, courses.Deflate(.5), 23.5, 23.5);
            var visible = layout.Items;
            var x = courses.X + Math.Max(0, (courses.Width - layout.Used) / 2);
            var itemGap=layout.ItemGap;
            foreach (var item in visible)
            {
                if(item!=visible[0]) x+=itemGap;
                if(item!=visible[0] && item.SeparatorBefore)
                {
                    context.DrawLine(new Pen(Brush(Light?"#CFDFEE":"#737D8A"),1),new Point(x+layout.SeparatorWidth/2,15),new Point(x+layout.SeparatorWidth/2,33)); x+=layout.SeparatorWidth+itemGap;
                }
                var width = item.Current ? layout.ActiveWidth : layout.CellWidth;
                var rect = new Rect(x, 0, width, area.Height);
                if (item.Current)
                {
                    context.DrawRectangle(Brush(Light ? "#EAF4FF" : "#242B38"), null, new Rect(x,layout.Stacked?3:6,width,layout.Stacked?42:36),14,14);
                    var size=layout.Stacked?18:compact?18:20;
                    var timeSize=layout.Stacked?12:compact?13:14;
                    if(layout.Stacked)
                    {
                        Label(context,item.Subject,new Rect(x+6,4,width-12,24),size,Light?"#244C70":ink);
                        Label(context,item.Time,new Rect(x+4,28,width-8,14),timeSize,Light?"#455D7B":ink);
                    }
                    else
                    {
                        var textGap=compact?8:10;
                        var horizontalPadding=compact?24:36;
                        var time=GetText(item.Time,rect,timeSize,ink);
                        var subject=GetText(item.Subject,new Rect(0,0,Math.Max(1,width-time.Width-textGap-horizontalPadding),area.Height),size,ink);
                        var subjectArea=new Rect(x+(width-subject.Width-time.Width-textGap)/2,0,subject.Width,area.Height);
                        Label(context,item.Subject,subjectArea,size,Light?"#244C70":ink);
                        Label(context,item.Time,new Rect(subjectArea.Right+textGap,0,time.Width,area.Height),timeSize,Light?"#455D7B":ink);
                    }
                    var track=new Rect(x+12,(layout.Stacked?45:42)-progressHeight,Math.Max(1,width-24),progressHeight);
                    // Rounded fills stay inside the track without a nested clip,
                    // preserving the transform for the lessons drawn after it.
                    context.DrawRectangle(Brush(Light ? "#CFDFEE" : "#737D8A"), null, track, 2, 2);
                    context.DrawRectangle(accent, null, track.WithWidth(track.Width*Math.Clamp(item.Progress,0,1)), 2, 2);
                }
                else Label(context, IslandRibbonPresentation.ShortSubject(item.Subject), rect, layout.SubjectSize, item.Past ? muted : ink);
                x += width;
            }
        }
    }

    private void PaintShout(DrawingContext context, IslandRibbonFrame frame, Rect area)
    {
        var shout = frame.Shout!;
        var ink = Light ? "#294D6D" : "#F1F6FC";
        var muted = Light ? "#455D7B" : "#C4D1E3";
        var accent = Light ? shout.Level switch { "urgent" => "#DD7D82", "warning" => "#D9AA4C", _ => "#65B2ED" } : frame.Color;
        var fill = Light ? shout.Level switch { "urgent" => "#FFF0F1", "warning" => "#FFF7E5", _ => "#EDF6FF" }
            : shout.Level switch { "urgent" => "#352025", "warning" => "#29261F", _ => "#172638" };
        var content = new Rect(20, 0, Math.Max(1, area.Width - 90), area.Height);
        using var clip = context.PushClip(new RoundedRect(area, 24));
        context.DrawRectangle(Brush(fill), Light ? new Pen(Brush("#D9E6F2"), 1) : null, area.Deflate(.5), 23.5, 23.5);
        if ((FullTextExpanded || shout.Level is "warning" or "urgent" && ImportantExpanded) && !frame.Accent)
        {
            LabelLeft(context, (shout.Level == "urgent" ? "紧急传话 · " : shout.Level == "warning" ? "重要传话 · " : "班班传话 · ") + shout.Sender,
                new Rect(20, 0, Math.Max(1, area.Width - 90), 48), 15,
                Light ? shout.Level == "urgent" ? "#A13F49" : shout.Level == "warning" ? "#79592E" : ink : ink);
            return;
        }
        if (frame.Accent)
        {
            var cue = "班班传话 · " + (shout.Level == "urgent" ? "紧急 · " : shout.Level == "warning" ? "重要 · " : "") + shout.Sender;
            Label(context, cue, content, Bounds.Width < 480 ? 16 : 18,
                Light ? ink : "#052A32");
            return;
        }
        var size = Bounds.Width < 480 ? 18 : 20;
        var width = Math.Max(1, (int)content.Width);
        if (_shoutText != shout.Text || _shoutWidth != width || _shoutPages.Count == 0)
        {
            _shoutText = shout.Text; _shoutWidth = width;
            _shoutPages = IslandShoutText.Pages(shout.Text, width,
                text => GetText(text, new Rect(0, 0, 10000, 48), size, ink).WidthIncludingTrailingWhitespace);
        }
        var age = shout.AgeSeconds;
        if (ReferenceEquals(frame, _frame) && Animate && !ReviewPhase.HasValue)
            age += Stopwatch.GetElapsedTime(_presentedAt).TotalSeconds;
        var messageAge = Math.Max(0, age - IslandShoutText.CueSecondsFor(shout.Level));
        var page = (int)(messageAge / IslandShoutText.PageSeconds) % _shoutPages.Count;
        var label = shout.Level switch { "urgent" => "紧急喊话", "warning" => "重要喊话", _ => "班级喊话" };
        if (shout.ContentType == "audio") label = "语音 · " + label;
        var pageLabel = _shoutPages.Count > 1 ? $"{page + 1}/{_shoutPages.Count} · 点击查看全文" : "点击查看全文";
        var pageWidth = Bounds.Width < 480 ? 106 : 130;
        LabelLeft(context, shout.Sender + " · " + label, new Rect(content.X, 3, Math.Max(1, content.Width - pageWidth - 8), 16), 12, muted);
        Label(context, pageLabel, new Rect(content.Right - pageWidth, 3, pageWidth, 16), 11, muted);
        var body = new Rect(content.X, 20, content.Width, 26);
        var p = !Animate || messageAge < IslandShoutText.PageSeconds ? 1 : Ease(Math.Clamp(messageAge % IslandShoutText.PageSeconds / .24, 0, 1));
        using (context.PushClip(body))
        {
            if (p < 1)
                using (context.PushOpacity(1 - p))
                using (context.PushTransform(Matrix.CreateTranslation(0, 10 * p)))
                    LabelLeft(context, _shoutPages[(page + _shoutPages.Count - 1) % _shoutPages.Count], body, size, ink);
            using (context.PushOpacity(p))
            using (context.PushTransform(Matrix.CreateTranslation(0, -10 * (1 - p))))
                LabelLeft(context, _shoutPages[page], body, size, ink);
        }
        var progress = frame.Progress - (ReferenceEquals(frame, _frame) && Animate && !ReviewPhase.HasValue ? Stopwatch.GetElapsedTime(_presentedAt).TotalSeconds * frame.ProgressPerSecond : 0);
        context.DrawRectangle(Brush(Light ? "#D6E5F2" : "#45586C"), null, new Rect(0, 46, area.Width, 2));
        context.DrawRectangle(Brush(accent), null, new Rect(0, 46, area.Width * Math.Clamp(progress, 0, 1), 2));
    }

    private void LabelLeft(DrawingContext context, string value, Rect area, double size, string color)
    {
        var text = GetText(value, area, size, color);
        context.DrawText(text, new Point(area.X, area.Y + (area.Height - text.Height) / 2));
    }

    private sealed record RibbonLayout(double Width, double DateWidth, double Gap, double ItemGap, double SeparatorWidth,
        double CellWidth, double ActiveWidth, double SubjectSize, bool Stacked, double Used, List<IslandRibbonItem> Items);

    private RibbonLayout Layout(IslandRibbonFrame frame,double maximum)
    {
        var compact=Bounds.Width<480;
        var date=compact?98:116;
        double cell=compact?26:30;
        var gap=compact?10:12;
        double itemGap=compact?4:6;
        double separator=compact?10:12;
        double padding=compact?20:24;
        double subjectSize=compact?16:18;
        var available=Math.Max(1,maximum-date-gap-padding);
        var item=frame.Items.FirstOrDefault(i=>i.Current);
        var rect=new Rect(0,0,10000,48);
        var activeWidth=item is null?cell:Math.Min(available,Math.Min(280,Math.Max(compact?148:164,
            GetText(item.Subject,rect,compact?18:20,"#F3F5F8").Width+
            GetText(item.Time,rect,compact?13:14,"#F3F5F8").Width+(compact?32:46))));
        // Keep every lesson in order. Space is reclaimed from abbreviated cells
        // and gaps, never by removing lessons before or after the current one.
        var visible=frame.Items.ToList();
        var inactive=visible.Count(i=>!i.Current);
        var gaps=Math.Max(0,visible.Count-1);
        var dividers=visible.Skip(1).Count(i=>i.SeparatorBefore);
        var stacked=false;
        double FreeCells()=>available-(item is null?0:activeWidth)-gaps*itemGap-dividers*(separator+itemGap);
        double Used()=>(item is null?0:activeWidth)+inactive*cell+gaps*itemGap+dividers*(separator+itemGap);
        void FitCells()=>cell=inactive==0?cell:Math.Clamp(FreeCells()/inactive,subjectSize+2,compact?26:30);
        if(Used()>available)
        {
            itemGap=2; separator=8; FitCells();
        }
        if(Used()>available && item is not null)
        {
            stacked=true;
            activeWidth=Math.Min(available,Math.Max(GetText(item.Subject,rect,18,"#F3F5F8").Width+16,
                GetText(item.Time,rect,12,"#F3F5F8").Width+16));
            FitCells();
        }
        if(Used()>available)
        {
            date=88; gap=6; padding=12; itemGap=1; separator=6; subjectSize=14;
            available=Math.Max(1,maximum-date-gap-padding);
            FitCells();
            if(Used()>available && inactive>0)
            {
                cell=Math.Max(1,FreeCells()/inactive);
                subjectSize=Math.Min(subjectSize,Math.Max(1,cell-2));
            }
        }
        return new(Math.Min(maximum,date+gap+padding+Used()),date,gap,itemGap,separator,cell,activeWidth,subjectSize,stacked,Used(),visible);
    }
    private double FrameWidth(IslandRibbonFrame frame,double maximum)
    {
        return frame.Text.Length>0 || frame.Items.Count==0 ? maximum : Layout(frame,maximum).Width;
    }

    private void Label(DrawingContext context, string value, Rect area, double size, string color)
    {
        if (area.Width <= 0) return;
        var text=GetText(value,area,size,color);
        context.DrawText(text, new Point(area.X + Math.Max(0, (area.Width - text.Width) / 2), area.Y + (area.Height - text.Height) / 2));
    }

    private static (string Text,double Size)[] PrimaryRuns(string text,double size,double emphasis)
    {
        const string prefix="距上课还有 ",suffix=" 秒";
        return text.StartsWith(prefix,StringComparison.Ordinal) && text.EndsWith(suffix,StringComparison.Ordinal)
            ? [(prefix,size),(text[prefix.Length..^suffix.Length],emphasis),(suffix,size)]
            : [(text,size)];
    }

    private static (string Text,double Size)[] DetailRuns(string text,double size,double emphasis,double timeSize)
    {
        const string prefix="下节课是：";
        var split=text.LastIndexOf(' ');
        return text.StartsWith(prefix,StringComparison.Ordinal) && split>prefix.Length
            ? [(prefix,size),(text[prefix.Length..split],emphasis),(text[split..],timeSize)]
            : [(text,size)];
    }

    private double RunWidth((string Text,double Size)[] runs,string color) =>
        runs.Sum(run=>GetText(run.Text,new Rect(0,0,10000,RibbonHeight),run.Size,color).WidthIncludingTrailingWhitespace);

    private void RichLabel(DrawingContext context,(string Text,double Size)[] runs,Rect area,double fallbackSize,string color)
    {
        if(area.Width<=0)return;
        var texts=runs.Select(run=>GetText(run.Text,new Rect(0,0,10000,RibbonHeight),run.Size,color)).ToArray();
        var width=texts.Sum(text=>text.WidthIncludingTrailingWhitespace);
        if(width>area.Width)
        {
            Label(context,string.Concat(runs.Select(run=>run.Text)),area,fallbackSize,color); return;
        }
        var x=area.X+(area.Width-width)/2;
        var baseline=area.Y+(area.Height-texts.Max(text=>text.Height))/2+texts.Max(text=>text.Baseline);
        foreach(var text in texts)
        {
            context.DrawText(text,new Point(x,baseline-text.Baseline));
            x+=text.WidthIncludingTrailingWhitespace;
        }
    }
    private FormattedText GetText(string value,Rect area,double size,string color)
    {
        var key = (value, size, color, (int)area.Width);
        if (!_text.TryGetValue(key, out var text))
        {
            if (_text.Count > 256) _text.Clear();
            text = new FormattedText(value, CultureInfo.GetCultureInfo("zh-CN"), FlowDirection.LeftToRight,
                new Typeface(ClassroomStyle.Font, FontStyle.Normal, FontWeight.Bold), size, Brush(color))
            { MaxTextWidth = area.Width, MaxLineCount = 1, Trimming = TextTrimming.CharacterEllipsis };
            _text[key] = text;
        }
        return text;
    }
    private void Icon(DrawingContext context,string name,double x,double y,string color)
    {
        if(!_icons.TryGetValue(name,out var icons))
        {
            using var stream=typeof(ClassroomStyle).Assembly.GetManifestResourceStream($"ICeClass.Classroom.Icons.{name}.svg")!;
            icons=XDocument.Load(stream).Root!.Elements().Select(shape=>shape.Name.LocalName switch {
                "path" => (Geometry)StreamGeometry.Parse(shape.Attribute("d")!.Value),
                "circle" => new EllipseGeometry(new Rect(Number(shape,"cx")-Number(shape,"r"),Number(shape,"cy")-Number(shape,"r"),Number(shape,"r")*2,Number(shape,"r")*2)),
                _ => null
            }).Where(g=>g is not null).Cast<Geometry>().ToArray();
            _icons[name]=icons;
        }
        using(context.PushTransform(Matrix.CreateScale(.9,.9)*Matrix.CreateTranslation(x,y)))
            foreach(var icon in icons) context.DrawGeometry(null,new Pen(Brush(color),2,lineCap:PenLineCap.Round,lineJoin:PenLineJoin.Round),icon);
        static double Number(XElement shape,string name)=>double.Parse(shape.Attribute(name)!.Value,CultureInfo.InvariantCulture);
    }

    private static double Ease(double p) => 1 - Math.Pow(1 - p, 3);
    private static IBrush Brush(string color) => new SolidColorBrush(Color.Parse(color));
    private static Geometry Bands(double width, double height, double progress, bool inverse = false)
    {
        var geometry = new StreamGeometry();
        using var path = geometry.Open();
        path.SetFillRule(FillRule.EvenOdd);
        if (inverse)
        {
            path.BeginFigure(new Point(0, 0), true); path.LineTo(new Point(width, 0));
            path.LineTo(new Point(width, height)); path.LineTo(new Point(0, height)); path.EndFigure(true);
        }
        var spacing = width / 5;
        for (var x = -spacing; x < width + spacing; x += spacing)
        {
            var extent = spacing * progress;
            path.BeginFigure(new Point(x, height), true);
            path.LineTo(new Point(x + height * .58, 0));
            path.LineTo(new Point(x + height * .58 + extent, 0));
            path.LineTo(new Point(x + extent, height)); path.EndFigure(true);
        }
        return geometry;
    }
    public void Dispose() { _disposed = true; _text.Clear(); _icons.Clear(); }
}

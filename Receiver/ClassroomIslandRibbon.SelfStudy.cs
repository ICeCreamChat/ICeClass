using System.Diagnostics;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

internal sealed partial class ClassroomIslandRibbon
{
    private readonly double[] _soundHistory = new double[43];
    private double _soundLevel;
    private long _selfStudyStarted;
    private SelfStudyFeedback? _selfStudy;
    private SelfStudyFeedback? _selfStudyPresentation;
    private Color _selfStudyFromColor;
    private double _selfStudyTransitionSeconds = 1.2;

    internal void SetSelfStudyFeedback(SelfStudyFeedback? feedback)
    {
        if (_selfStudy == feedback) return;
        var geometryChanged = (_selfStudy is null) != (feedback is null);
        _selfStudy = feedback;
        if (feedback?.Capturing != true) { Array.Clear(_soundHistory); _soundLevel = 0; }
        if (_frame is not null)
        {
            _frame = _frame with { SelfStudy = feedback is not null && _frame.SelfStudy?.Reminder == true ? feedback with { Reminder = true } : feedback };
            AutomationProperties.SetName(this, _frame.AccessibleText);
            ToolTip.SetTip(this, _frame.AccessibleText + " · 点击查看操作，Esc 收起");
        }
        UpdateSelfStudyPresentation(_frame?.SelfStudy ?? feedback);
        InvalidateVisual();
        if (geometryChanged) MaterialGeometryChanged?.Invoke();
        QueueFrame();
    }

    internal void SetSelfStudyLevel(double level)
    {
        if (_disposed || _selfStudy?.Capturing != true) return;
        level = double.IsFinite(level) ? Math.Clamp(level, 0, 1) : 0;
        _soundLevel += (level - _soundLevel) * (level > _soundLevel ? .72 : .36);
        Array.Copy(_soundHistory, 1, _soundHistory, 0, _soundHistory.Length - 1);
        _soundHistory[^1] = _soundLevel;
        // No Present(), text measurement, layout, glass geometry or network work here.
        InvalidateVisual();
    }

    private double SelfStudyElapsed => ReviewPhase is { } review ? Math.Clamp(review, 0, 1) * (_selfStudyPresentation?.ObservationSeconds ?? 10)
        : Stopwatch.GetElapsedTime(_selfStudyStarted).TotalSeconds;

    private bool SelfStudyAnimating => Animate && IsEffectivelyVisible && _frame is { Shout: null, Text.Length: 0, SelfStudy: { } feedback } &&
        (feedback.Phase == "analyzing" || feedback.Phase == "observing" && feedback.Attention != "reported" && SelfStudyElapsed < feedback.ObservationSeconds
            || SelfStudyElapsed < _selfStudyTransitionSeconds);

    private void UpdateSelfStudyPresentation(SelfStudyFeedback? feedback)
    {
        if (_selfStudyPresentation?.Phase != feedback?.Phase || _selfStudyPresentation?.Attention != feedback?.Attention ||
            _selfStudyPresentation?.ObservationSeconds != feedback?.ObservationSeconds)
        {
            // Capture the displayed blend, including an interrupted transition.
            _selfStudyFromColor = _selfStudyPresentation is { } previous
                ? SelfStudyPaintColor(previous, SelfStudyElapsed) : SelfStudyTargetColor(new("listening", "", true), 0, Light);
            _selfStudyTransitionSeconds = feedback?.Phase is "listening" or "teaching" ? 2.5 : 1.2;
            _selfStudyStarted = Stopwatch.GetTimestamp();
        }
        _selfStudyPresentation = feedback;
    }

    internal static Color SelfStudyTargetColor(SelfStudyFeedback feedback, double observingSeconds, bool light)
    {
        Color Parse(string bright, string dark) => Color.Parse(light ? bright : dark);
        var blue = Parse("#347BA8", "#8AC9EF");
        if (feedback.Phase is "paused" or "inactive" or "error") return Parse("#52697D", "#B9CADB");
        if (feedback.Attention == "reported") return Parse("#A73B43", "#EF8490");
        if (feedback.Attention == "warning")
        {
            var coral = Parse("#BE5651", "#F3A099");
            var progress = feedback.Phase == "observing" ? Math.Clamp(observingSeconds / Math.Max(1, feedback.ObservationSeconds), 0, 1)
                : feedback.Phase == "analyzing" ? 1 : 0;
            return BlendSelfStudyColor(coral, Parse("#A73B43", "#EF8490"), progress * .25);
        }
        var amber = Parse("#94651E", "#EAC486");
        return feedback.Phase switch
        {
            // This is time spent in actual observation, never a misconduct score.
            "observing" => BlendSelfStudyColor(blue, amber, Math.Clamp(observingSeconds / Math.Max(1, feedback.ObservationSeconds), 0, 1)),
            "analyzing" => amber,
            _ => blue
        };
    }

    internal static Color BlendSelfStudyColor(Color from, Color target, double progress)
    {
        var p = Math.Clamp(progress, 0, 1);
        return Color.FromRgb((byte)Math.Round(from.R + (target.R - from.R) * p),
            (byte)Math.Round(from.G + (target.G - from.G) * p), (byte)Math.Round(from.B + (target.B - from.B) * p));
    }

    internal Color SelfStudyPaintColor(SelfStudyFeedback feedback, double elapsed) =>
        BlendSelfStudyColor(_selfStudyFromColor, SelfStudyTargetColor(feedback, Animate ? elapsed : feedback.ObservationSeconds, Light),
            Animate ? Ease(Math.Clamp(elapsed / _selfStudyTransitionSeconds, 0, 1)) : 1);

    internal static (Rect Copy, Rect Wave, Rect Status) SelfStudyRegions(Rect area)
    {
        var padding = Math.Min(12, area.Width * .05);
        var content = area.Deflate(new Thickness(padding, 0));
        var statusWidth = area.Width >= 470 ? 118 : area.Width >= 180 ? 74 : Math.Min(24, content.Width * .18);
        var gap = Math.Min(12, content.Width * .04);
        var copyWidth = Math.Min(area.Width < 260 ? 72 : 124, Math.Min(Math.Max(Math.Min(88, content.Width * .55), content.Width * .36),
            Math.Max(0, content.Width - statusWidth - 2 * gap)));
        var status = new Rect(content.Right - statusWidth, 0, statusWidth, 48);
        return (new Rect(content.X, 0, copyWidth, 48),
            new Rect(content.X + copyWidth + gap, 5, Math.Max(0, status.X - gap - content.X - copyWidth - gap), 38), status);
    }

    private void PaintSelfStudy(DrawingContext context, IslandRibbonItem item, SelfStudyFeedback feedback, Rect area)
    {
        var phase = feedback.Phase;
        var (copy, wave, status) = SelfStudyRegions(area);
        var elapsed = SelfStudyElapsed;
        var color = SelfStudyPaintColor(feedback, elapsed);
        var accent = new SolidColorBrush(color);
        var ink = Light ? "#25445C" : "#EDF6FF";
        var muted = Light ? "#4E6579" : "#B8CADB";
        if (!Glass)
            context.DrawRectangle(new SolidColorBrush(color, .055), null, area.Deflate(new Thickness(0, 3)), 21, 21);
        using (context.PushClip(copy))
        {
            LabelLeft(context, item.Subject, new Rect(copy.X, 3, copy.Width, 24), area.Width < 260 ? 14 : 15, ink);
            LabelLeft(context, item.Time, new Rect(copy.X, 27, copy.Width, 15), 11, muted);
        }
        if (wave.Width >= 4)
        {
            var count = Math.Clamp((int)(wave.Width / 7), 3, _soundHistory.Length);
            var step = wave.Width / count;
            for (var i = 0; i < count; i++)
            {
                var index = _soundHistory.Length-count+i;
                var level = feedback.Capturing ? Animate ? _soundHistory[index] : _soundLevel : 0;
                var height = 2 + Math.Clamp(level, 0, 1) * 30;
                context.DrawRectangle(accent, null, new Rect(wave.X+i*step+(step-Math.Min(4,step*.6))/2,24-height/2,Math.Min(4,step*.6),height),2,2);
            }
        }
        var icon = phase switch
        {
            "analyzing" => "loader-circle", "teaching" => "book-open", "warning" => "bell",
            "reported" => "check", "budget" or "ai_paused" => "circle-pause",
            "paused" or "inactive" or "error" => "mic-off", _ => "mic"
        };
        var center = new Point(status.X+12,24);
        context.DrawEllipse(new SolidColorBrush(color,.10),null,center,13,13);
        if (Animate && phase == "observing" && elapsed < .8)
            context.DrawEllipse(null,new Pen(new SolidColorBrush(color,(1-elapsed/.8)*.35),1),center,13+elapsed*9,13+elapsed*9);
        var angle = !Animate ? 0 : phase == "analyzing" ? elapsed*Math.PI*1.25 : phase == "warning" && elapsed<.7 ? Math.Sin(elapsed*24)*.16*(1-elapsed/.7) : 0;
        var confirmation = Animate && phase == "reported" ? Ease(Math.Clamp(elapsed / .45, 0, 1)) : 1;
        var scale = .85 + .15 * confirmation;
        using (context.PushOpacity(.4 + .6 * confirmation))
        using (context.PushTransform(Matrix.CreateTranslation(-center.X,-center.Y)*Matrix.CreateScale(scale,scale)*Matrix.CreateRotation(angle)*Matrix.CreateTranslation(center.X,center.Y+3*(1-confirmation))))
            Icon(context,icon,status.X+1,13,color.ToString());
        if (status.Width > 30) LabelLeft(context,status.Width < 118 ? feedback.ShortLabel : feedback.Label,
            new Rect(status.X+32,0,status.Width-32,48),11,muted);
    }
}

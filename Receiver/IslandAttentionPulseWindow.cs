using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// A separate, non-activating, click-through surface lets the short attention wave
// extend onto the desktop without expanding the ribbon's input or layout bounds.
internal sealed class IslandAttentionPulseWindow : Window, IDisposable
{
    private readonly IslandAttentionPulse _pulse = new();
    private int _generation;
    public IslandAttentionPulseWindow()
    {
        SystemDecorations = SystemDecorations.None; Background = Brushes.Transparent;
        TransparencyLevelHint = [WindowTransparencyLevel.Transparent];
        ShowInTaskbar = false; ShowActivated = false; Topmost = true; CanResize = false;
        IsHitTestVisible = false; Focusable = false; Content = _pulse;
        Opened += (_, _) => IslandPlatform.SetClickThrough(this, true);
    }
    public void Play(Window owner, string color)
    {
        if (!owner.IsVisible || !ClassroomIslandReveal.AnimationsEnabled()) return;
        var screen = owner.Screens.ScreenFromWindow(owner) ?? owner.Screens.Primary;
        if (screen is null) return;
        var work = screen.WorkingArea; var scale = screen.Scaling;
        Width = work.Width / scale; Height = work.Height / scale; Position = work.Position;
        _pulse.Center = new Point((owner.Position.X - work.X) / scale + owner.Bounds.Width / 2,
            (owner.Position.Y - work.Y) / scale + ClassroomIslandRibbon.RibbonHeight / 2);
        _pulse.Color = color; _pulse.Progress = 0;
        Show(); IslandPlatform.SetClickThrough(this, true);
        var generation = ++_generation; var start = Stopwatch.GetTimestamp();
        void Frame(TimeSpan _)
        {
            if (generation != _generation || !IsVisible) return;
            _pulse.Progress = Math.Clamp(Stopwatch.GetElapsedTime(start).TotalSeconds / .7, 0, 1);
            _pulse.InvalidateVisual();
            if (_pulse.Progress < 1) RequestAnimationFrame(Frame); else Hide();
        }
        RequestAnimationFrame(Frame);
    }
    public void Stop() { _generation++; Hide(); }
    public void Dispose() { _generation++; Close(); }
}

internal sealed class IslandAttentionPulse : Control
{
    public double Progress { get; set; }
    public Point Center { get; set; }
    public string Color { get; set; } = "#14FFFA";
    public override void Render(DrawingContext context)
    {
        if (Progress <= 0 || Progress >= 1) return;
        var radius = Math.Sqrt(Bounds.Width * Bounds.Width + Bounds.Height * Bounds.Height) * Math.Pow(Progress, 1.4);
        using (context.PushOpacity(.23 * Math.Sqrt(1 - Progress)))
            context.DrawEllipse(new SolidColorBrush(Avalonia.Media.Color.Parse(Color)), null, Center, radius, radius);
    }
}

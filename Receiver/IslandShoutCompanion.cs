using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// Banban shares the ribbon's row. Reserving space at the side leaves the normal
// timetable untouched and keeps the message inside the original island surface.
internal sealed class IslandShoutCompanion : Panel, IDisposable
{
    internal const double SideWidth = 64;
    internal const double MascotHeight = 66;
    internal const double ExpansionWidth = 128;
    private readonly Control _surface;
    private readonly IslandBanbanMascot _mascot;
    private readonly IslandSpring _presence = new();
    private readonly IslandSpring _width = new();
    private readonly TranslateTransform _arrival = new();
    private long _started, _lastFrame;
    private bool _active, _animate, _queued, _disposed;
    internal double? ReviewSeconds { get; set; }
    internal bool PullEnabled { get; set; } = true;
    internal double Expansion => ExpansionWidth * Math.Clamp(_width.Value, 0, 1);
    internal event Action? GeometryChanged;

    public IslandShoutCompanion(Control surface, IslandBanbanMascot mascot)
    {
        _surface = surface; _mascot = mascot;
        _mascot.IsVisible = false; _mascot.Opacity = 0;
        _mascot.RenderTransform = _arrival;
        Children.Add(surface); Children.Add(mascot);
    }

    public void SetActive(bool active, bool animate, bool restart = false)
    {
        if (_disposed) return;
        Advance();
        if (active && (!_active || restart))
        {
            _started = Stopwatch.GetTimestamp();
            // Replaying or replacing a pulling shout must start from the
            // short island again, rather than inheriting the previous width.
            if (PullEnabled) _width.Snap(0);
        }
        _active = active; _animate = animate;
        _presence.Retarget(active ? 1 : 0);
        if (!animate) { _presence.Snap(_presence.Target); _width.Snap(active && PullEnabled ? 1 : 0); }
        if (active) _mascot.IsVisible = true;
        _lastFrame = Stopwatch.GetTimestamp();
        Apply(); QueueFrame();
    }

    public void ResumeAnimation() { _lastFrame = Stopwatch.GetTimestamp(); _queued = false; QueueFrame(); }

    private double Seconds => ReviewSeconds ?? Stopwatch.GetElapsedTime(_started).TotalSeconds;
    private double Presence => Math.Clamp(_presence.Value, 0, 1);
    private double Pull => _active && _animate && PullEnabled ? IslandBanbanMascot.PullAt(Seconds) * Presence : 0;
    private void Advance()
    {
        var now = Stopwatch.GetTimestamp();
        if (_lastFrame != 0)
        {
            var elapsed = Stopwatch.GetElapsedTime(_lastFrame, now).TotalSeconds;
            _presence.Advance(elapsed); _width.Advance(elapsed);
        }
        _lastFrame = now;
    }

    private void Apply()
    {
        // Follow the hand throughout the pull instead of immediately springing
        // to the final width as soon as Banban grabs the edge.
        _width.Retarget(_active && PullEnabled ? _animate ? IslandBanbanMascot.ExpansionAt(Seconds) : 1 : 0);
        _mascot.Opacity = Presence; _arrival.X = -8 * (1 - Presence);
        if (!_active && _presence.IsAtRest(.001, .015)) { _presence.Snap(0); _mascot.IsVisible = false; }
        InvalidateMeasure(); GeometryChanged?.Invoke();
    }

    private void QueueFrame()
    {
        if (_queued || _disposed || ReviewSeconds.HasValue ||
            _presence.IsAtRest(.001, .015) && _width.IsAtRest(.001, .015) && (!_active || !_animate || Seconds >= IslandBanbanMascot.PullEndSeconds + .4) ||
            TopLevel.GetTopLevel(this) is not { IsVisible: true } top) return;
        _queued = true;
        top.RequestAnimationFrame(_ =>
        {
            _queued = false; if (_disposed) return;
            Advance(); Apply(); QueueFrame();
        });
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        _mascot.Measure(new Size(SideWidth, MascotHeight));
        _surface.Measure(new Size(Math.Max(1, availableSize.Width - SideWidth * Presence), double.PositiveInfinity));
        return new Size(_surface.DesiredSize.Width + SideWidth * Presence,
            Math.Max(_surface.DesiredSize.Height + 8 * Presence, MascotHeight * Presence));
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var side = SideWidth * Presence;
        // The hand and the capsule use the same pull curve. Six DIP of give at
        // each end makes the tug legible without disturbing text or hit targets.
        _surface.Arrange(new Rect(side - 6 * Pull, 8 * Presence,
            Math.Max(1, finalSize.Width - side + 12 * Pull), _surface.DesiredSize.Height));
        _mascot.Arrange(new Rect(0, 0, SideWidth, MascotHeight));
        return finalSize;
    }

    public void Dispose() { _disposed = true; }
}

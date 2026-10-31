using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Threading;

namespace ICeClass.Receiver;

// Measure the full panel once per content change. Only its clipped viewport changes
// height, so text and controls keep their final layout throughout the transition.
internal sealed class ClassroomIslandReveal : Decorator, IDisposable
{
    private readonly Control _content;
    private readonly TranslateTransform _offset = new(0, -6);
    private readonly IslandSpring _height = new();
    private readonly IslandSpring _presence = new();
    private double _naturalHeight;
    private long _lastFrame;
    private bool _expanded, _animated, _queued, _disposed, _running, _framePending;

    public ClassroomIslandReveal(Control content)
    {
        Child = _content = content; Height = 0; ClipToBounds = true;
        _content.RenderTransform = _offset; _content.Opacity = 0;
        _content.IsVisible = _content.IsEnabled = false;
    }

    public void SetExpanded(bool expanded, bool animate)
    {
        if (_disposed) return;
        AdvanceToNow();
        _animated = animate;
        _expanded = expanded;
        _content.IsEnabled = expanded;
        if (expanded)
        {
            _content.IsVisible = true;
            // The window has a fixed width; measure before starting to avoid an
            // empty first frame, including when an interrupted close reverses.
            Measure(new Size(Math.Max(1, Bounds.Width), double.PositiveInfinity));
        }
        Retarget();
    }

    private void AdvanceToNow()
    {
        if (!_running) return;
        var now = Stopwatch.GetTimestamp();
        var seconds = Stopwatch.GetElapsedTime(_lastFrame, now).TotalSeconds;
        _lastFrame = now;
        _height.Advance(seconds); _presence.Advance(seconds);
    }

    private void ApplyPresentation()
    {
        Height = Math.Max(0, _height.Value);
        var presence = Math.Clamp(_presence.Value, 0, 1);
        _content.Opacity = presence; _offset.Y = -6 * (1 - presence);
        if (!_running && !_expanded) _content.IsVisible = false;
    }

    private void QueueFrame()
    {
        if (_framePending || !_running || _disposed) return;
        if (TopLevel.GetTopLevel(this) is not { } topLevel) { Finish(); return; }
        _framePending = true;
        topLevel.RequestAnimationFrame(_ =>
        {
            _framePending = false;
            if (!_running || _disposed) return;
            AdvanceToNow();
            // Stop below half a physical pixel and negligible per-frame speed.
            var tolerance = .5 / topLevel.RenderScaling;
            if (_height.IsAtRest(tolerance, tolerance * 12) && _presence.IsAtRest(.002, .025)) Finish();
            else { ApplyPresentation(); QueueFrame(); }
        });
    }

    private void Finish()
    {
        _running = false; _height.Snap(_height.Target); _presence.Snap(_presence.Target);
        ApplyPresentation();
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        _content.Measure(new Size(availableSize.Width, double.PositiveInfinity));
        var natural = _content.DesiredSize;
        if (Math.Abs(natural.Height - _naturalHeight) > .25)
        {
            _naturalHeight = natural.Height;
            if (!_queued && !_disposed)
            {
                _queued = true;
                Dispatcher.UIThread.Post(() => { _queued = false; if (!_disposed) Retarget(); }, DispatcherPriority.Loaded);
            }
        }
        return natural;
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        _content.Arrange(new Rect(0, 0, finalSize.Width, _content.DesiredSize.Height));
        return finalSize;
    }

    private void Retarget()
    {
        var target = _expanded ? _naturalHeight : 0;
        var presence = _expanded ? 1 : 0;
        if (!_animated)
        {
            _height.Retarget(target); _presence.Retarget(presence); Finish(); return;
        }
        if (Math.Abs(_height.Target - target) <= .25 && _presence.Target == presence) return;
        // Change the destination without discarding the current velocity.
        AdvanceToNow(); _height.Retarget(target); _presence.Retarget(presence);
        _lastFrame = Stopwatch.GetTimestamp(); _running = true;
        QueueFrame();
    }

    public void Dispose()
    {
        _running = false; _disposed = true;
    }

    internal static bool AnimationsEnabled() => DesktopStyle.AnimationsEnabled();
}

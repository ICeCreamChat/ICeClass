using System.Diagnostics;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace ICeClass.Receiver;

/// <summary>A short history of the existing microphone level, with no audio capture of its own.</summary>
internal sealed class BanbanListeningWaveform : Control, IDisposable
{
    private const int SampleCount = 15;
    private const double DotSize = 3, Pitch = 5, BarHeight = 18, StaleSeconds = .3;
    private readonly double[] _samples = new double[SampleCount];
    private readonly IBrush _ink = DesktopStyle.Muted;
    private readonly DispatcherTimer _frames;
    private double _level, _displayLevel;
    private long _lastLevel, _lastFrame;
    private bool _listening, _animate, _disposed;

    internal BanbanListeningWaveform()
    {
        Width = (SampleCount - 1) * Pitch + DotSize; Height = 19.5;
        HorizontalAlignment = HorizontalAlignment.Center; VerticalAlignment = VerticalAlignment.Center;
        IsVisible = false; IsHitTestVisible = false; Focusable = false;
        AutomationProperties.SetAccessibilityView(this, AccessibilityView.Raw);
        _frames = new DispatcherTimer();
        _frames.Tick += (_, _) => Advance();
    }

    internal void SetListening(bool listening, bool animate)
    {
        if (_disposed || _listening == listening && _animate == animate) return;
        _listening = listening; _animate = animate;
        Reset();
    }

    internal void Present(int level)
    {
        if (_disposed || !_listening || !IsEffectivelyVisible) return;
        var now = Stopwatch.GetTimestamp();
        if (_lastLevel != 0 && Stopwatch.GetElapsedTime(_lastLevel, now).TotalSeconds >= StaleSeconds) Reset();
        _lastLevel = now; _level = Math.Clamp(level, 0, 100) / 100d;
        if (!_animate)
        {
            // Reduced motion keeps real input snapshots, with only a one-shot silence timeout.
            if (_level == 0) { Reset(); return; }
            Push(_level);
            _frames.Stop(); _frames.Interval = TimeSpan.FromSeconds(StaleSeconds); _frames.Start();
            return;
        }
        if (_frames.IsEnabled || _level == 0) return;
        _displayLevel = _level; _lastFrame = now; Push(_displayLevel);
        _frames.Interval = TimeSpan.FromMilliseconds(1000d / 30); _frames.Start();
    }

    private void Advance()
    {
        var now = Stopwatch.GetTimestamp();
        if (_disposed || !_listening || !IsEffectivelyVisible || !_animate
            || Stopwatch.GetElapsedTime(_lastLevel, now).TotalSeconds >= StaleSeconds)
        { Reset(); return; }
        var seconds = Math.Min(.1, Stopwatch.GetElapsedTime(_lastFrame, now).TotalSeconds);
        _lastFrame = now;
        _displayLevel += (_level - _displayLevel) * (1 - Math.Exp(-seconds / (_level > _displayLevel ? .04 : .08)));
        // Repeat only the latest measured level between microphone events; silence fades the entire history.
        if (_level == 0)
        {
            var release = Math.Exp(-seconds / .055);
            for (var i = 0; i < _samples.Length; i++) _samples[i] *= release;
        }
        Push(_displayLevel);
        if (_level == 0 && _samples.All(sample => sample < .012)) Reset();
    }

    private void Push(double level)
    {
        Array.Copy(_samples, 1, _samples, 0, _samples.Length - 1);
        _samples[^1] = level;
        InvalidateVisual();
    }

    private void Reset()
    {
        _frames.Stop(); _lastLevel = _lastFrame = 0; _level = _displayLevel = 0;
        if (_samples.All(sample => sample == 0)) return;
        Array.Clear(_samples);
        InvalidateVisual();
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        var left = (Bounds.Width - Width) / 2;
        for (var i = 0; i < _samples.Length; i++)
        {
            var height = DotSize + (BarHeight - DotSize) * _samples[i];
            context.DrawRectangle(_ink, null, new Rect(left + i * Pitch, (Bounds.Height - height) / 2, DotSize, height), DotSize / 2, DotSize / 2);
        }
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        Reset();
        base.OnDetachedFromVisualTree(e);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true; _listening = false; Reset();
    }
}

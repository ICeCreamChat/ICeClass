using System.Runtime.InteropServices;
using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Rendering.SceneGraph;
using Avalonia.Skia;
using Avalonia.Threading;
using Avalonia.VisualTree;
using SkiaSharp;

namespace ICeClass.Receiver;

internal sealed class IslandGlassLens : Control, IDisposable
{
    private readonly DispatcherTimer _timer = new(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(40) };
    private Window? _owner;
    private IntPtr _blur;
    private Rect[] _regions = [];
    private IslandGlassCapture.Source _candidate;
    private IslandGlassCapture? _capture;
    private SKBitmap? _pixels;
    private Optics? _optics;
    private Frame? _frame;
    private long _changedAt;
    private ulong _version;
    private int _samples;
    private double _cost;
    private bool _blocked;
    private volatile bool _renderFailed;
    private double _drawMilliseconds;
    internal double CaptureMilliseconds { get; private set; }
    internal bool IsActive => _frame is not null;

    internal IslandGlassLens() { IsHitTestVisible = false; _timer.Tick += Poll; }

    internal void Follow(Window owner, Rect[] regions, IntPtr blur)
    {
        if (_blocked) return;
        _owner = owner; _blur = blur;
        if (!_regions.SequenceEqual(regions)) { ResetCapture(); _regions = regions; _candidate = default; }
        _timer.Start();
    }

    internal void Stop()
    {
        _timer.Stop(); _candidate = default;
        ResetCapture();
    }

    private void ResetCapture()
    {
        var capture = _capture; _capture = null;
        // Closing WGC waits for its worker. Keep that wait off the input thread.
        if (capture is not null) _ = Task.Run(capture.Dispose);
        _pixels?.Dispose(); _pixels = null;
        _frame?.Release(); _frame = null;
        _optics?.Release(); _optics = null;
        _version = 0; _samples = 0; _cost = 0;
        InvalidateVisual();
    }

    private void Poll(object? sender, EventArgs args)
    {
        if (_owner is not { IsVisible: true } owner || !IsEffectivelyVisible || _regions.Length == 0)
        { Stop(); return; }
        if (_renderFailed) { Disable("glass renderer unavailable"); return; }
        var offset = this.TranslatePoint(default, owner);
        if (offset is null || Bounds.Width < 1 || Bounds.Height < 1) return;
        var top = owner.PointToScreen(offset.Value);
        var bottom = owner.PointToScreen(offset.Value + new Vector(Bounds.Width, Bounds.Height));
        var area = new PixelRect(top, bottom);
        var wanted = (long)area.Width * area.Height <= 1_500_000
            ? IslandGlassCapture.FindSource(owner, area, _blur) : default;
        if (wanted != _candidate)
        {
            ResetCapture(); _candidate = wanted; _changedAt = Stopwatch.GetTimestamp(); return;
        }
        // During the pull/reveal animation the lightweight glass keeps moving.
        // Start sampling only once the geometry and source have settled.
        if (wanted.Window == IntPtr.Zero || Stopwatch.GetElapsedTime(_changedAt).TotalMilliseconds < 120) return;
        try
        {
            if (_capture is null)
            {
                _capture = IslandGlassCapture.Create();
                if (_capture.IsInvalid) { Disable("background capture unavailable"); return; }
                _capture.Update(wanted);
                _pixels = new SKBitmap(new SKImageInfo(area.Width, area.Height, SKColorType.Bgra8888, SKAlphaType.Premul));
                _optics = new Optics(_regions, owner.RenderScaling);
            }
            var start = Stopwatch.GetTimestamp();
            var result = _capture.Read(_pixels!, _version, out var version, out var nativeCost);
            CaptureMilliseconds = nativeCost;
            if (result < 0) { Disable("background capture stopped"); return; }
            if (result == 0) return;
            _version = version;
            var image = SKImage.FromPixelCopy(_pixels!.Info, _pixels.GetPixels(), _pixels.RowBytes);
            var previous = _frame; _frame = new Frame(image, _optics!); previous?.Release();
            InvalidateVisual();
            var cost = nativeCost + Stopwatch.GetElapsedTime(start).TotalMilliseconds + Volatile.Read(ref _drawMilliseconds);
            if (++_samples > 8) _cost = _cost == 0 ? cost : _cost * .95 + cost * .05;
            // At 25fps, 5ms/frame is already 12.5% of one CPU core. Stop the
            // extra sampling rather than spending that much on decoration.
            if (_samples > 100 && _cost > 5) Disable("glass frame cost exceeded 5ms");
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or InvalidOperationException)
        { Disable(error.GetType().Name); }
    }

    private void Disable(string reason) { _blocked = true; Stop(); AppLog.Info("Island keeps lightweight glass: " + reason); }
    public void Dispose() { Stop(); _timer.Tick -= Poll; _owner = null; }

    public override void Render(DrawingContext context)
    {
        if (_frame is { } frame) context.Custom(new LensDraw(this, frame, new Rect(Bounds.Size)));
    }

    private sealed class Optics
    {
        private int _references = 1;
        internal readonly Rect[] Regions;
        internal readonly double Scale;
        internal readonly SKImageFilter[] Filters;
        internal Optics(Rect[] regions, double scale)
        { Regions = regions; Scale = scale; Filters = regions.Select(r => LiquidGlassOptics.CreateFilter(r, scale)).ToArray(); }
        internal void Retain() => Interlocked.Increment(ref _references);
        internal void Release() { if (Interlocked.Decrement(ref _references) == 0) foreach (var filter in Filters) filter.Dispose(); }
    }

    private sealed class Frame(SKImage image, Optics optics)
    {
        private int _references = 1;
        internal readonly SKImage Image = image;
        internal readonly Optics Optics = Keep(optics);
        private static Optics Keep(Optics value) { value.Retain(); return value; }
        internal void Retain() => Interlocked.Increment(ref _references);
        internal void Release() { if (Interlocked.Decrement(ref _references) == 0) { Image.Dispose(); Optics.Release(); } }
    }

    private sealed class LensDraw : ICustomDrawOperation
    {
        private readonly IslandGlassLens _owner;
        private Frame? _frame;
        public Rect Bounds { get; }
        internal LensDraw(IslandGlassLens owner, Frame frame, Rect bounds)
        { _owner = owner; _frame = frame; frame.Retain(); Bounds = bounds; }
        public bool HitTest(Point point) => false;
        public bool Equals(ICustomDrawOperation? other) => false;
        public void Dispose() => Interlocked.Exchange(ref _frame, null)?.Release();
        public void Render(ImmediateDrawingContext context)
        {
            if (_frame is not { } frame) return;
            var feature = context.TryGetFeature(typeof(ISkiaSharpApiLeaseFeature)) as ISkiaSharpApiLeaseFeature;
            if (feature is null) { _owner._renderFailed = true; return; }
            var start = Stopwatch.GetTimestamp();
            using var lease = feature.Lease();
            var canvas = lease.SkCanvas; var saved = canvas.SaveCount;
            canvas.Save();
            try
            {
                var scale = frame.Optics.Scale; canvas.Scale((float)(1 / scale));
                using var paint = new SKPaint { IsAntialias = true, FilterQuality = SKFilterQuality.Low,
                    Color = SKColors.White.WithAlpha((byte)Math.Round(255 * lease.CurrentOpacity)) };
                for (var i = 0; i < frame.Optics.Regions.Length; i++)
                {
                    var pane = frame.Optics.Regions[i];
                    var rect = new SKRect((float)(pane.Left * scale), (float)(pane.Top * scale), (float)(pane.Right * scale), (float)(pane.Bottom * scale));
                    var radius = (float)(Math.Min(24, Math.Min(pane.Width, pane.Height) / 2) * scale);
                    canvas.Save();
                    canvas.ClipRoundRect(new SKRoundRect(rect, radius), SKClipOperation.Intersect, true);
                    paint.ImageFilter = frame.Optics.Filters[i];
                    canvas.DrawImage(frame.Image, 0, 0, paint);
                    canvas.Restore();
                }
            }
            finally { canvas.RestoreToCount(saved); Volatile.Write(ref _owner._drawMilliseconds, Stopwatch.GetElapsedTime(start).TotalMilliseconds); }
        }
    }

}

using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Media;
using Avalonia.Rendering.SceneGraph;
using Avalonia.Skia;
using Avalonia.VisualTree;
using SkiaSharp;

namespace ICeClass.Receiver;

/// <summary>
/// A shared cached static window backdrop. Avalonia renders controls and text
/// above the tint without background capture, blur or displacement filters.
/// Geometry changes rebuild the picture, never a timer or a desktop capture.
/// </summary>
internal sealed class ClassroomGlassHost : Grid
{
    private readonly Control _content;
    private readonly BackgroundCanvas _background;
    private Picture? _picture;
    private Pane[] _panes = [];
    private Size _size;
    private bool _opaque;
    private readonly double? _shellRadius;
    private readonly bool _teacher;

    private readonly record struct Pane(Rect Bounds, double Radius, bool Primary = false);

    internal static void Apply(Window window, bool teacher = false)
    {
        window.Classes.Add(teacher ? "teacher-surface" : "classroom-surface");
        window.PropertyChanged += (_, change) =>
        {
            if (change.Property != ContentControl.ContentProperty || window.Content is not Control content || content is ClassroomGlassHost) return;
            // Content is assigned once by each existing constructor. Wrapping here
            // happens before the WebView is initialized or attached to a native HWND.
            window.Content = null;
            if (content is Panel panel) panel.Background = Brushes.Transparent;
            window.Content = new ClassroomGlassHost(content, teacher: teacher);
        };
    }

    internal static Control Wrap(Control content, double radius, bool teacher = false) => new ClassroomGlassHost(content, radius, teacher);

    private ClassroomGlassHost(Control content, double? shellRadius = null, bool teacher = false)
    {
        _content = content; _shellRadius = shellRadius; _teacher = teacher;
        _background = new BackgroundCanvas(this) { IsHitTestVisible = false };
        Children.Add(_background); Children.Add(content);
        LayoutUpdated += (_, _) => UpdatePicture();
        DetachedFromVisualTree += (_, _) => { _picture?.Release(); _picture = null; _size = default; };
    }

    private void UpdatePicture()
    {
        if (Bounds.Width < 1 || Bounds.Height < 1 || !IsEffectivelyVisible) return;
        var panes = new List<Pane>();
        foreach (var surface in _content.GetVisualDescendants().Prepend(_content).OfType<Control>())
        {
            if (!surface.IsEffectivelyVisible || !IsPane(surface)) continue;
            var origin = surface.TranslatePoint(default, this);
            if (origin is null || surface.Bounds.Width < 1 || surface.Bounds.Height < 1) continue;
            var bounds = new Rect(origin.Value, surface.Bounds.Size);
            if (!bounds.Intersects(new Rect(Bounds.Size))) continue;
            var radius = 13d;
            if (surface is Border border)
            {
                if (!Equals(border.Background, Brushes.Transparent)) border.Background = Brushes.Transparent;
                radius = border.CornerRadius.TopLeft;
            }
            else if (surface is TemplatedControl control)
            {
                if (!Equals(control.Background, Brushes.Transparent)) control.Background = Brushes.Transparent;
                radius = control.CornerRadius.TopLeft;
            }
            panes.Add(new Pane(bounds, radius, surface.Classes.Contains("native-primary")));
        }
        if (_shellRadius is { } shellRadius)
        {
            panes.Clear(); panes.Add(new Pane(new Rect(Bounds.Size), shellRadius));
            Clip = new RectangleGeometry(new Rect(Bounds.Size), shellRadius, shellRadius);
        }
        else if (panes.Count == 0) panes.Add(new Pane(new Rect(Bounds.Size).Deflate(12), 24));
        var opaque = DesktopStyle.HighContrastEnabled();
        var geometry = panes.ToArray();
        if (_picture is not null && _size == Bounds.Size && _opaque == opaque && _panes.SequenceEqual(geometry)) return;
        _size = Bounds.Size; _panes = geometry; _opaque = opaque;
        using var recorder = new SKPictureRecorder();
        var canvas = recorder.BeginRecording(new SKRect(0, 0, (float)_size.Width, (float)_size.Height));
        DrawScene(canvas, _size, opaque);
        foreach (var pane in _panes)
        {
            var rect = new SKRect(0, 0, (float)pane.Bounds.Width, (float)pane.Bounds.Height);
            var radius = (float)Math.Min(pane.Radius, Math.Min(rect.Width, rect.Height) / 2);
            canvas.Save(); canvas.Translate((float)pane.Bounds.X, (float)pane.Bounds.Y);
            canvas.ClipRoundRect(new SKRoundRect(rect, radius), SKClipOperation.Intersect, true);
            using var tint = new SKPaint { IsAntialias = true, Shader = SKShader.CreateLinearGradient(
                new SKPoint(0, 0), new SKPoint(rect.Width, rect.Height),
                opaque ? new SKColor[] { SKColors.White, SKColors.White } : pane.Primary
                    ? new SKColor[] { new(230,246,255,181), new(165,213,250,145) }
                    : _teacher ? new SKColor[] { new(255,255,255,151), new(229,245,255,104) }
                    : new SKColor[] { new(255,255,255,175), new(229,245,255,125) }, (float[]?)null, SKShaderTileMode.Clamp) };
            canvas.DrawRoundRect(rect, radius, radius, tint);
            using var edge = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 1,
                Color = opaque ? SKColors.DarkSlateGray : new SKColor(255,255,255,220) };
            canvas.DrawRoundRect(SKRect.Inflate(rect, -.5f, -.5f), radius, radius, edge);
            canvas.Restore();
        }
        var previous = _picture; _picture = new Picture(recorder.EndRecording()); previous?.Release();
        _background.InvalidateVisual();
    }

    private bool IsPane(Control control) => control is Border &&
        (control.Classes.Contains("classroom-glass") || control.Classes.Contains("native-card") ||
         control.Classes.Contains("native-dialog-footer") || control.Classes.Contains("classroom-tab-strip") ||
         _teacher && control.Classes.Contains("teacher-glass")) || _teacher &&
        (control is Button && (control.Classes.Contains("native-button") || control.Classes.Contains("native-flyout-action")) &&
            (!control.Classes.Contains("native-document") || control.Classes.Contains("selected")) ||
         control is TextBox or ComboBox or NumericUpDown);

    private static void DrawScene(SKCanvas canvas, Size size, bool opaque)
    {
        var w = (float)size.Width; var h = (float)size.Height;
        using var paint = new SKPaint { IsAntialias = true };
        if (opaque) { canvas.DrawColor(SKColors.White); return; }
        paint.Shader = SKShader.CreateLinearGradient(new SKPoint(0, 0), new SKPoint(w, h),
            [new SKColor(234,248,255), new SKColor(181,212,235), new SKColor(211,234,248)], [0,.7f,1], SKShaderTileMode.Clamp);
        canvas.DrawRect(0, 0, w, h, paint); paint.Shader.Dispose(); paint.Shader = null;
        paint.Color = new SKColor(248,253,255,90); paint.Style = SKPaintStyle.Stroke; paint.StrokeWidth = Math.Max(40, w * .12f);
        canvas.DrawOval(new SKRect(w*.33f,-h*.85f,w*1.7f,h*.62f),paint);
        paint.Color = new SKColor(255,255,255,140); paint.StrokeWidth = Math.Max(5,w*.008f);
        canvas.DrawOval(new SKRect(-w*.56f,-h*.4f,w*1.1f,h*1.49f),paint);
        paint.Color = new SKColor(249,254,255,130); paint.StrokeWidth = Math.Max(8,w*.015f);
        canvas.DrawOval(new SKRect(-w*.2f,h*.68f,w*1.45f,h*2.23f),paint);
    }

    private sealed class BackgroundCanvas(ClassroomGlassHost owner) : Control
    {
        public override void Render(DrawingContext context)
        {
            if (owner._picture is { } picture) context.Custom(new BackgroundDraw(picture, new Rect(Bounds.Size)));
        }
    }

    private sealed class Picture(SKPicture value)
    {
        private int _references = 1;
        internal readonly SKPicture Value = value;
        internal void Retain() => Interlocked.Increment(ref _references);
        internal void Release() { if (Interlocked.Decrement(ref _references) == 0) Value.Dispose(); }
    }

    private sealed class BackgroundDraw : ICustomDrawOperation
    {
        private Picture? _picture;
        public Rect Bounds { get; }
        internal BackgroundDraw(Picture picture, Rect bounds) { _picture = picture; picture.Retain(); Bounds = bounds; }
        public bool HitTest(Point point) => false;
        public bool Equals(ICustomDrawOperation? other) => false;
        public void Dispose() => Interlocked.Exchange(ref _picture, null)?.Release();
        public void Render(ImmediateDrawingContext context)
        {
            if (_picture is not { } picture || context.TryGetFeature(typeof(ISkiaSharpApiLeaseFeature)) is not ISkiaSharpApiLeaseFeature feature) return;
            using var lease = feature.Lease();
            using var opacity = new SKPaint { Color = SKColors.White.WithAlpha((byte)Math.Round(255*lease.CurrentOpacity)) };
            lease.SkCanvas.DrawPicture(picture.Value, opacity);
        }
    }
}

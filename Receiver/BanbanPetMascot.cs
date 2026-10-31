using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Rendering.SceneGraph;
using Avalonia.Skia;
using Avalonia.Threading;
using SkiaSharp;

namespace ICeClass.Receiver;

/// <summary>The original painted mesh rig on a small native desktop surface.</summary>
internal sealed class BanbanPetMascot : Control, IDisposable
{
    private readonly Dictionary<string, Bitmap> _images = new();
    private readonly Dictionary<string, SKImage> _textures = new();
    private readonly BanbanPetMotion _motion = new();
    private readonly DispatcherTimer _frames, _idle;
    private long _lastFrame;
    private double _settling, _peek;
    private int _idleVariant;
    private string _state = "off";
    private bool _visible, _enabled, _disposed, _docked, _right = true;
    private bool _animate = ClassroomIslandReveal.AnimationsEnabled();
    internal bool Animate
    {
        get => _animate;
        set { if (_animate == value) return; _animate = value; if (!value) _motion.Rest(); UpdateFrames(); InvalidateVisual(); }
    }
    internal bool AnimationRunning => _frames.IsEnabled;
    internal bool IdleScheduled => _idle.IsEnabled;
    internal string Gesture => _motion.Gesture;
    internal bool AssetsLoaded => _images.Count == 19;
    internal BanbanPetPose? ReviewPose { get; set; }
    internal Func<double>? SpeechOpening { get; set; }

    internal BanbanPetMascot()
    {
        Width = 116; Height = 130; IsHitTestVisible = false;
        RenderOptions.SetBitmapInterpolationMode(this, BitmapInterpolationMode.HighQuality);
        foreach (var name in new[] { "body", "arm-left", "arm-right", "bookmark", "mas", "mouth", "mouth-happy",
            "forearm-right", "socket-left", "socket-right", "iris-left", "iris-right", "lash-left", "lash-right", "smile-left", "smile-right",
            "body-running", "leg-left", "leg-right" })
        {
            using var stream = typeof(BanbanPetMascot).Assembly.GetManifestResourceStream($"ICeClass.Island.banban.{name}.webp")!;
            _images[name] = new Bitmap(stream);
            if (name is "body" or "body-running" or "leg-left" or "leg-right" or "arm-left" or "arm-right" or "bookmark" or "mouth" or "forearm-right"
                or "socket-left" or "socket-right" or "iris-left" or "iris-right" or "lash-left" or "lash-right")
            {
                using var texture = typeof(BanbanPetMascot).Assembly.GetManifestResourceStream($"ICeClass.Island.banban.{name}.webp")!;
                _textures[name] = SKImage.FromEncodedData(texture);
            }
        }
        _frames = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
        _idle = new DispatcherTimer();
        _idle.Tick += (_, _) =>
        {
            _idle.Stop();
            if (!CanAnimate || !_docked) return;
            _idleVariant++;
            _motion.PlayIdle(_right); _settling = 0; UpdateFrames(); InvalidateVisual();
        };
        _frames.Tick += (_, _) =>
        {
            var now = Stopwatch.GetTimestamp();
            var seconds = _lastFrame == 0 ? 1d / 30 : Stopwatch.GetElapsedTime(_lastFrame, now).TotalSeconds;
            _motion.SetSpeechOpening(_state == "speaking" && !_docked ? SpeechOpening?.Invoke() ?? 0 : 0);
            _motion.Advance(seconds);
            _lastFrame = now; InvalidateVisual();
            _settling = _motion.Gesture.Length == 0 ? _settling + seconds : 0;
            if (_docked && _settling >= .8)
            {
                _motion.Rest(); _frames.Stop(); _lastFrame = 0;
                ScheduleIdle(); InvalidateVisual();
            }
        };
    }

    internal void Present(string state, bool enabled, bool visible, bool docked = false, bool right = true)
    {
        _state = state; _enabled = enabled; _visible = visible; _docked = docked; _right = right;
        _motion.SetState(docked ? "standby" : state, right);
        if (!Animate || !visible || !enabled) _motion.Rest();
        UpdateFrames(); InvalidateVisual();
    }
    private bool CanAnimate => !_disposed && Animate && _visible && _enabled && _state is not ("off" or "login");
    private void UpdateFrames()
    {
        if (!CanAnimate) { _frames.Stop(); _idle.Stop(); _lastFrame = 0; return; }
        if (!_docked || _motion.Gesture.Length > 0)
        {
            _idle.Stop();
            if (!_frames.IsEnabled) { _lastFrame = 0; _settling = 0; _frames.Start(); }
        }
        else if (!_frames.IsEnabled) ScheduleIdle();
    }
    private void ScheduleIdle()
    {
        if (!CanAnimate || !_docked || _idle.IsEnabled) return;
        _idle.Interval = TimeSpan.FromSeconds(_idleVariant == 0 ? 6 : 8 + (_idleVariant - 1) % 4 * 2);
        _idle.Start();
    }
    internal void SetPeeking(double amount, bool right)
    {
        _peek = Math.Clamp(amount, 0, 1); _right = right; InvalidateVisual();
    }
    internal void PlayWake(bool right) => Play("wake", right);
    internal void Play(string gesture, bool right = true)
    {
        if (_disposed || !Animate || !_visible || !_enabled) return;
        _motion.Play(gesture, right); _settling = 0; UpdateFrames(); InvalidateVisual();
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        if (_disposed) return;
        var p = ReviewPose ?? _motion.Pose;
        // The same painted book leans around the edge. Do not mirror its badge
        // or crop its face into a separate low-resolution idle asset.
        if (_motion.Gesture == "wake") p.OffsetX *= 1 - _peek;
        var scale = Math.Min(Bounds.Width / 716, Bounds.Height / 800);
        using var position = context.PushTransform(Matrix.CreateScale(scale, scale)
            * Matrix.CreateTranslation((Bounds.Width - 716 * scale) / 2, (Bounds.Height - 800 * scale) / 2));
        using var arrival = context.PushTransform(Around(343, 650, Matrix.CreateScale(1 + p.Squash, 1 - p.Squash))
            * Matrix.CreateTranslation(28 + p.OffsetX, 35 + p.Hop));
        using var peeking = context.PushTransform(Around(343, 642, Matrix.CreateRotation((_right ? -.55 : .55) * _peek)));
        Point Body(Point q) => Deform(q, p);
        var leftRest = new Arm(new(139, 430), new(72, 408), new(39, 365));
        var left = Solve(leftRest, Body(leftRest.Shoulder), Body(new(p.LeftX, p.LeftY)));
        var right = RightArm(p);
        Point Left(Point q) => Skin(q, leftRest, left);
        Point Right(Point q) => Body(SkinRight(q, right));
        Mesh(context, "arm-left", new(0, 327, 150, 140), Left, 3, 6);
        Mesh(context, "arm-right", new(540, 410, 114, 170), Right, 4, 12);
        var body = new Rect(100, 60, 500, 629);
        if (Math.Abs(p.Step) > .001)
        {
            Leg(context, "leg-left", body, 270, 600, p.Step, p);
            Leg(context, "leg-right", body, 400, 610, -p.Step, p);
            Mesh(context, "body-running", body, Body, 4, 7);
        }
        else Mesh(context, "body", body, Body, 4, 7);
        Mesh(context, "bookmark", new(423, 54, 108, 110), q =>
            Body(Rotate(q, new(500, 62), p.Ribbon * BanbanPetMotion.Smooth(55, 160, q.Y))), 2, 4);
        Stamp(context, "mas", new(246, 386, 146, 146), p);
        Eye(context, "left", new(187, 217, 106, 91), p.CloseLeft, p);
        Eye(context, "right", new(378, 225, 106, 91), p.CloseRight, p);
        var opening = Math.Clamp(p.MouthOpen, 0, 1);
        using (context.PushOpacity(1 - BanbanPetMotion.Smooth(.12, .38, opening)))
            Mesh(context, "mouth", new(291, 320, 82, 24), q =>
            {
                var x = (q.X - 291) / 82; var arch = 4 * x * (1 - x);
                return Body(new(q.X + p.Turn * 16, q.Y - p.Concern * 29 * arch + (p.Smile - .3) * 5 * arch));
            }, 4, 1);
        var mouthOpacity = BanbanPetMotion.Smooth(.12, .38, opening);
        if (mouthOpacity > .001)
        {
            using var opacity = context.PushOpacity(mouthOpacity);
            var center = Body(new(330.5, 337.5));
            using var transform = context.PushTransform(Matrix.CreateTranslation(-330.5, -337.5)
                * Matrix.CreateRotation(p.Lean * BanbanPetMotion.Smooth(645, 90, 337.5)) * Matrix.CreateTranslation(center.X, center.Y));
            var height = 32 * Math.Pow(opening, .8);
            context.DrawImage(_images["mouth-happy"], new Rect(291, 311, 82, 42), new Rect(301.5, 337.5 - height / 2, 58, height));
        }
        // Ordinary gestures emerge from behind the cover. Only a reach around
        // the book toward the cheek passes in front. Height alone also brought
        // the pointing wrist across the pages as a translucent seam.
        var forearmOpacity = BanbanPetMotion.Smooth(.5, .7, p.Think);
        if (forearmOpacity > .001)
        {
            using var opacity = context.PushOpacity(forearmOpacity);
            Mesh(context, "forearm-right", new(540, 410, 114, 170), Right, 4, 12);
        }
    }

    private void Eye(DrawingContext context, string side, Rect rect, double closed, BanbanPetPose p)
    {
        closed = Math.Clamp(closed, 0, 1);
        var openness = Math.Max(.015, (1 - closed) * (1 - p.Concern * .12));
        var center = Deform(rect.Center, p);
        using var transform = context.PushTransform(Matrix.CreateTranslation(-rect.Center.X, -rect.Center.Y)
            * Matrix.CreateRotation(p.Lean * BanbanPetMotion.Smooth(645, 90, rect.Center.Y))
            * Matrix.CreateTranslation(center.X + p.Turn * 26, center.Y));
        using (context.PushOpacity(1 - BanbanPetMotion.Smooth(.78, .98, closed)))
        {
            var lid = new Rect(rect.X, rect.Y + rect.Height * .6 * (1 - openness), rect.Width, rect.Height * openness);
            // Compose in one native draw operation. An ImageBrush opacity mask
            // loses the iris in the live compositor although offscreen renders work.
            context.Custom(new PaintedEye(this, _textures["socket-" + side], _textures["iris-" + side],
                _textures["lash-" + side], rect, lid, new Vector(p.GazeX * 7, p.GazeY * 4)));
        }
        var smile = BanbanPetMotion.Smooth(.60, .96, closed);
        if (smile > .001)
        {
            using var opacity = context.PushOpacity(smile);
            context.DrawImage(_images["smile-" + side], side == "left" ? new(175, 205, 135, 115) : new(365, 205, 135, 120));
        }
    }

    private sealed class PaintedEye(BanbanPetMascot owner, SKImage socket, SKImage iris, SKImage lash,
        Rect rect, Rect lid, Vector gaze) : ICustomDrawOperation
    {
        public Rect Bounds => rect.Inflate(1);
        public bool HitTest(Point point) => false;
        public bool Equals(ICustomDrawOperation? other) => false;
        public void Dispose() { }
        public void Render(ImmediateDrawingContext context)
        {
            if (owner._disposed) return;
            var feature = context.TryGetFeature(typeof(ISkiaSharpApiLeaseFeature)) as ISkiaSharpApiLeaseFeature
                ?? throw new NotSupportedException("Banban's painted eyes need the application's Skia renderer.");
            using var lease = feature.Lease();
            using var opacity = new SKPaint { Color = SKColors.White.WithAlpha((byte)Math.Round(255 * lease.CurrentOpacity)) };
            using var paint = new SKPaint { IsAntialias = true, FilterQuality = SKFilterQuality.Low };
            var canvas = lease.SkCanvas; var saved = canvas.SaveCount;
            canvas.SaveLayer(ToSkia(rect), opacity);
            try
            {
                canvas.DrawImage(socket, ToSkia(lid), paint);
                // Source-atop keeps the iris round while the painted eyelids
                // occlude it, matching the original web rig's eye composition.
                paint.BlendMode = SKBlendMode.SrcATop;
                canvas.DrawImage(iris, ToSkia(rect.Translate(gaze)), paint);
                paint.BlendMode = SKBlendMode.SrcOver;
                canvas.DrawImage(lash, ToSkia(lid), paint);
            }
            finally { canvas.RestoreToCount(saved); }
        }
        private static SKRect ToSkia(Rect value) => new((float)value.Left, (float)value.Top, (float)value.Right, (float)value.Bottom);
    }
    private void Stamp(DrawingContext context, string name, Rect rect, BanbanPetPose p)
    {
        var center = Deform(rect.Center, p);
        using var transform = context.PushTransform(Matrix.CreateTranslation(-rect.Center.X, -rect.Center.Y)
            * Matrix.CreateRotation(p.Lean * BanbanPetMotion.Smooth(645, 90, rect.Center.Y)) * Matrix.CreateTranslation(center.X, center.Y));
        context.DrawImage(_images[name], rect);
    }
    private void Leg(DrawingContext context, string name, Rect rect, double x, double y, double stride, BanbanPetPose p) =>
        Mesh(context, name, rect, q => Deform(Rotate(q, new(x, y), stride * .34)
            + new Vector(stride * 5, -Math.Max(0, stride) * 16), p), 3, 5);

    private void Mesh(DrawingContext context, string name, Rect rect, Func<Point, Point> map, int columns, int rows)
    {
        var image = _textures[name];
        var source = new SKPoint[(columns + 1) * (rows + 1)]; var dest = new SKPoint[source.Length];
        for (var j = 0; j <= rows; j++) for (var i = 0; i <= columns; i++)
        {
            var index = j * (columns + 1) + i;
            source[index] = new((float)image.Width * i / columns, (float)image.Height * j / rows);
            var point = map(new(rect.X + rect.Width * i / columns, rect.Y + rect.Height * j / rows));
            dest[index] = new((float)point.X, (float)point.Y);
        }
        var indices = new ushort[columns * rows * 6]; var cursor = 0;
        for (var j = 0; j < rows; j++) for (var i = 0; i < columns; i++)
        {
            var a = j * (columns + 1) + i; var b = a + 1; var c = a + columns + 1; var d = c + 1;
            indices[cursor++] = (ushort)a; indices[cursor++] = (ushort)b; indices[cursor++] = (ushort)d;
            indices[cursor++] = (ushort)a; indices[cursor++] = (ushort)d; indices[cursor++] = (ushort)c;
        }
        context.Custom(new PaintedMesh(this, image, source, dest, indices));
    }
    // One indexed texture mesh avoids translucent triangle overlaps and clip seams.
    // SkiaSharp already ships with Avalonia.Desktop; this adds no runtime package.
    private sealed class PaintedMesh : ICustomDrawOperation
    {
        private readonly BanbanPetMascot _owner;
        private readonly SKImage _texture;
        private readonly SKPoint[] _source, _points;
        private readonly ushort[] _indices;
        public Rect Bounds { get; }
        internal PaintedMesh(BanbanPetMascot owner, SKImage texture, SKPoint[] source, SKPoint[] points, ushort[] indices)
        {
            _owner = owner; _texture = texture;
            _source = source; _points = points; _indices = indices;
            var x = points.Min(p => p.X); var y = points.Min(p => p.Y);
            Bounds = new Rect(x - 1, y - 1, points.Max(p => p.X) - x + 2, points.Max(p => p.Y) - y + 2);
        }
        public bool HitTest(Point point) => false;
        public bool Equals(ICustomDrawOperation? other) => false;
        public void Render(ImmediateDrawingContext context)
        {
            if (_owner._disposed) return;
            var feature = context.TryGetFeature(typeof(ISkiaSharpApiLeaseFeature)) as ISkiaSharpApiLeaseFeature
                ?? throw new NotSupportedException("Banban's painted mesh needs the application's Skia renderer.");
            using var lease = feature.Lease();
            using var vertices = SKVertices.CreateCopy(SKVertexMode.Triangles, _points, _source, null, _indices);
            using var shader = _texture.ToShader();
            // Skia 2.88's high-quality vertex sampler mis-scales these WebP
            // textures when minified. Bilinear sampling preserves texture-space
            // coordinates at the pet's small size, without mesh seams.
            using var paint = new SKPaint { IsAntialias = true, FilterQuality = SKFilterQuality.Low, Shader = shader,
                Color = SKColors.White.WithAlpha((byte)Math.Round(255 * lease.CurrentOpacity)) };
            lease.SkCanvas.DrawVertices(vertices, SKBlendMode.Modulate, paint);
        }
        public void Dispose() { }
    }

    internal static Point Deform(Point q, BanbanPetPose p)
    {
        var influence = BanbanPetMotion.Smooth(645, 90, q.Y);
        var result = Rotate(q, new(343, 642), p.Lean * influence);
        return new(result.X + p.Turn * 105 * influence,
            result.Y + (p.Lift + p.Bow * (10 + (642 - q.Y) * .035)) * influence);
    }
    internal readonly record struct Arm(Point Shoulder, Point Elbow, Point Wrist);
    private static readonly Arm RightRest = new(new(555, 426), new(589, 484), new(607, 548));

    internal static Arm RightArm(BanbanPetPose p)
    {
        var rest = RightRest;
        // The original arm is already painted with a bend. Ordinary gestures
        // move that whole cutout, as the island does, instead of bending it again.
        // Its hidden shoulder moves under the cover as the hand rises, keeping
        // the original silhouette inside the compact surface. Cheek contact
        // retains its separate curved reach and continuous transition.
        var thought = Solve(rest, rest.Shoulder, BanbanPetMotion.ThinkWrist(p.Think));
        var gesture = 1 - BanbanPetMotion.Smooth(0, .5, p.Think);
        var rotation = p.RightShoulder * gesture;
        // Reserve the original silhouette's full reach, including the hop's
        // body squash. The cheek reach also tucks its hidden shoulder inward
        // while passing the cover, then returns to the original contact point.
        var reach = Math.Sin(Math.Clamp(p.Think, 0, 1) * Math.PI);
        var inset = new Vector(-86 * (Math.Sin(Math.Clamp(-rotation, 0, Math.PI / 2)) + reach), 0);
        var upper = Angle(thought.Elbow - thought.Shoulder) - Angle(rest.Elbow - rest.Shoulder) + rotation;
        var lower = Angle(thought.Wrist - thought.Elbow) - Angle(rest.Wrist - rest.Elbow) + rotation;
        var elbow = Rotate(rest.Elbow, rest.Shoulder, upper) + inset;
        return new(rest.Shoulder + inset, elbow, Rotate(rest.Wrist, rest.Elbow, lower) + (elbow - rest.Elbow));
    }
    // Spread the bend through the upper arm hidden under the cover, then stop
    // before the palm. A narrow elbow blend turns the inside texture triangles
    // backwards when this broad painted hand is raised.
    internal static Point SkinRight(Point q, Arm arm)
        => Skin(q, RightRest, arm, -.45, .68);
    private static Arm Solve(Arm rest, Point shoulder, Point wrist)
    {
        var upper = ((Vector)(rest.Elbow - rest.Shoulder)).Length; var lower = ((Vector)(rest.Wrist - rest.Elbow)).Length;
        Vector delta = wrist - shoulder; var raw = delta.Length;
        var distance = Math.Clamp(raw, Math.Abs(upper - lower) + .01, upper + lower - .01);
        var direction = raw > 1e-6 ? delta / raw : new Vector(0, 1);
        var along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
        var height = -Math.Sqrt(Math.Max(0, upper * upper - along * along));
        return new(shoulder, shoulder + direction * along + new Vector(-direction.Y, direction.X) * height, shoulder + direction * distance);
    }
    private static Point Skin(Point q, Arm rest, Arm posed, double bendStart = .28, double bendEnd = .76)
    {
        var ab = rest.Wrist - rest.Shoulder; var point = q - rest.Shoulder;
        var along = (point.X * ab.X + point.Y * ab.Y) / (ab.X * ab.X + ab.Y * ab.Y);
        var a = Angle(posed.Elbow - posed.Shoulder) - Angle(rest.Elbow - rest.Shoulder);
        var b = Angle(posed.Wrist - posed.Elbow) - Angle(rest.Wrist - rest.Elbow);
        var delta = Math.Atan2(Math.Sin(b - a), Math.Cos(b - a));
        return Rotate(q, rest.Elbow, a + delta * BanbanPetMotion.Smooth(bendStart, bendEnd, along)) + (posed.Elbow - rest.Elbow);
    }
    private static double Angle(Vector v) => Math.Atan2(v.Y, v.X);
    private static Point Rotate(Point q, Point origin, double angle)
    { var c = Math.Cos(angle); var s = Math.Sin(angle); var delta = q - origin; return new(origin.X + delta.X * c - delta.Y * s, origin.Y + delta.Y * c + delta.X * s); }
    private static Matrix Around(double x, double y, Matrix transform) => Matrix.CreateTranslation(-x, -y) * transform * Matrix.CreateTranslation(x, y);
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true; _frames.Stop(); _idle.Stop();
        foreach (var image in _images.Values) image.Dispose();
        _images.Clear();
        foreach (var texture in _textures.Values) texture.Dispose();
        _textures.Clear();
    }
}

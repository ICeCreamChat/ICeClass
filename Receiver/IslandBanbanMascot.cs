using System.Diagnostics;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;

namespace ICeClass.Receiver;

// Reuse the original Banban layers and their existing 660 x 720 rig coordinates.
// This small transparent surface only animates during an accepted shout.
internal sealed class IslandBanbanMascot : Control, IDisposable
{
    internal const double GripSeconds = .32;
    internal const double PullSeconds = 1.45;
    internal const double PullEndSeconds = GripSeconds + PullSeconds;
    private readonly Dictionary<string, Bitmap> _images = new();
    private long _sequence = -1, _started;
    private bool _active, _queued, _disposed, _speaking, _urgent, _important;
    internal bool Animate { get; set; } = ClassroomIslandReveal.AnimationsEnabled();
    internal double? ReviewSeconds { get; set; }
    internal bool AssetsLoaded => _images.Count == 15;

    public IslandBanbanMascot()
    {
        Width = IslandShoutCompanion.SideWidth; Height = IslandShoutCompanion.MascotHeight; IsHitTestVisible = false;
        // These large artwork layers shrink to a small desktop companion. The
        // default sampler loses thin outlines and eye detail at fractional DPI.
        RenderOptions.SetBitmapInterpolationMode(this, BitmapInterpolationMode.HighQuality);
        UseLayoutRounding = true;
        AutomationProperties.SetName(this, "班班，小书灵，在悬浮岛侧边陪你传话");
        foreach (var name in new[] { "body", "body-running", "leg-left", "leg-right", "arm-left", "arm-right", "bookmark", "mas", "eyes-neutral", "eyes-smile", "mouth", "mouth-happy", "mouth-smile", "mouth-neutral", "holding-supplied" })
        {
            using var stream = typeof(IslandBanbanMascot).Assembly.GetManifestResourceStream($"ICeClass.Island.banban.{name}.webp")!;
            _images[name] = new Bitmap(stream);
        }
    }

    public void Begin(ClassroomIslandNotice notice)
    {
        if (!_active || _sequence != notice.Sequence) { _sequence = notice.Sequence; _started = Stopwatch.GetTimestamp(); }
        _speaking = notice.ContentType == "audio" || notice.Level != "info";
        _urgent = notice.Level == "urgent"; _important = notice.Level == "warning"; _active = true;
        InvalidateVisual(); QueueFrame();
    }

    public void Stop() { _active = false; InvalidateVisual(); }
    public void ResumeAnimation() { _queued = false; QueueFrame(); }

    private void QueueFrame()
    {
        if (_queued || _disposed || !_active || !Animate || ReviewSeconds.HasValue || TopLevel.GetTopLevel(this) is not { IsVisible: true } top) return;
        _queued = true;
        top.RequestAnimationFrame(_ => { _queued = false; if (_disposed || !_active) return; InvalidateVisual(); QueueFrame(); });
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);
        if (_disposed) return;
        var time = !Animate ? 2.4 : ReviewSeconds ?? Stopwatch.GetElapsedTime(_started).TotalSeconds;
        var pulling = _active && (_important || _urgent);
        var pull = Animate && pulling ? PullAt(time) : 0;
        var run = Animate && pulling ? RunAt(time) : 0;
        var stride = Math.Sin((time - GripSeconds) * Math.PI * 6.4);
        var raised = _urgent ? Animate ? IslandBanbanHoldingArm.RaiseAt(time) : 1 : 0;
        var holdingPose = _urgent ? IslandBanbanHoldingArm.At(raised, run, stride) : default;
        var waveStart = _important ? PullEndSeconds + .15 : .25;
        var wave = _urgent || !_active ? 0 : Math.Clamp((time - waveStart) / .25, 0, 1) * Math.Clamp((waveStart + 1.25 - time) / .4, 0, 1);
        var blinkPhase = (time + 1.3) % 4.4;
        var blink = Animate && _active ? Math.Max(0, 1 - Math.Abs(blinkPhase - 4) / .15) : 0;
        var nod = _active && time > 2 && time < 3.1 ? Math.Sin((time - 2) / 1.1 * Math.PI) : 0;
        var breath = Animate && _active ? Math.Sin(time * Math.PI / 1.8) : 0;
        // The supplied large horn needs extra left space during the running lean,
        // including the native 100% antialiasing fringe.
        using var position = context.PushTransform(Matrix.CreateScale(.09, .09) * Matrix.CreateTranslation(
            2 + (_urgent ? 4.75 : 0) - pull * 1.2, 2 + breath * .35 - run * (1 + Math.Abs(stride) * .9)));
        using var lean = context.PushTransform(Around(330, 650, Matrix.CreateRotation(-run * .2 - pull * .035 + (wave * Math.Sin(time * 5) * .025) + nod * .035)));
        var leftHand = pulling ? run * (-.3 + stride * .5) + wave * (.48 + Math.Sin(time * 12) * .2) : -wave * .08;
        var grip = -.72 * Math.Clamp(time / .25, 0, 1) - pull * .4;
        var rightHand = pulling ? grip : wave * (-.95 + Math.Sin(time * 13) * .28);
        if (!_urgent) Draw(context, "arm-left", new Rect(0, 327, 150, 140), Around(110, 355, Matrix.CreateRotation(leftHand)));
        DrawRightHand(context, rightHand);
        var body = new Rect(100, 60, 500, 629);
        if (run > .001)
        {
            DrawLeg(context, "leg-left", body, 270, 600, stride, run);
            DrawLeg(context, "leg-right", body, 400, 610, -stride, run);
            Draw(context, "body-running", body);
        }
        else Draw(context, "body", body);
        Draw(context, "bookmark", new Rect(423, 54, 108, 110), Around(500, 62, Matrix.CreateRotation(breath * .035)));
        Draw(context, "mas", new Rect(246, 386, 146, 146));
        using (context.PushOpacity(1 - blink))
            Draw(context, "eyes-neutral", new Rect(0, 0, 660, 720), Around(330, 266, Matrix.CreateScale(1, Math.Max(.04, 1 - blink))));
        if (blink > 0) using (context.PushOpacity(blink)) Draw(context, "eyes-smile", new Rect(0, 0, 660, 720));
        // A gentle speaking gesture, not claimed to track the recorded waveform.
        var mouth = _urgent ? "mouth-neutral" : Animate && _active && _speaking && time > 2.2 && Math.Sin(time * 7) > .4 ? "mouth-happy" : "mouth-smile";
        Draw(context, mouth, new Rect(0, 0, 660, 720));
        if (_urgent)
        {
            Draw(context, "holding-supplied", IslandBanbanHoldingArm.ArtworkBounds, holdingPose.Transform);
            IslandBanbanMegaphone.DrawSound(context, holdingPose, raised, time, Animate && _active);
        }
    }

    private void DrawRightHand(DrawingContext context, double angle) =>
        Draw(context, "arm-right", new Rect(540, 410, 114, 170), Around(550, 420, Matrix.CreateRotation(angle)));

    private void DrawLeg(DrawingContext context, string name, Rect body, double x, double y, double stride, double run) =>
        Draw(context, name, body, Around(x, y, Matrix.CreateScale(1, 1 + run * .22) * Matrix.CreateRotation(stride * run * .9))
            * Matrix.CreateTranslation(stride * run * 14, -Math.Max(0, stride) * run * 22));

    private void Draw(DrawingContext context, string name, Rect rect, Matrix? transform = null)
    {
        using var scope = context.PushTransform(transform ?? Matrix.Identity);
        context.DrawImage(_images[name], rect);
    }
    private static Matrix Around(double x, double y, Matrix transform) => Matrix.CreateTranslation(-x, -y) * transform * Matrix.CreateTranslation(x, y);
    internal static double PullAt(double seconds)
    {
        var phase = Math.Clamp((seconds - GripSeconds) / PullSeconds, 0, 1);
        return Math.Pow(Math.Sin(phase * Math.PI), 2);
    }
    internal static double ExpansionAt(double seconds)
    {
        var phase = Math.Clamp((seconds - GripSeconds) / PullSeconds, 0, 1);
        return phase * phase * (3 - 2 * phase);
    }
    private static double RunAt(double seconds)
    {
        var entering = Math.Clamp((seconds - GripSeconds) / .14, 0, 1);
        var leaving = Math.Clamp((PullEndSeconds - seconds) / .22, 0, 1);
        return entering * entering * (3 - 2 * entering) * leaving * leaving * (3 - 2 * leaving);
    }
    public void Dispose() { _disposed = true; _active = false; foreach (var image in _images.Values) image.Dispose(); _images.Clear(); }
}

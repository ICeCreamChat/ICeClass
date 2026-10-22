using Avalonia.Media;

namespace ICeClass.Receiver;

// The horn itself is painted in holding-supplied.webp. Only the sound cue is native.
internal static class IslandBanbanMegaphone
{
    private static readonly Geometry SoundNear = Geometry.Parse("M -18,235 Q -65,360 -18,485");
    private static readonly Geometry SoundFar = Geometry.Parse("M -50,205 Q -108,360 -50,515");
    private static readonly Pen Sound = new(new SolidColorBrush(Color.Parse("#C65E5A")), 13.5,
        lineCap: PenLineCap.Round);

    internal static void DrawSound(DrawingContext context, IslandBanbanHoldingArm.Pose pose, double raised, double seconds, bool animate)
    {
        if (!animate || raised < .98) return;
        using var transform = context.PushTransform(pose.Transform);
        var pulse = .35 + .45 * (1 + Math.Sin(seconds * Math.PI * 3)) / 2;
        using var opacity = context.PushOpacity(pulse);
        context.DrawGeometry(null, Sound, SoundNear);
        using var outer = context.PushOpacity(.6);
        context.DrawGeometry(null, Sound, SoundFar);
    }
}

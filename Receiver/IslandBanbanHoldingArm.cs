using Avalonia;

namespace ICeClass.Receiver;

// The supplied arm, fingers and horn remain one unmirrored painted sprite.
// Only this complete assembly rotates; its hand anatomy is never reconstructed.
internal static class IslandBanbanHoldingArm
{
    internal static readonly Point Shoulder = new(130, 400);
    internal static readonly Point SourceShoulder = new(363, 612);
    internal static readonly Point SourceGrip = new(539, 663);
    internal static readonly Point SourceMouthpiece = new(854, 439);
    internal static readonly Rect ArtworkBounds = new(0, 0, 862, 835);
    internal const double ArtworkScale = .35885587062814606;
    private const double RestAngle = .06781299911541788;

    internal readonly record struct Pose(Matrix Transform, Point Grip, Point Mouthpiece);

    internal static double RaiseAt(double seconds)
    {
        var phase = Math.Clamp((seconds - IslandBanbanMascot.PullEndSeconds - .08) / .38, 0, 1);
        return phase * phase * (3 - 2 * phase);
    }

    internal static Pose At(double raised, double run, double stride)
    {
        var lift = Math.Clamp(raised, 0, 1);
        var sway = (1 - lift) * Math.Clamp(run, 0, 1) * Math.Clamp(stride, -1, 1);
        var angle = RestAngle + .38 * (1 - lift) + sway * .02;
        var transform = Matrix.CreateTranslation(-SourceShoulder.X, -SourceShoulder.Y)
            * Matrix.CreateScale(ArtworkScale, ArtworkScale)
            * Matrix.CreateRotation(angle)
            * Matrix.CreateTranslation(Shoulder.X, Shoulder.Y);
        return new(transform, transform.Transform(SourceGrip), transform.Transform(SourceMouthpiece));
    }
}

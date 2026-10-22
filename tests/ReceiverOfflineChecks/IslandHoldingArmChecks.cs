using Avalonia;
using ICeClass.Receiver;

internal static class IslandHoldingArmChecks
{
    internal static int Run()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new Exception(description);
            checks++; Console.WriteLine("PASS " + description);
        }
        static double Distance(Point a, Point b) => Math.Sqrt(Math.Pow(a.X - b.X, 2) + Math.Pow(a.Y - b.Y, 2));
        var anchors = true; var rigid = true; var unmirrored = true; var grasp = true; var scale = true;
        var gripToHorn = Distance(IslandBanbanHoldingArm.SourceGrip, IslandBanbanHoldingArm.SourceMouthpiece)
            * IslandBanbanHoldingArm.ArtworkScale;
        for (var step = 0; step <= 100; step++)
        foreach (var stride in new[] { -1d, 0, 1 })
        {
            var pose = IslandBanbanHoldingArm.At(step / 100d, 1, stride);
            anchors &= Distance(pose.Transform.Transform(IslandBanbanHoldingArm.SourceShoulder), IslandBanbanHoldingArm.Shoulder) < 1e-8;
            rigid &= Math.Abs(Distance(pose.Grip, pose.Mouthpiece) - gripToHorn) < 1e-8;
            unmirrored &= pose.Transform.M11 * pose.Transform.M22 - pose.Transform.M12 * pose.Transform.M21 > 0;
            grasp &= Distance(pose.Transform.Transform(IslandBanbanHoldingArm.SourceGrip), pose.Grip) < 1e-8;
            scale &= Math.Abs(Distance(pose.Transform.Transform(default(Point)), pose.Transform.Transform(new Point(100, 0)))
                - 100 * IslandBanbanHoldingArm.ArtworkScale) < 1e-8;
        }
        Check(anchors, "the supplied painted arm remains attached through carrying and lifting");
        Check(rigid, "the supplied hand and horn move rigidly without an added elbow or wrist bend");
        Check(unmirrored, "the supplied grip keeps its original handedness throughout the motion");
        Check(grasp && scale, "the complete painted grip retains its scale and registration");

        var previous = IslandBanbanHoldingArm.At(IslandBanbanHoldingArm.RaiseAt(0), 0, 0).Grip;
        var continuous = true;
        for (var frame = 1; frame <= 360; frame++)
        {
            var grip = IslandBanbanHoldingArm.At(IslandBanbanHoldingArm.RaiseAt(frame / 120d), 0, 0).Grip;
            continuous &= Distance(previous, grip) < 3; previous = grip;
        }
        Check(continuous, "the lift has no position jump between the carrying and speaking poses");
        var raised = IslandBanbanHoldingArm.At(1, 0, 0);
        Check(Distance(raised.Mouthpiece, new Point(310, 350)) < 12,
            "the raised megaphone mouthpiece reaches the mascot's mouth");
        Check(raised == IslandBanbanHoldingArm.At(1, 1, -1) && raised == IslandBanbanHoldingArm.At(1, 1, 1),
            "the settled speaking pose no longer inherits the running hand swing");
        return checks;
    }
}

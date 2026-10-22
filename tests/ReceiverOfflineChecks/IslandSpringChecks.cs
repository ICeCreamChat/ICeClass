using ICeClass.Receiver;

internal static class IslandSpringChecks
{
    public static int Run()
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new Exception(description);
            ++checks; Console.WriteLine("PASS " + description);
        }
        var spring = new IslandSpring(); spring.Retarget(100);
        Check(spring.Value == 0 && spring.Velocity == 0, "spring starts from rest without an instant velocity jump");
        spring.Advance(.001);
        Check(spring.Value is > 0 and < .02, "spring accelerates gently in the first millisecond");
        spring.Advance(.1);
        var position = spring.Value; var velocity = spring.Velocity;
        spring.Retarget(0);
        Check(spring.Value == position && spring.Velocity == velocity && velocity > 0, "retargeting preserves both presentation position and velocity");
        spring.Advance(.00001);
        Check(spring.Velocity > 0 && Math.Abs(spring.Velocity - velocity) < 1, "reversal decelerates continuously rather than hitting a hard stop");
        spring.Advance(1);
        Check(spring.IsAtRest(.01, .1), "an interrupted spring settles at the new destination");

        double[] RunAt(int frames)
        {
            var model = new IslandSpring(); model.Retarget(240);
            for (var i = 0; i < frames; i++) model.Advance(.4 / frames);
            return [model.Value, model.Velocity];
        }
        var one = RunAt(1); var sixty = RunAt(24); var highRefresh = RunAt(48);
        Check(Math.Abs(one[0] - sixty[0]) < 1e-9 && Math.Abs(one[1] - highRefresh[1]) < 1e-9,
            "spring trajectory is identical at different refresh rates and after a stalled frame");
        spring.Snap(0); spring.Retarget(100); var previous = 0d; var monotonic = true;
        for (var i = 0; i < 120; i++)
        {
            spring.Advance(1d / 120); monotonic &= spring.Value >= previous && spring.Value <= 100; previous = spring.Value;
        }
        Check(monotonic, "ordinary expansion reaches its destination without distracting bounce");
        spring.Snap(37);
        Check(spring.Value == 37 && spring.Target == 37 && spring.Velocity == 0, "reduced motion and cancellation discard residual momentum");
        return checks;
    }
}

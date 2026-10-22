namespace ICeClass.Receiver;

// A critically damped spring: response controls the feel, not a fixed end time.
// The analytical solution stays stable across different refresh rates and stalls.
internal sealed class IslandSpring
{
    internal const double ResponseSeconds = .4;
    private static readonly double Frequency = 2 * Math.PI / ResponseSeconds;
    public double Value { get; private set; }
    public double Velocity { get; private set; }
    public double Target { get; private set; }

    public void Retarget(double target) => Target = target;

    public void Snap(double target)
    {
        Value = Target = target; Velocity = 0;
    }

    public void Advance(double seconds)
    {
        if (seconds <= 0) return;
        var displacement = Value - Target;
        var coefficient = Velocity + Frequency * displacement;
        var decay = Math.Exp(-Frequency * seconds);
        Value = Target + (displacement + coefficient * seconds) * decay;
        Velocity = (Velocity - Frequency * coefficient * seconds) * decay;
    }

    public bool IsAtRest(double distance, double speed) =>
        Math.Abs(Value - Target) <= distance && Math.Abs(Velocity) <= speed;
}

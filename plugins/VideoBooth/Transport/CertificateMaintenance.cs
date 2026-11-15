namespace ICeClass.VideoBooth.Transport;
public sealed record CertificatePreparationState(string Status, string Message, DateTimeOffset? NextAttempt = null);
public static class CertificateMaintenance
{
    public static bool NeedsRenewal(DateTimeOffset notBefore, DateTimeOffset expires, DateTimeOffset now)
    {
        var lifetime = expires - notBefore;
        return lifetime <= TimeSpan.Zero || now < notBefore || expires - now <= lifetime / 3;
    }
}

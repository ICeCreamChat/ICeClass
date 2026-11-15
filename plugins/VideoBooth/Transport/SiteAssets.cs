namespace ICeClass.VideoBooth.Transport;

public static class SiteAssets
{
    // Explicit asset list: HTTP requests never resolve filesystem paths.
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        "desktop.html", "desktop.js", "styles.css", "shared.js", "managed-review.js", "orientation.js",
        "phone.html", "phone.js", "public-peer.js", "fflate.js", "setup.html", "setup.js", "connect.html", "connect.js",
        "portal.html", "portal.js", "preparation-phone.html", "preparation-phone.js", "preparation-client.js",
        "preparation-loader.js", "preparation-progress.js", "phone-preparation-return.html",
        "phone-preparation-return.js", "phone-preparation-relay.js", "app-icon.png", "control-focus.css"
    };
    public static byte[]? Read(string file)
    {
        if (!Allowed.Contains(file)) return null;
        using var stream = typeof(SiteAssets).Assembly.GetManifestResourceStream("ICeClass.VideoBooth.Site." + file);
        if (stream is null) return null;
        using var output = new MemoryStream();
        stream.CopyTo(output);
        return output.ToArray();
    }
    public static string ContentType(string file) => Path.GetExtension(file) switch
    {
        ".css" => "text/css; charset=utf-8", ".js" => "text/javascript; charset=utf-8",
        ".png" => "image/png", _ => "text/html; charset=utf-8"
    };
}

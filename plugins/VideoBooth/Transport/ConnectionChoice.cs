using System.Net.Http.Json;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record OnlineServiceSettings(string Url);
public sealed record OnlineAvailability(string Product, bool Ready);
public sealed record ConnectionAssessment(string Preference, string Selected, string Recommended, bool HasWifi,
    bool HotspotAvailable, bool OnlineAvailable, string Message, DateTimeOffset CheckedAt, bool Switching = false);

public static class ConnectionChoice
{
    public static OnlineServiceSettings? ReadSettings(string directory)
    {
        var path = Path.Combine(directory, "online-service.json");
        if (!File.Exists(path)) return null;
        var settings = JsonSerializer.Deserialize<OnlineServiceSettings>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (settings is null) throw new InvalidDataException("联网连接服务地址尚未配置。");
        ValidateUrl(settings.Url);
        return settings;
    }

    public static void ValidateUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)
            || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "") throw new ArgumentException("联网连接服务需要 HTTPS 地址。");
    }

    public static async Task<bool> Probe(HttpClient http, string url, CancellationToken cancellation)
    {
        ValidateUrl(url);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            using var response = await http.GetAsync(url.TrimEnd('/') + "/availability", timeout.Token);
            if (!response.IsSuccessStatusCode) return false;
            var result = await response.Content.ReadFromJsonAsync<OnlineAvailability>(timeout.Token);
            return result is { Product: "VideoBooth Online", Ready: true };
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException) { return false; }
    }

    public static string Recommend(bool preparedNetwork, bool hotspotAvailable, bool hotspotFailed, bool onlineAvailable)
        => preparedNetwork && !hotspotFailed ? "prepared" : hotspotAvailable && !hotspotFailed ? "hotspot" : onlineAvailable ? "online" : "unavailable";
}

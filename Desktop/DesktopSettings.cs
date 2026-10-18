using System.Text.Json;
using System.Text;

namespace ICeClass.Desktop;

public sealed class DesktopSettings
{
    public const string DefaultEndpoint = "https://iceclass.icecreamchat.top";
    public string Endpoint { get; set; } = DefaultEndpoint;
    public bool CloseToTray { get; set; } = true;

    public static string NormalizeEndpoint(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            !(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)) ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
            uri.AbsolutePath is not ("" or "/"))
            throw new ArgumentException("请填写学校平台的 HTTPS 网址，例如 https://iceclass.icecreamchat.top。不要填写 API 地址。");
        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    public static bool SameOrigin(string endpoint, string address)
    {
        return Uri.TryCreate(endpoint, UriKind.Absolute, out var left) &&
            Uri.TryCreate(address, UriKind.Absolute, out var right) &&
            string.IsNullOrEmpty(right.UserInfo) && left.Scheme == right.Scheme &&
            left.IdnHost.Equals(right.IdnHost, StringComparison.OrdinalIgnoreCase) && left.Port == right.Port;
    }

    public static string ProfileDirectory(string dataDirectory, string endpoint)
    {
        var uri = new Uri(NormalizeEndpoint(endpoint));
        var name = $"{uri.Scheme}_{uri.IdnHost}_{uri.Port}";
        foreach (var character in Path.GetInvalidFileNameChars()) name = name.Replace(character, '_');
        return Path.Combine(dataDirectory, "Profiles", name);
    }

    public static DesktopSettings Load(string dataDirectory)
    {
        try
        {
            var result = JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(Path.Combine(dataDirectory, "settings.json")));
            if (result is not null) { result.Endpoint = NormalizeEndpoint(result.Endpoint); return result; }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { }
        return new DesktopSettings();
    }

    public void Save(string dataDirectory)
    {
        Endpoint = NormalizeEndpoint(Endpoint);
        Directory.CreateDirectory(dataDirectory);
        var path = Path.Combine(dataDirectory, "settings.json");
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this));
        File.Move(temporary, path, true);
    }
}

internal sealed record LaunchOptions(string DataDirectory, string? Endpoint, bool Review)
{
    internal string RestartArguments(bool preserveEndpoint = true)
    {
        var arguments = new List<string>();
        if (Review) { arguments.Add("--data-dir"); arguments.Add(DataDirectory); }
        if (preserveEndpoint && Endpoint is not null) { arguments.Add("--server"); arguments.Add(Endpoint); }
        return string.Join(" ", arguments.Select(QuoteArgument));
    }

    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder("\""); var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            result.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            result.Append(character); backslashes = 0;
        }
        return result.Append('\\', backslashes * 2).Append('"').ToString();
    }

    public static LaunchOptions Parse(string[] args)
    {
        string? endpoint = null, directory = null;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--server" && index + 1 < args.Length) endpoint = DesktopSettings.NormalizeEndpoint(args[++index]);
            else if (args[index] == "--data-dir" && index + 1 < args.Length) directory = Path.GetFullPath(args[++index]);
        }
        return new(directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Desktop"), endpoint, directory is not null);
    }
}

using System.Text.Json;
using System.Security.Cryptography;

namespace ICeClass.Receiver;

public sealed class ReceiverConfig
{
    public const string DefaultEndpoint = "https://iceclass.icecreamchat.top";
    public string Endpoint { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string DeviceToken { get; set; } = "";
    public string ClassId { get; set; } = "";
    public string ClassName { get; set; } = "";
    public string DeviceName { get; set; } = "教室电脑";
    public bool StartWithWindows { get; set; } = true;

    private static ReceiverConfigStore Store => new(AppContext.BaseDirectory,
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver"));

    public static string? TryLoadDefaultEndpoint()
    {
        foreach (var path in new[]
        {
            Path.Combine(AppContext.BaseDirectory, "cloud-url.txt"),
            Path.Combine(AppContext.BaseDirectory, "receiver-defaults.json"),
        })
        {
            try
            {
                if (!File.Exists(path)) continue;
                var value = path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                    ? JsonSerializer.Deserialize<ReceiverDefaults>(File.ReadAllText(path))?.Endpoint
                    : File.ReadAllText(path).Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
                var endpoint = NormalizeEndpoint(value ?? "");
                if (Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) &&
                    (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
                {
                    return endpoint;
                }
            }
            catch
            {
                // A malformed optional defaults file should fall back to the editable setup form.
            }
        }
        return DefaultEndpoint;
    }

    public static bool TryLoad(out ReceiverConfig config)
    {
        return Store.TryLoad(out config);
    }

    public static void Save(ReceiverConfig config, bool updateStartup = true)
    {
        Store.Save(config);
        if (updateStartup) StartupManager.SetEnabled(config);
    }

    public static string NormalizeEndpoint(string endpoint) => endpoint.Trim().TrimEnd('/');

    internal static ReceiverConfig ProtectedCopy(ReceiverConfig config) => new()
    {
        Endpoint = NormalizeEndpoint(config.Endpoint),
        DeviceId = config.DeviceId,
        DeviceToken = ProtectToken(config.DeviceToken),
        ClassId = config.ClassId,
        ClassName = config.ClassName,
        DeviceName = config.DeviceName,
        StartWithWindows = config.StartWithWindows,
    };

    internal static bool IsPreview(ReceiverConfig config) => Uri.TryCreate(config.Endpoint, UriKind.Absolute, out var uri) && uri.IsLoopback;

    internal static bool TryRead(string path, out ReceiverConfig config)
    {
        config = new ReceiverConfig();
        try
        {
            if (!File.Exists(path)) return false;
            var loaded = JsonSerializer.Deserialize<ReceiverConfig>(File.ReadAllText(path));
            if (loaded is null || string.IsNullOrWhiteSpace(loaded.DeviceId) ||
                !Uri.TryCreate(loaded.Endpoint, UriKind.Absolute, out var endpoint) ||
                !(endpoint.Scheme == Uri.UriSchemeHttps || (endpoint.Scheme == Uri.UriSchemeHttp && endpoint.IsLoopback))) return false;
            loaded.DeviceToken = UnprotectToken(loaded.DeviceToken);
            if (string.IsNullOrWhiteSpace(loaded.DeviceToken)) return false;
            config = loaded;
            return true;
        }
        catch { return false; }
    }

    private static string ProtectToken(string token)
    {
        if (!OperatingSystem.IsWindows() || token.StartsWith("dpapi:", StringComparison.Ordinal)) return token;
        var protectedBytes = ProtectedData.Protect(System.Text.Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        return "dpapi:" + Convert.ToBase64String(protectedBytes);
    }

    private static string UnprotectToken(string token)
    {
        if (string.IsNullOrWhiteSpace(token)) return "";
        if (!token.StartsWith("dpapi:", StringComparison.Ordinal)) return token;
        if (!OperatingSystem.IsWindows()) return "";
        try
        {
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(token[6..]), null, DataProtectionScope.CurrentUser);
            return System.Text.Encoding.UTF8.GetString(bytes);
        }
        catch
        {
            return "";
        }
    }

    private sealed class ReceiverDefaults
    {
        public string Endpoint { get; set; } = "";
    }
}

internal sealed class ReceiverConfigStore(string installationDirectory, string userDataDirectory)
{
    private static readonly object Sync = new();
    private string LegacyPath => Path.Combine(installationDirectory, "config.json");
    private string UserPath => Path.Combine(userDataDirectory, "config.json");

    public bool TryLoad(out ReceiverConfig config)
    {
        lock (Sync)
        {
            if (ReceiverConfig.TryRead(LegacyPath, out config))
            {
                // Local QA copies keep their separate configuration and never replace a real classroom's binding.
                if (ReceiverConfig.IsPreview(config)) return true;
                try
                {
                    Write(UserPath, config);
                    if (ReceiverConfig.TryRead(UserPath, out var verified) &&
                        verified.DeviceId == config.DeviceId && verified.DeviceToken == config.DeviceToken)
                        File.Delete(LegacyPath);
                }
                catch (Exception error) { AppLog.Error("Migrate classroom configuration failed; original retained", error); }
                return true;
            }
            return ReceiverConfig.TryRead(UserPath, out config) && !ReceiverConfig.IsPreview(config);
        }
    }

    public void Save(ReceiverConfig config)
    {
        lock (Sync)
            Write(ReceiverConfig.IsPreview(config) ? LegacyPath : UserPath, config);
    }

    private static void Write(string path, ReceiverConfig config)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        var persisted = ReceiverConfig.ProtectedCopy(config);
        var json = JsonSerializer.Serialize(persisted, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(temporary, json);
        File.Move(temporary, path, true);
    }
}

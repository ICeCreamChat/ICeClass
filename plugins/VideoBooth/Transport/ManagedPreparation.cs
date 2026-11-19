using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record PreparationServiceSettings(string Url, string? CameraDomain = null);
public sealed record PreparedDevice(string Id, string CameraHost, string Token);
public sealed record CertificateOrder(string Status, string? CertificatePem = null);
public sealed record PhoneCertificateRequest(string ServiceUrl, string Id, string Token, string PublicKeyPem,
    string CameraHost, string CsrPem, string Address, bool Registered);

/// <summary>The device's private key never leaves this computer; only public keys and CSRs are sent.</summary>
public sealed class ManagedPreparation
{
    private sealed record DeviceIdentity(string Id, string Token, string ServiceUrl, string? CameraHost = null);
    private sealed record PublishedAddress(string Address, DateTimeOffset PublishedAt);
    private readonly string directory;
    private readonly HttpClient http;
    private readonly Uri service;
    private readonly SemaphoreSlim addressUpdates = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static PreparationServiceSettings? ReadSettings(string applicationDirectory)
    {
        var path = Path.Combine(applicationDirectory, "preparation-service.json");
        if (!File.Exists(path)) return null;
        var settings = JsonSerializer.Deserialize<PreparationServiceSettings>(File.ReadAllText(path), Json)
            ?? throw new InvalidOperationException("自动准备服务地址不可用。");
        ValidateService(settings.Url);
        if (settings.CameraDomain is not null) ValidateCameraDomain(settings.CameraDomain);
        return settings;
    }

    public ManagedPreparation(string directory, string url, HttpClient http)
    {
        this.directory = Path.GetFullPath(directory);
        service = ValidateService(url);
        this.http = http;
    }

    private static Uri ValidateService(string url)
    {
        if (!Uri.TryCreate(url.TrimEnd('/') + "/", UriKind.Absolute, out var uri)
            || uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidOperationException("自动准备服务必须使用 HTTPS 地址。");
        return uri;
    }

    public static string ValidateCameraDomain(string value)
    {
        var domain = value.Trim().TrimEnd('.').ToLowerInvariant();
        if (Uri.CheckHostName(domain) != UriHostNameType.Dns || !domain.Contains('.') || domain.Length > 200
            || IPAddress.TryParse(domain, out _) || domain.EndsWith(".local", StringComparison.Ordinal))
            throw new InvalidOperationException("手机准备服务的域名不可用。");
        return domain;
    }

    public static string ReadPhoneHost(string directory, PreparationServiceSettings settings)
    {
        var identity = JsonSerializer.Deserialize<DeviceIdentity>(File.ReadAllText(Path.Combine(directory, "managed-preparation", "device.json")), Json)
            ?? throw new InvalidOperationException("本机准备资料尚未生成。");
        if (identity.ServiceUrl != ValidateService(settings.Url).AbsoluteUri)
            throw new InvalidOperationException("本机准备服务与成品不一致。");
        var host = "device-" + identity.Id + "." + ValidateCameraDomain(settings.CameraDomain ?? "");
        ValidateDevice(new(identity.Id, host, identity.Token));
        return host;
    }

    public async Task<PhoneCertificateRequest> CreatePhoneRequest(string cameraDomain, string address, CancellationToken cancellation = default)
    {
        cameraDomain = ValidateCameraDomain(cameraDomain);
        if (!IsLocalAddress(address) && address != "127.0.0.1") throw new ArgumentException("手机准备需要本地连接地址。");
        var privateDirectory = Path.Combine(directory, "managed-preparation");
        Directory.CreateDirectory(privateDirectory);
        using var operation = new FileStream(Path.Combine(privateDirectory, "preparation.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        var keyFile = Path.Combine(privateDirectory, "device-key.pem");
        using var key = RSA.Create(2048);
        if (File.Exists(keyFile)) key.ImportFromPem(await File.ReadAllTextAsync(keyFile, cancellation));
        else await AtomicWrite(keyFile, key.ExportPkcs8PrivateKeyPem(), cancellation);
        var deviceFile = Path.Combine(privateDirectory, "device.json");
        DeviceIdentity identity;
        if (File.Exists(deviceFile))
            identity = JsonSerializer.Deserialize<DeviceIdentity>(await File.ReadAllTextAsync(deviceFile, cancellation), Json)
                ?? throw new InvalidOperationException("本机准备信息无法读取。");
        else
        {
            identity = new(Guid.NewGuid().ToString("N"), Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(), service.AbsoluteUri);
            await AtomicWrite(deviceFile, JsonSerializer.Serialize(identity, Json), cancellation);
        }
        if (identity.ServiceUrl != service.AbsoluteUri)
            throw new InvalidOperationException("自动准备服务地址已改变，原有设备资料已保留。");
        var host = "device-" + identity.Id + "." + cameraDomain;
        ValidateDevice(new(identity.Id, host, identity.Token));
        if (identity.CameraHost is not null && identity.CameraHost != host)
            throw new InvalidOperationException("准备服务的设备域名已改变，原有资料已保留。");
        var request = new CertificateRequest("CN=" + host, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName(host);
        request.CertificateExtensions.Add(names.Build());
        return new(service.AbsoluteUri, identity.Id, identity.Token, key.ExportSubjectPublicKeyInfoPem(), host,
            request.CreateSigningRequestPem(), address, identity.CameraHost is not null);
    }

    public async Task AcceptPhoneCertificate(PhoneCertificateRequest request, string host, string pem, CancellationToken cancellation = default)
    {
        if (request.ServiceUrl != service.AbsoluteUri || request.CameraHost != host)
            throw new InvalidOperationException("手机返回的证书不属于这台电脑。");
        var privateDirectory = Path.Combine(directory, "managed-preparation");
        using var operation = new FileStream(Path.Combine(privateDirectory, "preparation.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        var deviceFile = Path.Combine(privateDirectory, "device.json");
        var identity = JsonSerializer.Deserialize<DeviceIdentity>(await File.ReadAllTextAsync(deviceFile, cancellation), Json)
            ?? throw new InvalidOperationException("本机准备信息无法读取。");
        if (identity.Id != request.Id || identity.Token != request.Token || identity.ServiceUrl != request.ServiceUrl)
            throw new InvalidOperationException("本机准备资料已改变，请重新扫码。");
        using var key = RSA.Create();
        key.ImportFromPem(await File.ReadAllTextAsync(Path.Combine(privateDirectory, "device-key.pem"), cancellation));
        if (key.ExportSubjectPublicKeyInfoPem() != request.PublicKeyPem)
            throw new InvalidOperationException("本机私钥已改变，请重新扫码。");
        await InstallCertificate(directory, host, key, pem, cancellation);
        await AtomicWrite(deviceFile, JsonSerializer.Serialize(identity with { CameraHost = host }, Json), cancellation);
        if (IsLocalAddress(request.Address))
            await AtomicWrite(Path.Combine(privateDirectory, "connection-address.json"),
                JsonSerializer.Serialize(new PublishedAddress(request.Address, DateTimeOffset.UtcNow), Json), cancellation);
    }

    public async Task Prepare(Action<string> progress, CancellationToken cancellation)
    {
        var privateDirectory = Path.Combine(directory, "managed-preparation");
        Directory.CreateDirectory(privateDirectory);
        // Serialize processes sharing a data folder before creating a device identity.
        using var operation = new FileStream(Path.Combine(privateDirectory, "preparation.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        var keyFile = Path.Combine(privateDirectory, "device-key.pem");
        using var key = RSA.Create(2048);
        if (File.Exists(keyFile)) key.ImportFromPem(await File.ReadAllTextAsync(keyFile, cancellation));
        else await AtomicWrite(keyFile, key.ExportPkcs8PrivateKeyPem(), cancellation);
        var deviceFile = Path.Combine(privateDirectory, "device.json");
        DeviceIdentity identity;
        if (File.Exists(deviceFile))
            identity = JsonSerializer.Deserialize<DeviceIdentity>(await File.ReadAllTextAsync(deviceFile, cancellation), Json)
                ?? throw new InvalidOperationException("本机准备信息无法读取。");
        else
        {
            identity = new(Guid.NewGuid().ToString("N"), Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(), service.AbsoluteUri);
            // Save before contacting the service so a lost enrolment response can be retried.
            await AtomicWrite(deviceFile, JsonSerializer.Serialize(identity, Json), cancellation);
        }
        if (identity.ServiceUrl != service.AbsoluteUri)
            throw new InvalidOperationException("自动准备服务地址已改变，原有设备资料已保留，请联系软件提供方。");
        PreparedDevice device;
        if (identity.CameraHost is null)
        {
            progress("正在为这台电脑自动准备连接地址…");
            using var response = await http.PostAsJsonAsync(new Uri(service, "api/devices"),
                new { identity.Id, identity.Token, publicKeyPem = key.ExportSubjectPublicKeyInfoPem() }, cancellation);
            response.EnsureSuccessStatusCode();
            device = await response.Content.ReadFromJsonAsync<PreparedDevice>(Json, cancellation)
                ?? throw new InvalidOperationException("准备服务没有返回设备地址。");
            ValidateDevice(device);
            if (device.Id != identity.Id || device.Token != identity.Token)
                throw new InvalidOperationException("自动准备结果不属于这台电脑。");
            identity = identity with { CameraHost = device.CameraHost };
            await AtomicWrite(deviceFile, JsonSerializer.Serialize(identity, Json), cancellation);
        }
        else device = new(identity.Id, identity.CameraHost, identity.Token);
        ValidateDevice(device);
        progress("正在自动办理手机浏览器连接所需的证书…");
        var request = new CertificateRequest("CN=" + device.CameraHost, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName(device.CameraHost);
        request.CertificateExtensions.Add(names.Build());
        using var orderRequest = new HttpRequestMessage(HttpMethod.Post, new Uri(service, "api/devices/" + device.Id + "/certificate"));
        orderRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", device.Token);
        orderRequest.Content = JsonContent.Create(new { csrPem = request.CreateSigningRequestPem() });
        using var start = await http.SendAsync(orderRequest, cancellation);
        start.EnsureSuccessStatusCode();
        var result = await start.Content.ReadFromJsonAsync<CertificateOrder>(Json, cancellation)
            ?? throw new InvalidOperationException("自动证书申请没有返回结果。");
        for (var attempt = 0; result.Status == "pending" && attempt < 120; attempt++)
        {
            await Task.Delay(TimeSpan.FromSeconds(3), cancellation);
            using var poll = new HttpRequestMessage(HttpMethod.Get, new Uri(service, "api/devices/" + device.Id + "/certificate"));
            poll.Headers.Authorization = new AuthenticationHeaderValue("Bearer", device.Token);
            using var response = await http.SendAsync(poll, cancellation);
            response.EnsureSuccessStatusCode();
            result = await response.Content.ReadFromJsonAsync<CertificateOrder>(Json, cancellation)
                ?? throw new InvalidOperationException("自动准备结果无法读取。");
        }
        if (result.Status != "ready" || string.IsNullOrWhiteSpace(result.CertificatePem))
            throw new InvalidOperationException("自动证书准备暂时未完成，请稍后重试。");
        progress("正在保存本机证书并检查手机连接…");
        await InstallCertificate(directory, device.CameraHost, key, result.CertificatePem, cancellation);
    }

    private static void ValidateDevice(PreparedDevice device)
    {
        if (device.Id is null || device.Id.Length != 32 || device.Id.Any(c => !Uri.IsHexDigit(c))
            || device.Token is null || device.Token.Length != 64 || device.Token.Any(c => !Uri.IsHexDigit(c))
            || device.CameraHost is null || Uri.CheckHostName(device.CameraHost) != UriHostNameType.Dns || !device.CameraHost.Contains('.')
            || IPAddress.TryParse(device.CameraHost, out _) || device.CameraHost.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("自动准备服务返回的设备信息不完整。");
    }

    public static async Task InstallCertificate(string directory, string host, RSA key, string pem, CancellationToken cancellation = default)
    {
        var chain = new X509Certificate2Collection();
        X509Certificate2? privateLeaf = null;
        try
        {
            chain.ImportFromPem(pem);
            if (chain.Count is < 2 or > 8) throw new InvalidOperationException("准备服务未提供完整证书链。");
            var leaves = chain.Cast<X509Certificate2>().Where(c => c.MatchesHostname(host, allowWildcards: false, allowCommonName: false)).ToArray();
            if (leaves.Length != 1) throw new InvalidOperationException("准备服务返回了其他设备的证书。");
            privateLeaf = leaves[0].CopyWithPrivateKey(key);
            chain.Remove(leaves[0]);
            leaves[0].Dispose();
            chain.Insert(0, privateLeaf);
            var password = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
            var storage = Path.Combine(directory, "provisioning", "certificate-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(storage);
            await File.WriteAllBytesAsync(Path.Combine(storage, "server.pfx"), chain.Export(X509ContentType.Pkcs12, password)!, cancellation);
            await File.WriteAllTextAsync(Path.Combine(storage, "password.txt"), password, cancellation);
            await AtomicWrite(Path.Combine(storage, "offline-endpoint.json"), JsonSerializer.Serialize(new
                { cameraHost = host, certificateFile = "server.pfx", passwordFile = "password.txt" }, Json), cancellation);
            using (var endpoint = TrustedEndpoint.Load(storage))
                if (!endpoint.IsReady) throw new InvalidOperationException(endpoint.Error ?? "新的手机连接证书未通过验证。");
            await AtomicWrite(Path.Combine(directory, "offline-endpoint.json"), JsonSerializer.Serialize(new
            {
                cameraHost = host,
                certificateFile = Path.GetRelativePath(directory, Path.Combine(storage, "server.pfx")),
                passwordFile = Path.GetRelativePath(directory, Path.Combine(storage, "password.txt"))
            }, Json), cancellation);
        }
        finally { foreach (var certificate in chain) certificate.Dispose(); }
    }

    public static bool IsLocalAddress(string? value)
    {
        if (!IPAddress.TryParse(value, out var address) || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 || bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 192 && bytes[1] == 168;
    }

    public bool HasPublishedAddress(string address)
    {
        var path = Path.Combine(directory, "managed-preparation", "connection-address.json");
        if (!File.Exists(path)) return false;
        try { return JsonSerializer.Deserialize<PublishedAddress>(File.ReadAllText(path), Json)?.Address == address; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return false; }
    }

    public async Task UpdateAddress(string host, string address, CancellationToken cancellation)
    {
        if (!IsLocalAddress(address)) throw new ArgumentException("手机连接需要本地 IPv4 地址。");
        if (!await addressUpdates.WaitAsync(0, cancellation)) return;
        try
        {
            var privateDirectory = Path.Combine(directory, "managed-preparation");
            var deviceFile = Path.Combine(privateDirectory, "device.json");
            if (!File.Exists(deviceFile)) return;
            var device = JsonSerializer.Deserialize<DeviceIdentity>(await File.ReadAllTextAsync(deviceFile, cancellation), Json);
            // Keep working legacy certificates independent until automatic renewal switches them.
            if (device is null || device.ServiceUrl != service.AbsoluteUri || device.CameraHost != host) return;
            address = IPAddress.Parse(address).ToString();
            var stateFile = Path.Combine(privateDirectory, "connection-address.json");
            if (File.Exists(stateFile))
            {
                var published = JsonSerializer.Deserialize<PublishedAddress>(await File.ReadAllTextAsync(stateFile, cancellation), Json);
                if (published?.Address == address && DateTimeOffset.UtcNow - published.PublishedAt < TimeSpan.FromDays(1)) return;
            }
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(service, "api/devices/" + device.Id + "/connection"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", device.Token);
            request.Content = JsonContent.Create(new { address });
            using var response = await http.SendAsync(request, cancellation);
            response.EnsureSuccessStatusCode();
            await AtomicWrite(stateFile, JsonSerializer.Serialize(new PublishedAddress(address, DateTimeOffset.UtcNow), Json), cancellation);
        }
        finally { addressUpdates.Release(); }
    }

    private static async Task AtomicWrite(string path, string content, CancellationToken cancellation)
    {
        await File.WriteAllTextAsync(path + ".tmp", content, cancellation);
        File.Move(path + ".tmp", path, overwrite: true);
    }
}

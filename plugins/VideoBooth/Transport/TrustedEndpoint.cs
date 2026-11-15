using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

/// <summary>
/// An administrator-prepared domain endpoint. No certificate is issued, trusted,
/// or installed by this class. The PFX must belong to this computer's deployment.
/// </summary>
public sealed class TrustedEndpoint : IDisposable
{
    private readonly X509Certificate2Collection certificates = [];
    private bool disposed;
    private string? error;

    public bool IsConfigured { get; private set; }
    public bool IsReady
    {
        get
        {
            var now = DateTime.UtcNow;
            return !disposed && CertificateContext is not null && ServerCertificate is { } certificate
                && certificate.NotBefore.ToUniversalTime() <= now && now < certificate.NotAfter.ToUniversalTime();
        }
    }
    public string? CameraHost { get; private set; }
    public string? Error
    {
        get
        {
            if (error is not null) return error;
            if (!disposed && ServerCertificate is { } certificate)
            {
                var now = DateTime.UtcNow;
                if (certificate.NotBefore.ToUniversalTime() > now || certificate.NotAfter.ToUniversalTime() <= now)
                    return "服务器证书尚未生效或已过期，请由管理员更新证书。";
            }
            return null;
        }
        private set => error = value;
    }
    public X509Certificate2? ServerCertificate { get; private set; }
    public SslStreamCertificateContext? CertificateContext { get; private set; }

    private sealed record Settings(string? CameraHost = null, string? CertificateFile = null, string? PasswordFile = null);

    public static TrustedEndpoint Load(string dataDirectory)
    {
        var result = new TrustedEndpoint();
        var path = Path.Combine(dataDirectory, "offline-endpoint.json");
        if (!File.Exists(path))
        {
            result.Error = "尚未准备免安装证书的连接：管理员需要配置本地域名和公开受信的服务器证书。";
            return result;
        }

        result.IsConfigured = true;
        try
        {
            var settings = JsonSerializer.Deserialize<Settings>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("offline-endpoint.json 内容为空。");
            result.CameraHost = NormalizeHost(settings.CameraHost);
            if (string.IsNullOrWhiteSpace(settings.CertificateFile))
                throw new InvalidOperationException("未配置 certificateFile；需要含服务器私钥和完整中间链的 PFX。 ");
            string? password = null;
            if (!string.IsNullOrWhiteSpace(settings.PasswordFile))
                password = File.ReadAllText(ResolveFile(dataDirectory, settings.PasswordFile)).TrimEnd('\r', '\n');

            // Schannel needs a temporary user key container. It is removed on disposal.
            result.certificates.AddRange(X509CertificateLoader.LoadPkcs12CollectionFromFile(
                ResolveFile(dataDirectory, settings.CertificateFile), password, X509KeyStorageFlags.UserKeySet));
            var matches = result.certificates.Cast<X509Certificate2>()
                .Where(certificate => certificate.HasPrivateKey && certificate.MatchesHostname(result.CameraHost, allowWildcards: true, allowCommonName: false)).ToArray();
            if (matches.Length != 1)
                throw new InvalidOperationException("PFX 必须恰好包含一份与 cameraHost 的 SAN 匹配、并带私钥的服务器证书。");

            var leaf = matches[0];
            ValidateLeaf(leaf);
            using var chain = new X509Chain();
            chain.ChainPolicy.DisableCertificateDownloads = true;
            // This is a local configuration check, not a client TLS validation policy.
            // Phone browsers independently enforce trust, CT, and revocation checks.
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
            chain.ChainPolicy.ExtraStore.AddRange(result.certificates);
            if (!chain.Build(leaf))
                throw new InvalidOperationException("服务器证书无法使用本机系统根证书完成离线验证。请检查受信 CA、有效期和 PFX 中间链；不能用自签证书替代。");

            var intermediates = new X509Certificate2Collection();
            // Require the PFX to carry every intermediate instead of accidentally
            // succeeding only because this PC has an intermediate cached already.
            for (var i = 1; i < chain.ChainElements.Count - 1; i++)
            {
                var needed = chain.ChainElements[i].Certificate;
                var included = result.certificates.Cast<X509Certificate2>().FirstOrDefault(certificate => certificate.RawData.AsSpan().SequenceEqual(needed.RawData));
                if (included is null)
                    throw new InvalidOperationException("PFX 缺少完整中间证书链，陌生手机首次离线无法补下载证书。");
                intermediates.Add(included);
            }

            result.ServerCertificate = leaf;
            result.CertificateContext = SslStreamCertificateContext.Create(leaf, intermediates, offline: true);
            return result;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or CryptographicException or InvalidOperationException or ArgumentException)
        {
            result.Error = error switch
            {
                InvalidOperationException => error.Message,
                JsonException => "offline-endpoint.json 格式错误，请由管理员检查配置。",
                CryptographicException => "无法读取或使用服务器 PFX，请检查证书文件、私钥和密码文件。",
                _ => "无法读取离线证书配置，请由管理员检查域名、文件路径和访问权限。"
            };
            result.ReleaseCertificates();
            return result;
        }
    }

    public bool MatchesHost(string? host) => IsReady && string.Equals(CameraHost, host?.TrimEnd('.'), StringComparison.OrdinalIgnoreCase);

    private static string ResolveFile(string directory, string file) => Path.GetFullPath(Path.IsPathRooted(file) ? file : Path.Combine(directory, file));

    private static string NormalizeHost(string? host)
    {
        if (string.IsNullOrWhiteSpace(host)) throw new InvalidOperationException("未配置 cameraHost 公网注册域名。");
        host = new IdnMapping().GetAscii(host.Trim().TrimEnd('.')).ToLowerInvariant();
        if (Uri.CheckHostName(host) != UriHostNameType.Dns || IPAddress.TryParse(host, out _) || !host.Contains('.') ||
            host.EndsWith(".localhost", StringComparison.Ordinal) || host.EndsWith(".local", StringComparison.Ordinal))
            throw new InvalidOperationException("cameraHost 必须是自己拥有的公网注册域名，不是 IP、localhost、.local 或带端口的网址。");
        return host;
    }

    private static void ValidateLeaf(X509Certificate2 certificate)
    {
        if (certificate.SubjectName.RawData.AsSpan().SequenceEqual(certificate.IssuerName.RawData))
            throw new InvalidOperationException("免安装证书模式不能使用自签服务器证书。");
        var now = DateTime.UtcNow;
        if (certificate.NotBefore.ToUniversalTime() > now || certificate.NotAfter.ToUniversalTime() <= now)
            throw new InvalidOperationException("服务器证书尚未生效或已过期，请由管理员更新证书。");
        var usages = certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().ToArray();
        if (usages.Length == 0 || !usages.Any(usage => usage.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == "1.3.6.1.5.5.7.3.1")))
            throw new InvalidOperationException("证书未声明 TLS 服务器用途（Server Authentication）。");
        var constraints = certificate.Extensions.OfType<X509BasicConstraintsExtension>().FirstOrDefault();
        if (constraints?.CertificateAuthority == true)
            throw new InvalidOperationException("需要服务器叶证书，不能直接使用 CA 证书。");
        using var rsa = certificate.GetRSAPrivateKey();
        using var ecdsa = certificate.GetECDsaPrivateKey();
        if (rsa is null && ecdsa is null)
            throw new InvalidOperationException("服务器证书必须带有可用于 TLS 的 RSA 或 ECDSA 私钥。");
    }

    private void ReleaseCertificates()
    {
        CertificateContext = null;
        ServerCertificate = null;
        foreach (var certificate in certificates) certificate.Dispose();
        certificates.Clear();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        ReleaseCertificates();
    }
}

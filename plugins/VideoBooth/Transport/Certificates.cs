using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace ICeClass.VideoBooth.Transport;

public sealed class Certificates : IDisposable
{
    private readonly object sync = new();
    private readonly List<X509Certificate2> retiredServers = [];
    private IPAddress[] serverAddresses = [];
    private X509Certificate2? server;
    private bool disposed;

    public X509Certificate2 Authority { get; }
    public X509Certificate2 Server
    {
        get
        {
            lock (sync)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                return server!;
            }
        }
    }
    public byte[] PublicCertificate => Authority.Export(X509ContentType.Cert);

    public Certificates(string dataDirectory, IEnumerable<IPAddress> addresses)
    {
        Directory.CreateDirectory(dataDirectory);
        var path = Path.Combine(dataDirectory, "authority.pfx");
        if (File.Exists(path))
            Authority = X509CertificateLoader.LoadPkcs12FromFile(path, null, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
        else
        {
            using var rsa = RSA.Create(3072);
            var request = new CertificateRequest("CN=VideoBooth " + Guid.NewGuid().ToString("N")[..8], rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
            request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
            using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-10), DateTimeOffset.UtcNow.AddYears(5));
            var bytes = created.Export(X509ContentType.Pfx);
            File.WriteAllBytes(path, bytes);
            Authority = X509CertificateLoader.LoadPkcs12(bytes, null, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
        }
        if (Authority.NotAfter.ToUniversalTime() <= DateTime.UtcNow.AddDays(1))
            throw new InvalidOperationException("展台证书已经过期。请备份 data 文件夹后删除 authority.pfx，重启程序，并在手机上重新设置新证书。");

        RefreshAddresses(addresses);
    }

    // Existing TLS connections may still be using the old leaf after an address change.
    // Keep it alive until the listener has stopped and this owner is disposed.
    public bool RefreshAddresses(IEnumerable<IPAddress> addresses)
    {
        var updated = addresses.Append(IPAddress.Loopback).Distinct().OrderBy(address => address.ToString(), StringComparer.Ordinal).ToArray();
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (server is not null && updated.SequenceEqual(serverAddresses)) return false;
            var replacement = CreateServer(updated);
            if (server is not null) retiredServers.Add(server);
            server = replacement;
            serverAddresses = updated;
            return true;
        }
    }

    // WebView may report a completed handshake after a concurrent SAN refresh.
    // Only the exact leaves owned by this server qualify; callers still require
    // the loopback URL and the listener's port before allowing an error.
    public bool MatchesServerCertificatePem(string pem)
    {
        lock (sync)
        {
            if (disposed) return false;
            var presented = pem.Trim();
            return server?.ExportCertificatePem().Trim() == presented
                || retiredServers.Any(certificate => certificate.ExportCertificatePem().Trim() == presented);
        }
    }

    private X509Certificate2 CreateServer(IEnumerable<IPAddress> addresses)
    {
        using var serverKey = RSA.Create(2048);
        var leaf = new CertificateRequest("CN=VideoBooth local camera", serverKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        leaf.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        leaf.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        leaf.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false));
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName("localhost");
        foreach (var address in addresses) names.AddIpAddress(address);
        leaf.CertificateExtensions.Add(names.Build());
        var expiry = DateTimeOffset.UtcNow.AddDays(90);
        var authorityExpiry = new DateTimeOffset(Authority.NotAfter.ToUniversalTime()).AddMinutes(-1);
        if (expiry > authorityExpiry) expiry = authorityExpiry;
        using var signed = leaf.Create(Authority, DateTimeOffset.UtcNow.AddMinutes(-5), expiry, RandomNumberGenerator.GetBytes(16));
        using var keyed = signed.CopyWithPrivateKey(serverKey);
        // Windows Schannel cannot serve TLS with an ephemeral private key.
        // A temporary current-user key container is cleaned up on disposal.
        return X509CertificateLoader.LoadPkcs12(keyed.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    }

    public byte[] AppleProfile()
    {
        var uuid = Guid.NewGuid().ToString();
        var certificate = Convert.ToBase64String(PublicCertificate);
        return Encoding.UTF8.GetBytes($"""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
            <key>PayloadContent</key><array><dict>
            <key>PayloadCertificateFileName</key><string>VideoBooth.crt</string>
            <key>PayloadContent</key><data>{certificate}</data>
            <key>PayloadDescription</key><string>用于离线访问此视频展台的摄像头连接页面。</string>
            <key>PayloadDisplayName</key><string>视频展台证书</string>
            <key>PayloadIdentifier</key><string>local.videobooth.certificate.{uuid}</string>
            <key>PayloadType</key><string>com.apple.security.root</string>
            <key>PayloadUUID</key><string>{uuid}</string><key>PayloadVersion</key><integer>1</integer>
            </dict></array>
            <key>PayloadDisplayName</key><string>视频展台</string>
            <key>PayloadDescription</key><string>安装后还需在设置、通用、关于本机、证书信任设置中启用信任。仅用于自己的视频展台。</string>
            <key>PayloadIdentifier</key><string>local.videobooth.profile.{uuid}</string>
            <key>PayloadType</key><string>Configuration</string>
            <key>PayloadUUID</key><string>{Guid.NewGuid()}</string><key>PayloadVersion</key><integer>1</integer>
            </dict></plist>
            """);
    }

    public void Dispose()
    {
        lock (sync)
        {
            if (disposed) return;
            disposed = true;
            server?.Dispose();
            foreach (var retired in retiredServers) retired.Dispose();
            Authority.Dispose();
        }
    }
}

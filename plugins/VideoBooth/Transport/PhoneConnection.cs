using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record PreparedWifi(string Ssid, string Passphrase, string Address, string DnsServer);
public sealed record PhoneConnectionState(string Status, string? Ssid, bool Ready, bool Joined, string? Error);
public sealed record PhoneBrowserReport(string Stage, bool SecureContext, bool CameraApi, bool WebRtc, string? ErrorName = null);
public sealed record PhoneBrowserState(string Browser, PhoneBrowserReport Report, DateTimeOffset UpdatedAt, bool LocalComputer = false);
public sealed record PhoneNetworkObservation(DateTimeOffset? LocalHttpAt = null, DateTimeOffset? CameraDnsAt = null, DateTimeOffset? TrustedTlsAt = null, DateTimeOffset? CameraHttpsAt = null,
    DateTimeOffset? HttpsTcpAt = null, DateTimeOffset? TlsHelloAt = null, DateTimeOffset? PhonePageAt = null);

/// <summary>State for the two scans. Network and certificate provisioning belong to the equipment owner.</summary>
public sealed class PhoneConnection
{
    private readonly object sync = new();
    private PhoneConnectionState state = new("idle", null, false, false, null);
    private string? passphrase;
    private PhoneBrowserState? browser;
    private PhoneNetworkObservation network = new();
    public bool Ready { get { lock (sync) return state.Ready; } }
    public PhoneConnectionState Diagnostics { get { lock (sync) return state; } }
    public PhoneBrowserState? Browser { get { lock (sync) return browser; } }
    public PhoneNetworkObservation Network { get { lock (sync) return network; } }

    public void ReportNetworkStep(string step)
    {
        lock (sync)
        {
            var now = DateTimeOffset.UtcNow;
            network = step switch
            {
                "local-http" => network with { LocalHttpAt = now },
                "camera-dns" => network with { CameraDnsAt = now },
                "trusted-tls" => network with { TrustedTlsAt = now },
                "camera-https" => network with { CameraHttpsAt = now },
                "https-tcp" => network with { HttpsTcpAt = now },
                "tls-hello" => network with { TlsHelloAt = now },
                "phone-page" => network with { PhonePageAt = now },
                _ => network
            };
        }
    }

    // Local troubleshooting only: no images, raw user agent, or persistent device identifiers.
    public bool ReportBrowser(string userAgent, PhoneBrowserReport report, bool localComputer = false)
    {
        if (report.Stage is not ("entry" or "connect-error" or "phone-opened" or "unsupported"
            or "camera-requested" or "camera-ready" or "camera-error" or "live" or "transport-error" or "stopped" or "background")) return false;
        var error = report.ErrorName is "NotAllowedError" or "SecurityError" or "NotFoundError" or "NotReadableError"
            or "OverconstrainedError" or "CameraUnavailableError" or "WebRtcUnavailableError" or "InsecureContextError" ? report.ErrorName : null;
        lock (sync) browser = new(localComputer ? "电脑本机浏览器" : userAgent.Contains("MicroMessenger", StringComparison.OrdinalIgnoreCase) ? "微信" : "手机浏览器",
            report with { ErrorName = error }, DateTimeOffset.UtcNow, localComputer);
        return true;
    }

    public void ResetBrowser() { lock (sync) { browser = null; network = new(); } }

    public void Set(string status, string? ssid = null, string? password = null, bool ready = false, bool joined = false, string? error = null)
    {
        lock (sync)
        {
            state = new(status, ssid, ready, joined, error);
            passphrase = password;
        }
    }

    public void ConfirmBrowserConnection(bool localComputer = false)
    {
        lock (sync)
            if (!localComputer && state.Status == "waiting-phone") state = state with { Status = "ready", Ready = true, Joined = true, Error = null };
    }

    public static bool IsComputerBrowser(IPAddress? remoteAddress, IEnumerable<NetworkChoice> networks)
    {
        if (remoteAddress is null) return true;
        if (remoteAddress.IsIPv4MappedToIPv6) remoteAddress = remoteAddress.MapToIPv4();
        return IPAddress.IsLoopback(remoteAddress)
            || networks.Any(network => IPAddress.TryParse(network.Address, out var local) && local.Equals(remoteAddress));
    }

    public PhoneConnectionState Snapshot(TrustedEndpoint certificate)
    {
        lock (sync)
            return certificate.IsReady ? state : state with { Status = "needs-preparation", Ready = false,
                Error = "请让电脑临时联网，软件会自动准备手机连接。准备好后会显示二维码。" };
    }

    public string? WifiPayload()
    {
        lock (sync)
            return (state.Ready || state.Status is "running" or "needs-dns" or "waiting-phone") && state.Ssid is not null && passphrase is not null
                ? $"WIFI:T:WPA;S:{Escape(state.Ssid)};P:{Escape(passphrase)};;" : null;
    }

    private static string Escape(string value) => value.Replace("\\", "\\\\").Replace(";", "\\;").Replace(",", "\\,").Replace(":", "\\:").Replace("\"", "\\\"");

    public static PreparedWifi? ReadPreparedWifi(string directory)
    {
        var path = Path.Combine(directory, "wifi-connection.json");
        if (!File.Exists(path)) return null;
        var result = JsonSerializer.Deserialize<PreparedWifi>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (result is null || string.IsNullOrWhiteSpace(result.Ssid) || Encoding.UTF8.GetByteCount(result.Ssid) > 32
            || result.Passphrase is null || result.Passphrase.Length is < 8 or > 63 || result.Passphrase.Any(c => c is < ' ' or > '~')
            || !IPAddress.TryParse(result.Address, out var address) || address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address)
            || !IPAddress.TryParse(result.DnsServer, out _))
            throw new InvalidOperationException("设备端 Wi-Fi 准备信息不完整，请检查 wifi-connection.json。");
        return result;
    }

    public static async Task<bool> ResolvesLocally(string host, string dnsServer, string address, CancellationToken cancellation = default, int port = 53)
    {
        var labels = host.TrimEnd('.').Split('.');
        if (labels.Any(label => label.Length is < 1 or > 63) || host.Length > 253) return false;
        using var packet = new MemoryStream();
        var id = RandomNumberGenerator.GetBytes(2);
        packet.Write(id);
        packet.Write([1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        foreach (var label in labels) { var bytes = Encoding.ASCII.GetBytes(label); packet.WriteByte((byte)bytes.Length); packet.Write(bytes); }
        packet.Write([0, 0, 1, 0, 1]);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            using var udp = new UdpClient(IPAddress.Parse(dnsServer).AddressFamily);
            udp.Connect(dnsServer, port);
            await udp.SendAsync(packet.ToArray(), timeout.Token);
            var response = (await udp.ReceiveAsync(timeout.Token)).Buffer;
            return ContainsAnswer(response, id, IPAddress.Parse(address));
        }
        catch (Exception error) when (error is SocketException or OperationCanceledException) { return false; }
    }

    private static bool ContainsAnswer(byte[] bytes, byte[] id, IPAddress expected)
    {
        if (bytes.Length < 12 || bytes[0] != id[0] || bytes[1] != id[1] || (bytes[2] & 0x82) != 0x80 || (bytes[3] & 15) != 0) return false;
        var questions = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(4));
        var answers = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(6));
        var position = 12;
        bool SkipName()
        {
            for (var labels = 0; labels < 128 && position < bytes.Length; labels++)
            {
                var size = bytes[position++];
                if (size == 0) return true;
                if ((size & 0xc0) == 0xc0) { if (position >= bytes.Length) return false; position++; return true; }
                if (size > 63 || position + size > bytes.Length) return false;
                position += size;
            }
            return false;
        }
        for (var i = 0; i < questions; i++) { if (!SkipName() || position + 4 > bytes.Length) return false; position += 4; }
        var addresses = new List<IPAddress>();
        for (var i = 0; i < answers; i++)
        {
            if (!SkipName() || position + 10 > bytes.Length) return false;
            var type = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position));
            var klass = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position + 2));
            var size = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(position + 8));
            position += 10;
            if (position + size > bytes.Length) return false;
            if (type == 1 && klass == 1 && size == 4) addresses.Add(new IPAddress(bytes.AsSpan(position, size)));
            position += size;
        }
        return addresses.Count > 0 && addresses.All(value => value.Equals(expected));
    }
}

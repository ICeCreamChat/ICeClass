using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record CameraPortalSettings(string Url);
public sealed record CameraDescription(string Type, string Sdp);
public sealed record CameraOffer(string Generation, CameraDescription Offer);

/// <summary>A public static camera page, with signaling and video kept on the local network.</summary>
public sealed class PublicPhonePairing
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly object sync = new();
    private byte[]? key;
    private string? nonce, acceptedPayload;
    private CameraDescription? answer;
    public Uri? Portal { get; }
    public string? Error { get; }
    private string generation = BoothServer.Secret();
    private string? joinUrl;
    public string Generation { get { lock (sync) return generation; } }
    public string? JoinUrl { get { lock (sync) return joinUrl; } }

    public PublicPhonePairing(string directory)
    {
        var path = Path.Combine(directory, "phone-portal.json");
        if (!File.Exists(path)) return;
        try
        {
            var settings = JsonSerializer.Deserialize<CameraPortalSettings>(File.ReadAllText(path), Json);
            if (settings is null || !Uri.TryCreate(settings.Url, UriKind.Absolute, out var uri)
                || uri.Scheme != "https" || uri.HostNameType != UriHostNameType.Dns
                || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
                throw new ArgumentException("手机入口应是可信 HTTPS 网页地址。请检查 phone-portal.json。");
            Portal = uri;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        { Error = error.Message; }
    }

    public void Reset()
    {
        lock (sync)
        {
            if (key is not null) CryptographicOperations.ZeroMemory(key);
            key = null; nonce = null; answer = null; acceptedPayload = null; joinUrl = null;
            generation = BoothServer.Secret();
        }
    }

    public string Prepare(CameraOffer request, string address, int port)
    {
        ValidateDescription(request.Offer, "offer");
        if (!IPAddress.TryParse(address, out _) || port is < 1 or > 65535 || Portal is null)
            throw new ArgumentException("手机连接入口尚未准备完成。");
        lock (sync)
        {
            if (request.Generation != generation) throw new InvalidOperationException("连接地址已更新，请重新准备二维码。");
            var nextKey = RandomNumberGenerator.GetBytes(32);
            var nextNonce = BoothServer.Secret();
            var packed = JsonSerializer.SerializeToUtf8Bytes(new { v = 1, endpoint = $"http://{address}:{port}/pair-phone",
                nonce = nextNonce, key = Encode(nextKey), offer = request.Offer }, Json);
            var url = Portal.AbsoluteUri + "#pair=" + Encode(Compress(packed));
            // QR Model 2 at M correction accommodates 2331 bytes. Leave room for scanner differences.
            if (Encoding.UTF8.GetByteCount(url) > 2300)
                throw new ArgumentException("连接信息过长，无法生成易扫描的二维码。请关闭不使用的 VPN 或虚拟网络后重试。");
            if (key is not null) CryptographicOperations.ZeroMemory(key);
            key = nextKey; nonce = nextNonce; answer = null; acceptedPayload = null; joinUrl = url;
            return url;
        }
    }

    public CameraDescription? Answer(string expectedGeneration)
    {
        lock (sync) return generation == expectedGeneration ? answer : null;
    }

    public (int Status, string? Nonce) Accept(string payload, string signature)
    {
        if (payload.Length is < 1 or > 12000 || signature.Length != 43) return (400, null);
        lock (sync)
        {
            if (key is null || nonce is null) return (401, null);
            try
            {
                var actual = Decode(signature);
                var expected = HMACSHA256.HashData(key, Encoding.ASCII.GetBytes(payload));
                if (actual.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(actual, expected)) return (401, null);
                using var data = JsonDocument.Parse(Decompress(Decode(payload), 32768));
                if (data.RootElement.GetProperty("nonce").GetString() != nonce) return (401, null);
                var description = data.RootElement.GetProperty("answer").Deserialize<CameraDescription>(Json);
                if (description is null) return (400, null);
                ValidateDescription(description, "answer");
                if (acceptedPayload is not null && acceptedPayload != payload) return (409, null);
                acceptedPayload = payload; answer = description;
                return (200, nonce);
            }
            catch (Exception error) when (error is FormatException or JsonException or KeyNotFoundException
                or InvalidOperationException or ArgumentException or InvalidDataException or IOException)
            { return (400, null); }
        }
    }

    private static void ValidateDescription(CameraDescription description, string type)
    {
        if (description.Type != type || description.Sdp is null || description.Sdp.Length is < 50 or > 28000
            || !description.Sdp.StartsWith("v=0\r\n", StringComparison.Ordinal)
            || !description.Sdp.Contains("m=video ", StringComparison.Ordinal)
            || !description.Sdp.Contains("a=fingerprint:sha-256 ", StringComparison.Ordinal))
            throw new ArgumentException("未读取到有效的视频配对信息。");
    }

    public static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value)
    {
        if (value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) throw new FormatException();
        return Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
    }
    private static byte[] Compress(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true)) gzip.Write(bytes);
        return output.ToArray();
    }
    private static byte[] Decompress(byte[] bytes, int maximum)
    {
        using var source = new MemoryStream(bytes);
        using var gzip = new GZipStream(source, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[4096];
        int count;
        while ((count = gzip.Read(buffer)) != 0)
        {
            if (output.Length + count > maximum) throw new InvalidDataException();
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }
}

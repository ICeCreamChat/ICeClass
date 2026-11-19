using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record PhonePreparationBootstrap(string SessionId, string Key, string ReturnUrl);
public sealed record PhonePreparationEnvelope(string SessionId, string Payload);
public sealed record PhonePreparationOffer(PhonePreparationBootstrap Bootstrap, string Payload);
public sealed record PhoneCertificateReply(string CameraHost, string CertificatePem);

/// <summary>Only the phone contacts the online service. Bootstrap HTTP carries authenticated ciphertext.</summary>
public sealed class PhonePreparation
{
    private sealed record Session(string Id, byte[] Key, DateTimeOffset CreatedAt, PhoneCertificateRequest Request);
    private readonly BoothServer server;
    private readonly ManagedPreparation client;
    private readonly PhoneCertificateRequest request;
    private readonly TimeProvider clock;
    private readonly object sync = new();
    private readonly SemaphoreSlim completing = new(1, 1);
    private readonly Dictionary<string, Session> sessions = [];
    private Session? current;
    private string? completedSession;
    private bool registered;
    public event Action? Prepared;
    public string CameraHost => request.CameraHost;
    public string ServiceUrl => request.ServiceUrl;
    public bool NeedsPreparation
    {
        get
        {
            var endpoint = server.TrustedEndpoint;
            return !endpoint.IsReady || endpoint.ServerCertificate is not { } certificate
                || CertificateMaintenance.NeedsRenewal(certificate.NotBefore.ToUniversalTime(), certificate.NotAfter.ToUniversalTime(), clock.GetUtcNow());
        }
    }
    public CertificatePreparationState State => NeedsPreparation
        ? new("phone-required", "电脑无需互联网。手机扫码后自动准备；首次可能需要几分钟，保持页面打开，无需设置证书。")
        : new("ready", "连接证书已准备好，需要更新时由手机自动办理。");
    public bool NeedsConnectionPreparation => NeedsPreparation || !client.HasPublishedAddress(server.Address);

    private PhonePreparation(BoothServer server, ManagedPreparation client, PhoneCertificateRequest request, TimeProvider clock)
    { this.server = server; this.client = client; this.request = request; this.clock = clock; registered = request.Registered; }

    public static async Task<PhonePreparation> Create(BoothServer server, PreparationServiceSettings settings,
        HttpClient http, CancellationToken cancellation = default, TimeProvider? clock = null)
    {
        var client = new ManagedPreparation(server.DataDirectory, settings.Url, http);
        var request = await client.CreatePhoneRequest(settings.CameraDomain ?? throw new InvalidOperationException("手机准备域名尚未配置。"),
            server.Address, cancellation);
        return new(server, client, request, clock ?? TimeProvider.System);
    }

    private Session CurrentSession()
    {
        lock (sync)
        {
            var now = clock.GetUtcNow();
            foreach (var expired in sessions.Values.Where(value => now - value.CreatedAt > TimeSpan.FromMinutes(15)).ToArray())
                sessions.Remove(expired.Id);
            if (current is null || !sessions.ContainsKey(current.Id) || current.Request.Address != server.Address)
            {
                current = new(Guid.NewGuid().ToString("N"), RandomNumberGenerator.GetBytes(32), now,
                    request with { Address = server.Address, Registered = registered });
                sessions.Add(current.Id, current);
            }
            return current;
        }
    }

    private Session FindSession(string id)
    {
        lock (sync)
        {
            if (!sessions.TryGetValue(id, out var session) || clock.GetUtcNow() - session.CreatedAt > TimeSpan.FromMinutes(15))
                throw new InvalidOperationException("二维码已失效，请重新扫描电脑当前的第 2 张码。");
            return session;
        }
    }

    private PhonePreparationBootstrap Bootstrap(Session session) => new(session.Id, Encode(session.Key),
        $"http://{session.Request.Address}:{server.HttpPort}/phone-preparation/return");

    public string JoinUrl()
    {
        var session = CurrentSession();
        var bootstrap = Encode(JsonSerializer.SerializeToUtf8Bytes(Bootstrap(session), Json));
        return new Uri(new Uri(request.ServiceUrl), "phone").AbsoluteUri + "#bootstrap=" + bootstrap;
    }

    public PhonePreparationEnvelope Relay(string id)
    {
        var session = FindSession(id);
        return new(id, Seal(session.Key, id, "request", session.Request));
    }

    public PhonePreparationOffer? Offer()
    {
        if (!NeedsPreparation) return null;
        var session = CurrentSession();
        return new(Bootstrap(session), Seal(session.Key, session.Id, "request", session.Request));
    }

    public async Task<string> Complete(PhonePreparationEnvelope envelope, CancellationToken cancellation = default)
    {
        var session = FindSession(envelope.SessionId);
        var reply = Open<PhoneCertificateReply>(session.Key, session.Id, "response", envelope.Payload);
        await completing.WaitAsync(cancellation);
        try
        {
            if (completedSession != session.Id)
            {
                await client.AcceptPhoneCertificate(session.Request, reply.CameraHost, reply.CertificatePem, cancellation);
                await server.ReloadTrustedEndpoint(cancellation);
                registered = true;
                completedSession = session.Id;
                Prepared?.Invoke();
            }
            return server.CurrentPhoneUrl();
        }
        finally { completing.Release(); }
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] Decode(string value)
    {
        if (value.Length > 32768) throw new ArgumentException("准备信息过长。");
        var encoded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '='));
    }
    public static string Seal<T>(byte[] key, string session, string purpose, T value)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var tag = new byte[16];
        var ciphertext = new byte[plain.Length];
        using var cipher = new AesGcm(key, tag.Length);
        cipher.Encrypt(nonce, plain, ciphertext, tag, Encoding.UTF8.GetBytes("VideoBooth phone preparation " + purpose + " " + session));
        return Encode([.. nonce, .. tag, .. ciphertext]);
    }
    public static T Open<T>(byte[] key, string session, string purpose, string payload)
    {
        var packet = Decode(payload);
        if (packet.Length <= 28) throw new ArgumentException("准备信息不完整。");
        var plaintext = new byte[packet.Length - 28];
        using var cipher = new AesGcm(key, 16);
        cipher.Decrypt(packet.AsSpan(0, 12), packet.AsSpan(28), packet.AsSpan(12, 16), plaintext,
            Encoding.UTF8.GetBytes("VideoBooth phone preparation " + purpose + " " + session));
        return JsonSerializer.Deserialize<T>(plaintext, Json) ?? throw new ArgumentException("准备信息不可用。");
    }
}

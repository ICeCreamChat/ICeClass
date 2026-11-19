using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Net.Security;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using QRCoder;

namespace ICeClass.VideoBooth.Transport;

public sealed record ConnectionSettings(string? Address = null, string? RelayUrl = null, JsonElement[]? IceServers = null, bool? AddressSelected = null);

public sealed class BoothServer : IAsyncDisposable
{
    private sealed record LocalPorts(int Http, int Https, int Stun = 0);
    private readonly WebApplication app;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly SemaphoreSlim configuring = new(1);
    private bool addressSelected;
    private JsonElement[]? configuredIceServers;
    private readonly CancellationTokenSource networkMonitor = new();
    private Task? networkMonitoring;
    public RoomStore Rooms { get; } = new();
    private readonly LocalStunResponder localStun;
    public int StunPort => localStun.Port;
    public Certificates Certificates { get; }
    private TrustedEndpoint trustedEndpoint;
    private readonly List<TrustedEndpoint> retiredEndpoints = [];
    public TrustedEndpoint TrustedEndpoint => Volatile.Read(ref trustedEndpoint);
    public CertificatePreparationState? CertificatePreparation { get; set; }
    public PhonePreparation? PhonePreparation { get; private set; }
    public string? LocalCameraHost => TrustedEndpoint.IsReady ? TrustedEndpoint.CameraHost : PhonePreparation?.CameraHost;
    public PhoneConnection Connection { get; } = new();
    public ConnectionAssessment? ConnectionAssessment { get; set; }
    public PublicPhonePairing PublicPhone { get; }
    public bool UsesPublicPhone => RelayUrl is null && PublicPhone.Portal is not null;
    private bool publicPhoneIsComputer;
    public string DesktopKey { get; } = Secret();
    public RoomRegistration Registration { get; private set; } = NewRegistration();
    public NetworkChoice[] Networks { get; private set; }
    public int HttpPort { get; private set; }
    public int HttpsPort { get; private set; }
    public string Address { get; private set; }
    public string? RelayUrl { get; private set; }
    public string DataDirectory { get; }
    public string? StartupNotice { get; private set; }
    public string DesktopUrl => $"https://127.0.0.1:{HttpsPort}/desktop?key={DesktopKey}";

    private BoothServer(string directory, LocalPorts? ports = null)
    {
        DataDirectory = Path.GetFullPath(directory);
        localStun = new LocalStunResponder(ports?.Stun ?? 0);
        Networks = NetworkSelection.Read();
        Address = Networks.FirstOrDefault()?.Address ?? "127.0.0.1";
        Certificates = new Certificates(DataDirectory, Networks.Select(n => IPAddress.Parse(n.Address)));
        trustedEndpoint = TrustedEndpoint.Load(DataDirectory);
        PublicPhone = new PublicPhonePairing(DataDirectory);
        Rooms.Register(Registration);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Limits.MaxRequestBodySize = 65536;
            options.ListenAnyIP(ports?.Http ?? 0);
            options.ListenAnyIP(ports?.Https ?? 0, listen =>
            {
                // Observe arrival before TLS so a stalled or mismatched ClientHello is visible.
                // Store only stage timestamps, never the peer address or requested hostname.
                listen.Use(next => async connection =>
                {
                    if (connection.RemoteEndPoint is IPEndPoint peer && !PhoneConnection.IsComputerBrowser(peer.Address, Networks))
                        Connection.ReportNetworkStep("https-tcp");
                    await next(connection);
                });
                listen.UseHttps(new TlsHandshakeCallbackOptions
                {
                    OnConnection = context =>
                    {
                        if (context.Connection.RemoteEndPoint is IPEndPoint remote && !PhoneConnection.IsComputerBrowser(remote.Address, Networks))
                            Connection.ReportNetworkStep("tls-hello");
                        var endpoint = TrustedEndpoint;
                        var trustedHost = endpoint.IsReady && endpoint.MatchesHost(context.ClientHelloInfo.ServerName);
                        if (trustedHost && context.Connection.RemoteEndPoint is IPEndPoint peer
                            && !PhoneConnection.IsComputerBrowser(peer.Address, Networks)) Connection.ReportNetworkStep("trusted-tls");
                        return ValueTask.FromResult(trustedHost
                            ? new SslServerAuthenticationOptions { ServerCertificateContext = endpoint.CertificateContext }
                            : new SslServerAuthenticationOptions { ServerCertificate = Certificates.Server });
                    }
                });
            });
        });
        app = builder.Build();
        AddCommonRoutes(app, Rooms, room => IceServers(room.Registration.IceServers));
        app.Use(async (context, next) =>
        {
            var localComputer = PhoneConnection.IsComputerBrowser(context.Connection.RemoteIpAddress, Networks);
            if (!localComputer && !context.Request.IsHttps
                && (context.Request.Path == "/health" || AuthorizedPhone(context))) Connection.ReportNetworkStep("local-http");
            await next();
            if (!localComputer && context.Request.Path == "/phone" && context.Request.IsHttps && context.Response.StatusCode == 200
                && TrustedEndpoint.MatchesHost(context.Request.Host.Host) && AuthorizedPhone(context)) Connection.ReportNetworkStep("phone-page");
            // A top-level browser visit validates TLS too, including when a WebView blocks cross-origin fetch.
            if (context.Request.Path == "/api/phone" && context.Request.IsHttps && context.Response.StatusCode == 200
                && TrustedEndpoint.MatchesHost(context.Request.Host.Host) && AuthorizedPhone(context))
            {
                Connection.ConfirmBrowserConnection(localComputer);
                if (!localComputer) Connection.ReportNetworkStep("camera-https");
            }
        });
        app.MapGet("/desktop", (HttpContext context) => AuthorizedDesktop(context) ? Asset("desktop.html") : Results.Unauthorized());
        app.MapGet("/api/desktop", (HttpContext context) => AuthorizedDesktop(context) ? Results.Json(Configuration()) : Results.Unauthorized());
        app.MapGet("/api/desktop-ice", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context)) return Results.Unauthorized();
            if (RelayUrl is null) return Results.Json(new { iceServers = IceServers(Registration.IceServers) });
            try
            {
                await EnsureRelayRoom(context.RequestAborted);
                using var response = await http.GetAsync(RelayUrl + "/api/viewer?room=" + Registration.Id + "&key=" + Registration.ViewerKey);
                if (!response.IsSuccessStatusCode) return Results.StatusCode(503);
                var data = await response.Content.ReadFromJsonAsync<JsonElement>();
                return Results.Json(data);
            }
            catch (HttpRequestException) { return Results.StatusCode(503); }
            catch (TaskCanceledException) { return Results.StatusCode(503); }
            catch (InvalidOperationException) { return Results.StatusCode(503); }
        });
        app.MapGet("/phone-preparation/relay", (HttpContext context) =>
        {
            if (PhonePreparation is null) return Results.NotFound();
            try
            {
                var envelope = PhonePreparation.Relay(context.Request.Query["session"].ToString());
                Connection.ReportNetworkStep("local-http");
                return Results.Content(PhonePreparationPages.Relay(envelope,
                    new Uri(new Uri(PhonePreparation.ServiceUrl), "phone").AbsoluteUri), "text/html; charset=utf-8");
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException) { return Results.BadRequest("二维码已失效，请重新扫码。"); }
        });
        app.MapGet("/phone-preparation/return", () => Asset("phone-preparation-return.html"));
        app.MapGet("/api/phone-preparation/request", (HttpContext context) =>
            PhonePreparation is null ? Results.NotFound() : context.Request.IsHttps
                && TrustedEndpoint.MatchesHost(context.Request.Host.Host) && AuthorizedPhone(context)
                ? Results.Json(PhonePreparation.Offer()) : Results.Unauthorized());
        app.MapPost("/api/phone-preparation/complete", async (HttpContext context) =>
        {
            if (PhonePreparation is null) return Results.NotFound();
            try
            {
                var envelope = await context.Request.ReadFromJsonAsync<PhonePreparationEnvelope>();
                if (envelope is null || envelope.SessionId is null || envelope.Payload is null) return Results.BadRequest();
                var phoneUrl = await PhonePreparation.Complete(envelope, context.RequestAborted);
                return Results.Json(new { phoneUrl });
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or FormatException
                or CryptographicException or JsonException or IOException or UnauthorizedAccessException)
            { return Results.BadRequest(new { error = "准备结果未通过本机检查。请重新扫描电脑当前的第 2 张码。" }); }
        });
        app.MapPost("/api/phone-status", async (HttpContext context) =>
        {
            if (!AuthorizedPhone(context)) return Results.Unauthorized();
            try
            {
                var report = await context.Request.ReadFromJsonAsync<PhoneBrowserReport>();
                return report is not null && Connection.ReportBrowser(context.Request.Headers.UserAgent.ToString(), report,
                    PhoneConnection.IsComputerBrowser(context.Connection.RemoteIpAddress, Networks))
                    ? Results.NoContent() : Results.BadRequest();
            }
            catch (JsonException) { return Results.BadRequest(); }
        });
        app.MapGet("/connect", (HttpContext context) => AuthorizedPhone(context) && TrustedEndpoint.IsReady
            ? Asset("connect.html") : Results.Unauthorized());
        app.MapGet("/api/connect-info", (HttpContext context) =>
        {
            var endpoint = TrustedEndpoint;
            return AuthorizedPhone(context) && endpoint.IsReady
                ? Results.Json(new { phoneUrl = TrustedPhoneUrl(endpoint), verifyUrl = $"https://{endpoint.CameraHost}:{HttpsPort}/api/verify-phone?room={Registration.Id}&join={Registration.JoinKey}" })
                : Results.Unauthorized();
        });
        app.MapMethods("/api/verify-phone", ["POST", "OPTIONS"], (HttpContext context) =>
        {
            if (!context.Request.IsHttps || !TrustedEndpoint.MatchesHost(context.Request.Host.Host)) return Results.Unauthorized();
            var origin = $"http://{Address}:{HttpPort}";
            if (context.Request.Headers.Origin != origin) return Results.Unauthorized();
            context.Response.Headers["Access-Control-Allow-Origin"] = origin;
            context.Response.Headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
            if (context.Request.Method == "OPTIONS") return Results.NoContent();
            if (!AuthorizedPhone(context)) return Results.Unauthorized();
            Connection.ConfirmBrowserConnection(PhoneConnection.IsComputerBrowser(context.Connection.RemoteIpAddress, Networks));
            return Results.Json(new { ready = true });
        });
        app.MapGet("/api/qr", (HttpContext context) => AuthorizedDesktop(context)
            ? UsesPublicPhone && PublicPhone.JoinUrl is null ? Results.StatusCode(409)
                : Results.Bytes(PngByteQRCodeHelper.GetQRCode(JoinUrl(), UsesPublicPhone ? QRCodeGenerator.ECCLevel.M : QRCodeGenerator.ECCLevel.Q, 8), "image/png")
            : Results.Unauthorized());
        app.MapPost("/api/public-phone/offer", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context) || !UsesPublicPhone) return Results.Unauthorized();
            try
            {
                var request = await context.Request.ReadFromJsonAsync<CameraOffer>();
                if (request is null || request.Offer is null) return Results.BadRequest();
                PublicPhone.Prepare(request, Address, HttpPort);
                return Results.Json(Configuration());
            }
            catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapGet("/api/public-phone/answer", (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context) || !UsesPublicPhone) return Results.Unauthorized();
            return PublicPhone.Answer(context.Request.Query["generation"].ToString()) is { } answer
                ? Results.Json(answer) : Results.NoContent();
        });
        app.MapPost("/api/public-phone/state", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context) || !UsesPublicPhone || context.Request.Query["generation"] != PublicPhone.Generation) return Results.Unauthorized();
            try
            {
                var report = await context.Request.ReadFromJsonAsync<PhoneBrowserReport>();
                return report is not null && Connection.ReportBrowser(publicPhoneIsComputer ? "" : "phone", report, publicPhoneIsComputer)
                    ? Results.NoContent() : Results.BadRequest();
            }
            catch (JsonException) { return Results.BadRequest(); }
        });
        app.MapGet("/pair-phone", (HttpContext context) =>
        {
            if (!UsesPublicPhone) return Results.Unauthorized();
            var accepted = PublicPhone.Accept(context.Request.Query["payload"].ToString(), context.Request.Query["signature"].ToString());
            if (accepted.Status != 200) return Results.Content(accepted.Status == 409 ? "已有手机使用这张码，请在电脑上点“更换配对”，再重新扫码。"
                : "连接码已失效，请重新扫描电脑上的第 2 张码。", "text/plain; charset=utf-8", statusCode: accepted.Status);
            publicPhoneIsComputer = PhoneConnection.IsComputerBrowser(context.Connection.RemoteIpAddress, Networks);
            Connection.ReportBrowser(context.Request.Headers.UserAgent.ToString(), new("camera-ready", true, true, true), publicPhoneIsComputer);
            if (!publicPhoneIsComputer) Connection.ReportNetworkStep("local-http");
            var scriptNonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            context.Response.Headers["Content-Security-Policy"] = $"default-src 'none'; script-src 'nonce-{scriptNonce}'; frame-ancestors 'none'; base-uri 'none'";
            var origin = PublicPhone.Portal!.GetLeftPart(UriPartial.Authority);
            var html = "<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>已连接展台</title>"
                + "<p>已连接电脑。请返回刚才的摄像头页面，画面会自动出现。</p><script nonce='" + scriptNonce + "'>"
                + "window.opener?.postMessage({type:'videobooth-paired',nonce:" + JsonSerializer.Serialize(accepted.Nonce) + "},"
                + JsonSerializer.Serialize(origin) + ");window.close();</script></html>";
            return Results.Content(html, "text/html; charset=utf-8");
        });
        app.MapGet("/api/wifi-qr", (HttpContext context) => !AuthorizedDesktop(context) ? Results.Unauthorized()
            : Connection.WifiPayload() is { } payload
                ? Results.Bytes(PngByteQRCodeHelper.GetQRCode(payload, QRCodeGenerator.ECCLevel.Q, 8), "image/png")
                : Results.NotFound());
        app.MapPost("/api/refresh-network", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context)) return Results.Unauthorized();
            await RefreshNetworks();
            return Results.Json(Configuration());
        });
        app.MapPost("/api/settings", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context)) return Results.Unauthorized();
            try
            {
                var settings = await context.Request.ReadFromJsonAsync<ConnectionSettings>();
                if (settings is null) return Results.BadRequest(new { error = "没有读取到连接设置。" });
                await Configure(settings);
                return Results.Json(Configuration());
            }
            catch (Exception e) when (e is ArgumentException or HttpRequestException or TaskCanceledException or InvalidOperationException or JsonException or IOException or UnauthorizedAccessException)
            { return Results.BadRequest(new { error = e.Message }); }
        });
        app.MapPost("/api/new-pair", async (HttpContext context) =>
        {
            if (!AuthorizedDesktop(context)) return Results.Unauthorized();
            try { await Configure(new(Address, RelayUrl, configuredIceServers), true); return Results.Json(Configuration()); }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException or IOException or UnauthorizedAccessException)
            { return Results.BadRequest(new { error = e.Message }); }
        });
        app.MapGet("/api/setup", (HttpContext context) =>
        {
            var room = Rooms.Find(context.Request.Query["room"].ToString());
            var key = context.Request.Query["join"].ToString();
            if (room is null || !room.Authorize("sender", key)) return Results.Unauthorized();
            var host = context.Request.Host.Host;
            if (!IPAddress.TryParse(host, out var address) || !Networks.Any(n => n.Address == address.ToString()) && !IPAddress.IsLoopback(address))
                return Results.BadRequest(new { error = "请使用电脑程序显示的二维码连接。" });
            return Results.Json(new { phoneUrl = $"https://{host}:{HttpsPort}/phone?room={Registration.Id}&join={Registration.JoinKey}", certificateName = Certificates.Authority.GetNameInfo(System.Security.Cryptography.X509Certificates.X509NameType.SimpleName, false) });
        });
        // The HTTP scan page may skip setup only after the browser accepts our HTTPS certificate.
        app.MapGet("/api/browser-ready", (HttpContext context) =>
        {
            var host = context.Request.Host.Host;
            var expectedOrigin = $"http://{host}:{HttpPort}";
            if (IPAddress.TryParse(host, out var address) && (Networks.Any(network => network.Address == address.ToString()) || IPAddress.IsLoopback(address)) && context.Request.Headers.Origin == expectedOrigin)
                context.Response.Headers["Access-Control-Allow-Origin"] = expectedOrigin;
            return Results.Json(new { ready = true });
        });
        app.MapGet("/certificate.crt", () => Results.File(Certificates.PublicCertificate, "application/x-x509-ca-cert", "VideoBooth.crt"));
        app.MapGet("/certificate.mobileconfig", () => Results.File(Certificates.AppleProfile(), "application/x-apple-aspen-config", "VideoBooth.mobileconfig"));
    }

    public static async Task<BoothServer> Start(string dataDirectory)
    {
        var ports = ReadPorts(dataDirectory);
        var server = new BoothServer(dataDirectory, ports);
        string? portNotice = null;
        try
        {
            try { await server.app.StartAsync(); }
            catch (Exception error) when (ports is not null && PortUnavailable(error))
            {
                await server.DisposeAsync();
                server = new BoothServer(dataDirectory);
                await server.app.StartAsync();
                portNotice = "原连接地址暂时不可用，已自动换用可用地址。手机再次出现摄像头权限提示时，请点“允许”。";
            }
            var addresses = server.app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses;
            server.HttpPort = new Uri(addresses.Single(a => a.StartsWith("http:"))).Port;
            server.HttpsPort = new Uri(addresses.Single(a => a.StartsWith("https:"))).Port;
            try
            {
                var path = Path.Combine(server.DataDirectory, "ports.json");
                await File.WriteAllTextAsync(path + ".tmp", JsonSerializer.Serialize(new LocalPorts(server.HttpPort, server.HttpsPort, server.StunPort), new JsonSerializerOptions(JsonSerializerDefaults.Web)));
                File.Move(path + ".tmp", path, true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { portNotice = "连接地址暂时无法保存。请将展台放在可写文件夹中，避免重启后重复授权摄像头。"; }
            var savedPath = Path.Combine(dataDirectory, "settings.json");
            if (File.Exists(savedPath))
            {
                try
                {
                    var saved = JsonSerializer.Deserialize<ConnectionSettings>(await File.ReadAllTextAsync(savedPath), new JsonSerializerOptions(JsonSerializerDefaults.Web));
                    if (saved is not null)
                    {
                        var address = NetworkSelection.RestoreAddress(server.Networks, saved.Address, saved.AddressSelected);
                        await server.Configure(saved with { Address = address, RelayUrl = null, AddressSelected = address == saved.Address && saved.AddressSelected != false }, persist: false);
                        if (address != saved.Address && saved.Address is not null)
                            server.StartupNotice = "原连接地址已不适合手机连接，已改用推荐地址。无需互联网，请让手机与电脑连接同一 Wi-Fi 或热点。";
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException or HttpRequestException or TaskCanceledException or InvalidOperationException)
                { server.StartupNotice = "保存的连接设置暂时不可用，已使用本地离线连接。可在连接设置中重新配置。"; }
            }
            if (portNotice is not null) server.StartupNotice = server.StartupNotice is null ? portNotice : server.StartupNotice + " " + portNotice;
            server.networkMonitoring = server.MonitorNetworks();
            return server;
        }
        catch { await server.DisposeAsync(); throw; }
    }

    private static LocalPorts? ReadPorts(string directory)
    {
        try
        {
            var path = Path.Combine(directory, "ports.json");
            if (!File.Exists(path)) return null;
            var ports = JsonSerializer.Deserialize<LocalPorts>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            return ports is { Http: > 0 and <= 65535, Https: > 0 and <= 65535, Stun: >= 0 and <= 65535 } && ports.Http != ports.Https ? ports : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    private static bool PortUnavailable(Exception error) => error is SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse or SocketError.AccessDenied }
        || error is Microsoft.AspNetCore.Connections.AddressInUseException
        || error.InnerException is not null && PortUnavailable(error.InnerException);

    public object Configuration()
    {
        var endpoint = TrustedEndpoint;
        return new
        {
        room = Registration.Id, key = Registration.ViewerKey,
        signalUrl = RelayUrl is null ? $"wss://127.0.0.1:{HttpsPort}/signal" : WebSocketUrl(RelayUrl),
        iceRefreshUrl = RelayUrl is null ? null : $"/api/desktop-ice?key={DesktopKey}",
        connectionAssessment = ConnectionAssessment,
        iceServers = IceServers(Registration.IceServers), configuredIceServers = configuredIceServers ?? [],
        joinUrl = JoinUrl(endpoint), address = Address, networks = Networks, recommendedAddress = Networks.FirstOrDefault()?.Address, relayUrl = RelayUrl ?? "",
        qrUrl = $"/api/qr?key={DesktopKey}", desktopKey = DesktopKey,
        wifiQrUrl = $"/api/wifi-qr?key={DesktopKey}",
        connection = RelayUrl is not null || UsesPublicPhone || PhonePreparation is not null ? Connection.Diagnostics : Connection.Snapshot(endpoint),
        publicPhone = new { enabled = UsesPublicPhone, generation = PublicPhone.Generation, ready = PublicPhone.JoinUrl is not null, error = PublicPhone.Error },
        phoneBrowser = Connection.Browser,
        phoneNetwork = Connection.Network,
        equipment = new { certificateReady = endpoint.IsReady, certificateError = endpoint.Error,
            cameraHost = endpoint.CameraHost, certificateExpires = endpoint.ServerCertificate?.NotAfter.ToUniversalTime(),
            preparation = PhonePreparation?.State ?? CertificatePreparation,
            phonePreparation = PhonePreparation is not null, network = Connection.Diagnostics },
        localOnly = RelayUrl is null,
        networkAvailable = Address != "127.0.0.1",
        helpUrl = $"http://{Address}:{HttpPort}/setup?room={Registration.Id}&join={Registration.JoinKey}", startupNotice = StartupNotice
        };
    }

    public string JoinUrl() => JoinUrl(TrustedEndpoint);
    private JsonElement[] IceServers(JsonElement[]? configured) => RelayUrl is null && (configured is null || configured.Length == 0)
        ? [JsonSerializer.SerializeToElement(new { urls = $"stun:{Address}:{StunPort}" })] : configured ?? [];
    private string JoinUrl(TrustedEndpoint endpoint) => UsesPublicPhone ? PublicPhone.JoinUrl ?? PublicPhone.Portal!.AbsoluteUri : RelayUrl is null
        ? PhonePreparation is { NeedsConnectionPreparation: true } preparation ? preparation.JoinUrl() : endpoint.IsReady
            ? TrustedPhoneUrl(endpoint)
            : $"http://{Address}:{HttpPort}/setup?room={Registration.Id}&join={Registration.JoinKey}"
        : $"{RelayUrl}/phone?room={Registration.Id}&join={Registration.JoinKey}";

    private string TrustedPhoneUrl(TrustedEndpoint endpoint) => $"https://{endpoint.CameraHost}:{HttpsPort}/phone?room={Registration.Id}&join={Registration.JoinKey}";
    public string CurrentPhoneUrl() => TrustedEndpoint.IsReady ? TrustedPhoneUrl(TrustedEndpoint)
        : throw new InvalidOperationException("摄像头证书尚未准备完成。");
    public async Task EnablePhonePreparation(PreparationServiceSettings settings, HttpClient? preparationHttp = null,
        CancellationToken cancellation = default, TimeProvider? clock = null)
    {
        if (settings.CameraDomain is null || UsesPublicPhone || RelayUrl is not null) return;
        PhonePreparation = await ICeClass.VideoBooth.Transport.PhonePreparation.Create(this, settings, preparationHttp ?? http, cancellation, clock);
    }

    public async Task ReloadTrustedEndpoint(CancellationToken cancellation = default)
    {
        await configuring.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            var next = TrustedEndpoint.Load(DataDirectory);
            if (!next.IsReady)
            {
                var error = next.Error;
                next.Dispose();
                throw new InvalidOperationException(error ?? "新的手机连接证书尚未准备完成。");
            }
            // Existing TLS connections may still use the previous context. Keep it
            // alive until the server stops, as with the local application's leaf.
            var previous = TrustedEndpoint;
            retiredEndpoints.Add(previous);
            Volatile.Write(ref trustedEndpoint, next);
            if (previous.CameraHost != next.CameraHost && !(previous.CameraHost is null
                && PhonePreparation?.CameraHost == next.CameraHost && Connection.Ready)) Connection.Set("starting");
        }
        finally { configuring.Release(); }
    }
    private bool AuthorizedPhone(HttpContext context) => Rooms.Find(context.Request.Query["room"].ToString()) is { } room
        && room.Authorize("sender", context.Request.Query["join"].ToString());

    public async Task RefreshNetworks(CancellationToken cancellation = default)
    {
        await configuring.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            var next = NetworkSelection.Read();
            if (Networks.SequenceEqual(next)) return;
            Certificates.RefreshAddresses(next.Select(n => IPAddress.Parse(n.Address)));
            if (RelayUrl is null && Connection.Ready && !next.Any(network => network.Address == Address))
                Connection.Set("error", error: "展台的本地连接已断开，请重新准备连接。");
            Networks = next;
            var nextAddress = NetworkSelection.RestoreAddress(next, Address, addressSelected);
            if (Address != nextAddress) PublicPhone.Reset();
            Address = nextAddress;
        }
        finally { configuring.Release(); }
    }

    private async Task MonitorNetworks()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try
        {
            while (await timer.WaitForNextTickAsync(networkMonitor.Token))
            {
                try { await RefreshNetworks(networkMonitor.Token).ConfigureAwait(false); }
                catch (Exception error) when (error is System.Net.NetworkInformation.NetworkInformationException or CryptographicException) { }
            }
        }
        catch (OperationCanceledException) when (networkMonitor.IsCancellationRequested) { }
    }

    public async Task Configure(ConnectionSettings settings, bool newPair = false, bool persist = true)
    {
        await configuring.WaitAsync().ConfigureAwait(false);
        try
        {
            var address = settings.Address ?? Address;
            if (!Networks.Any(n => n.Address == address) && address != "127.0.0.1") throw new ArgumentException("此连接已断开，请点击刷新连接后重试。");
            var selectedAddress = settings.AddressSelected ?? (address != Address || addressSelected);
            var relay = string.IsNullOrWhiteSpace(settings.RelayUrl) ? null : settings.RelayUrl.Trim().TrimEnd('/');
            if (relay is not null) ConnectionChoice.ValidateUrl(relay);
            ValidateIceServers(settings.IceServers);
            var changedRoom = newPair || relay != RelayUrl || JsonSerializer.Serialize(settings.IceServers) != JsonSerializer.Serialize(configuredIceServers);
            var next = changedRoom ? NewRegistration(settings.IceServers) : Registration;
            if (relay is not null && changedRoom)
            {
                using var response = await http.PostAsJsonAsync(relay + "/api/rooms", next).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException("远程服务无法创建连接，请检查服务地址和服务器状态。");
                var reply = await response.Content.ReadFromJsonAsync<JsonElement>().ConfigureAwait(false);
                if (reply.TryGetProperty("iceServers", out var supplied) && supplied.ValueKind == JsonValueKind.Array)
                {
                    var servers = supplied.EnumerateArray().ToArray(); ValidateIceServers(servers);
                    next = next with { IceServers = servers };
                }
            }
            var previous = Registration;
            var previousRelay = RelayUrl;
            if (persist)
            {
                var path = Path.Combine(DataDirectory, "settings.json");
                await File.WriteAllTextAsync(path + ".tmp", JsonSerializer.Serialize(new ConnectionSettings(address, relay, settings.IceServers, selectedAddress), new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true })).ConfigureAwait(false);
                File.Move(path + ".tmp", path, true);
            }
            if (changedRoom)
            {
                Connection.ResetBrowser();
                Rooms.Register(next);
                Registration = next;
                await Rooms.Remove(previous.Id, previous.ViewerKey).ConfigureAwait(false);
            }
            if (changedRoom || Address != address) PublicPhone.Reset();
            Address = address;
            addressSelected = selectedAddress;
            RelayUrl = relay;
            configuredIceServers = settings.IceServers;
            StartupNotice = null;
            if (changedRoom && previousRelay is not null)
            {
                try { using var request = new HttpRequestMessage(HttpMethod.Delete, previousRelay + "/api/rooms/" + previous.Id); request.Headers.Add("Authorization", "Bearer " + previous.ViewerKey); using var response = await http.SendAsync(request).ConfigureAwait(false); }
                catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
            }
        }
        finally { configuring.Release(); }
    }

    public async Task EnsureRelayRoom(CancellationToken cancellation = default)
    {
        await configuring.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            if (RelayUrl is null) return;
            using var check = await http.GetAsync(RelayUrl + "/api/viewer?room=" + Registration.Id + "&key=" + Registration.ViewerKey, cancellation).ConfigureAwait(false);
            if (check.IsSuccessStatusCode) return;
            if (check.StatusCode != HttpStatusCode.Unauthorized)
                throw new HttpRequestException("联网连接服务暂时不可用。");
            // Recover the same pairing after a relay restart, preserving the QR and
            // both independent authorization keys. An occupied ID must match both keys.
            using var response = await http.PostAsJsonAsync(RelayUrl + "/api/rooms", Registration, cancellation).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException("联网配对暂时无法恢复，请点击“重新准备连接”。");
        }
        finally { configuring.Release(); }
    }

    private bool AuthorizedDesktop(HttpContext context)
    {
        var ip = context.Connection.RemoteIpAddress;
        return ip is not null && IPAddress.IsLoopback(ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip) && context.Request.Query["key"] == DesktopKey;
    }
    public static void ValidateIceServers(JsonElement[]? servers)
    {
        if (servers is null) return;
        if (servers.Length > 8) throw new ArgumentException("连接服务配置过多。");
        foreach (var server in servers)
        {
            if (server.ValueKind != JsonValueKind.Object || !server.TryGetProperty("urls", out var urls)) throw new ArgumentException("连接服务配置需要 urls 字段。");
            var list = urls.ValueKind == JsonValueKind.Array ? urls.EnumerateArray().ToArray() : [urls];
            if (list.Length is < 1 or > 8) throw new ArgumentException("每项连接服务配置需要 1 到 8 个地址。");
            foreach (var field in new[] { "username", "credential" })
                if (server.TryGetProperty(field, out var value) && value.ValueKind != JsonValueKind.String) throw new ArgumentException(field + " 需要填写字符串。");
            foreach (var entry in list)
                if (entry.ValueKind != JsonValueKind.String || !(entry.GetString()!.StartsWith("stun:") || entry.GetString()!.StartsWith("stuns:") || entry.GetString()!.StartsWith("turn:") || entry.GetString()!.StartsWith("turns:")))
                    throw new ArgumentException("连接服务地址需要以 stun: 或 turn: 开头。");
        }
    }

    public static void AddCommonRoutes(WebApplication app, RoomStore rooms, Func<Room, JsonElement[]>? iceServers = null, bool online = false)
    {
        app.Use(async (context, next) =>
        {
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Headers["Cache-Control"] = "no-store";
            context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
            context.Response.Headers["Permissions-Policy"] = "camera=(self), microphone=()";
            await next();
        });
        app.UseWebSockets(new() { KeepAliveInterval = TimeSpan.FromSeconds(20) });
        app.MapGet("/health", () => Results.Json(new { status = "ok", product = "视频展台" }));
        app.MapGet("/favicon.ico", () => Asset("app-icon.png"));
        foreach (var page in new[] { "phone", "setup" }) app.MapGet("/" + page, () => Asset(page + ".html"));
        app.MapGet("/assets/{file}", (string file) => Asset(file));
        app.MapGet("/api/phone", (HttpContext context) =>
        {
            var room = rooms.Find(context.Request.Query["room"].ToString());
            if (room is null && online) return Results.StatusCode(503);
            if (room is null || !room.Authorize("sender", context.Request.Query["join"].ToString())) return Results.Unauthorized();
            return Results.Json(new { room = room.Registration.Id, key = room.Registration.JoinKey, signalUrl = $"{(context.Request.IsHttps ? "wss" : "ws")}://{context.Request.Host}{context.Request.PathBase}/signal", iceServers = iceServers?.Invoke(room) ?? room.Registration.IceServers ?? [], online,
                iceRefreshUrl = online ? "api/phone?room=" + room.Registration.Id + "&join=" + room.Registration.JoinKey : null });
        });
        app.Map("/signal", async context =>
        {
            var room = rooms.Find(context.Request.Query["room"].ToString());
            var role = context.Request.Query["role"].ToString();
            if (room is null || !room.Authorize(role, context.Request.Query["key"].ToString())) { context.Response.StatusCode = 401; return; }
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            await room.Handle(socket, role, context.RequestAborted);
        });
    }

    public static IResult Asset(string file)
    {
        var bytes = SiteAssets.Read(file);
        return bytes is null ? Results.NotFound() : Results.Bytes(bytes, SiteAssets.ContentType(file));
    }
    public static string WebSocketUrl(string baseUrl) => (baseUrl.StartsWith("https:") ? "wss:" + baseUrl[6..] : "ws:" + baseUrl[5..]) + "/signal";
    public static string Secret() => Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    public static RoomRegistration NewRegistration(JsonElement[]? servers = null) => new(Secret(), Secret(), Secret(), servers);
    public async ValueTask DisposeAsync()
    {
        networkMonitor.Cancel();
        if (networkMonitoring is not null) await networkMonitoring;
        if (RelayUrl is not null)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Delete, RelayUrl + "/api/rooms/" + Registration.Id);
                request.Headers.Authorization = new("Bearer", Registration.ViewerKey);
                using var response = await http.SendAsync(request, timeout.Token);
            }
            catch (Exception error) when (error is HttpRequestException or OperationCanceledException) { }
        }
        await Rooms.DisposeAsync();
        await localStun.DisposeAsync();
        await app.StopAsync();
        await app.DisposeAsync();
        http.Dispose();
        Certificates.Dispose();
        TrustedEndpoint.Dispose();
        foreach (var endpoint in retiredEndpoints) endpoint.Dispose();
        networkMonitor.Dispose();
    }
}

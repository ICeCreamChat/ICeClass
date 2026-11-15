using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed record RoomRegistration(string Id, string ViewerKey, string JoinKey, JsonElement[]? IceServers = null);

public sealed class RoomStore : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, Room> rooms = new();
    public Room Register(RoomRegistration registration, bool keepExisting = false)
    {
        if (string.IsNullOrEmpty(registration.Id) || string.IsNullOrEmpty(registration.ViewerKey) || string.IsNullOrEmpty(registration.JoinKey) || registration.Id.Length is < 16 or > 80 || registration.ViewerKey.Length is < 24 or > 128 || registration.JoinKey.Length is < 24 or > 128)
            throw new ArgumentException("配对信息不完整。");
        if (keepExisting && rooms.TryGetValue(registration.Id, out var existing))
        {
            if (!existing.Authorize("viewer", registration.ViewerKey) || !existing.Authorize("sender", registration.JoinKey))
                throw new ArgumentException("配对信息不匹配。");
            return existing;
        }
        if (rooms.Count >= 256) throw new InvalidOperationException("连接服务繁忙，请稍后重试。");
        var room = new Room(registration);
        if (!rooms.TryAdd(registration.Id, room))
        {
            if (keepExisting && rooms.TryGetValue(registration.Id, out existing)
                && existing.Authorize("viewer", registration.ViewerKey) && existing.Authorize("sender", registration.JoinKey)) return existing;
            throw new InvalidOperationException("此配对已经存在，请生成新的二维码。");
        }
        return room;
    }
    public Room? Find(string id) => rooms.GetValueOrDefault(id);
    public async Task<bool> Remove(string id, string key)
    {
        if (!rooms.TryGetValue(id, out var room) || room.Registration.ViewerKey != key) return false;
        if (rooms.TryRemove(id, out room)) await room.DisposeAsync();
        return true;
    }
    public async Task RemoveIdle()
    {
        foreach (var pair in rooms)
            if (pair.Value.IsIdle && rooms.TryRemove(pair.Key, out var room)) await room.DisposeAsync();
    }
    public async ValueTask DisposeAsync()
    {
        foreach (var room in rooms.Values) await room.DisposeAsync();
        rooms.Clear();
    }
}

public sealed class Room : IAsyncDisposable
{
    public RoomRegistration Registration { get; }
    private readonly object sync = new();
    private Peer? viewer;
    private Peer? sender;
    private DateTime lastActivity = DateTime.UtcNow;
    public bool IsIdle { get { lock (sync) return viewer is null && sender is null && DateTime.UtcNow - lastActivity > TimeSpan.FromHours(2); } }
    public Room(RoomRegistration registration) => Registration = registration;
    public bool Authorize(string role, string key) => role switch
    {
        "viewer" => key == Registration.ViewerKey,
        "sender" => key == Registration.JoinKey,
        _ => false
    };

    public async Task Handle(WebSocket socket, string role, CancellationToken cancellation)
    {
        var peer = new Peer(socket);
        Peer? replaced;
        lock (sync)
        {
            // An authenticated reconnect replaces only the previous socket of the same role.
            replaced = role == "viewer" ? viewer : sender;
            if (role == "viewer") viewer = peer; else sender = peer;
            lastActivity = DateTime.UtcNow;
        }
        if (replaced is not null) await replaced.Replace();
        try
        {
            await NotifyPeers();
            var buffer = new byte[8192];
            while (socket.State == WebSocketState.Open && !cancellation.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, cancellation);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 65536)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "消息过大或格式错误", cancellation);
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                var bytes = message.ToArray();
                using var json = JsonDocument.Parse(bytes);
                if (!json.RootElement.TryGetProperty("type", out var typeElement)) continue;
                var type = typeElement.GetString();
                if (type is not ("offer" or "answer" or "candidate" or "state" or "ready" or "pause" or "ping" or "orientation" or "media-stats")) continue;
                Peer? target;
                lock (sync)
                {
                    if ((role == "viewer" ? viewer : sender) != peer) return;
                    lastActivity = DateTime.UtcNow;
                    target = role == "viewer" ? sender : viewer;
                }
                if (type == "ping") await peer.Send("{\"type\":\"pong\"}");
                else if (target is not null) await target.Send(bytes);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException or JsonException) { }
        finally
        {
            var current = false;
            lock (sync)
            {
                if (role == "viewer" && viewer == peer) { viewer = null; current = true; }
                if (role == "sender" && sender == peer) { sender = null; current = true; }
                lastActivity = DateTime.UtcNow;
            }
            if (current) await NotifyPeers();
            socket.Dispose();
        }
    }

    private async Task NotifyPeers()
    {
        Peer? a, b;
        lock (sync) { a = viewer; b = sender; }
        if (a is not null) await a.Send(JsonSerializer.Serialize(new { type = "peer", present = b is not null }));
        if (b is not null) await b.Send(JsonSerializer.Serialize(new { type = "peer", present = a is not null }));
    }
    public ValueTask DisposeAsync()
    {
        lock (sync) { viewer?.Socket.Abort(); sender?.Socket.Abort(); viewer = sender = null; }
        return ValueTask.CompletedTask;
    }
    private sealed class Peer(WebSocket socket)
    {
        public WebSocket Socket { get; } = socket;
        private readonly SemaphoreSlim sending = new(1);
        public async Task Replace()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var acquired = false;
            try
            {
                await sending.WaitAsync(timeout.Token); acquired = true;
                if (Socket.State == WebSocketState.Open)
                    await Socket.CloseOutputAsync((WebSocketCloseStatus)4001, "此连接已被另一台设备接管", timeout.Token);
            }
            catch (Exception e) when (e is WebSocketException or ObjectDisposedException or OperationCanceledException) { Socket.Abort(); }
            finally { if (acquired) sending.Release(); }
        }
        public Task Send(string text) => Send(Encoding.UTF8.GetBytes(text));
        public async Task Send(byte[] bytes)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var acquired = false;
            try { await sending.WaitAsync(timeout.Token); acquired = true; if (Socket.State == WebSocketState.Open) await Socket.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token); }
            catch (Exception e) when (e is WebSocketException or ObjectDisposedException or OperationCanceledException) { Socket.Abort(); }
            finally { if (acquired) sending.Release(); }
        }
    }
}

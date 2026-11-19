using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace ICeClass.VideoBooth.Transport;

/// <summary>Discovers the Wi-Fi route to this computer without any Internet ICE service.</summary>
public sealed class LocalStunResponder : IAsyncDisposable
{
    private const uint Cookie = 0x2112a442;
    private readonly UdpClient socket = new(AddressFamily.InterNetwork);
    private readonly CancellationTokenSource stopping = new();
    private readonly Task listening;
    public int Port => ((IPEndPoint)socket.Client.LocalEndPoint!).Port;

    public LocalStunResponder(int preferredPort = 0)
    {
        try
        {
            socket.Client.ExclusiveAddressUse = true;
            try { socket.Client.Bind(new IPEndPoint(IPAddress.Any, preferredPort)); }
            catch (SocketException error) when (preferredPort != 0 && error.SocketErrorCode is SocketError.AddressAlreadyInUse or SocketError.AccessDenied)
            { socket.Client.Bind(new IPEndPoint(IPAddress.Any, 0)); }
        }
        catch { socket.Dispose(); stopping.Dispose(); throw; }
        listening = Listen();
    }

    private async Task Listen()
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                UdpReceiveResult request;
                try { request = await socket.ReceiveAsync(stopping.Token).ConfigureAwait(false); }
                catch (SocketException error) when (error.SocketErrorCode == SocketError.ConnectionReset) { continue; }
                if (!IPAddress.IsLoopback(request.RemoteEndPoint.Address)
                    && !ManagedPreparation.IsLocalAddress(request.RemoteEndPoint.Address.ToString())) continue;
                var response = Answer(request.Buffer, request.RemoteEndPoint);
                if (response is not null) await socket.SendAsync(response, request.RemoteEndPoint, stopping.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (ObjectDisposedException) when (stopping.IsCancellationRequested) { }
        catch (SocketException) when (stopping.IsCancellationRequested) { }
    }

    private static byte[]? Answer(byte[] request, IPEndPoint client)
    {
        // RFC 8489 Binding request; never echo arbitrary datagrams or accept media packets.
        if (request.Length is < 20 or > 1024 || BinaryPrimitives.ReadUInt16BigEndian(request) != 1
            || BinaryPrimitives.ReadUInt32BigEndian(request.AsSpan(4)) != Cookie) return null;
        var length = BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(2));
        if (length % 4 != 0 || request.Length != 20 + length) return null;
        for (var offset = 20; offset < request.Length;)
        {
            if (offset + 4 > request.Length) return null;
            var size = BinaryPrimitives.ReadUInt16BigEndian(request.AsSpan(offset + 2));
            offset += 4 + (size + 3) / 4 * 4;
            if (offset > request.Length) return null;
        }
        var response = new byte[32];
        BinaryPrimitives.WriteUInt16BigEndian(response, 0x0101);
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2), 12);
        request.AsSpan(4, 16).CopyTo(response.AsSpan(4));
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(20), 0x0020); // XOR-MAPPED-ADDRESS
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(22), 8);
        response[25] = 1; // IPv4
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(26), (ushort)(client.Port ^ (Cookie >> 16)));
        BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(28), BinaryPrimitives.ReadUInt32BigEndian(client.Address.GetAddressBytes()) ^ Cookie);
        return response;
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel(); socket.Dispose();
        await listening.ConfigureAwait(false);
        stopping.Dispose();
    }
}

using System.Buffers.Binary;
using System.Text.Json;

namespace ICeClass.Receiver;

internal sealed record ClassroomPluginMessage(string RequestId, string Type, JsonElement Payload);

internal static class ClassroomPluginProtocol
{
    internal const int MaximumBytes = 3 * 1024 * 1024;
    internal static async Task<ClassroomPluginMessage> ReadAsync(Stream stream, CancellationToken token)
    {
        var header = new byte[4];
        await stream.ReadExactlyAsync(header, token);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 or > MaximumBytes) throw new InvalidDataException("插件消息大小无效。");
        var bytes = new byte[length];
        await stream.ReadExactlyAsync(bytes, token);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 4 ||
            !root.TryGetProperty("protocolVersion", out var version) || !version.TryGetInt32(out var number) || number != 1 ||
            !root.TryGetProperty("requestId", out var id) || id.ValueKind != JsonValueKind.String || !Guid.TryParseExact(id.GetString(), "N", out _) ||
            !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() is not { Length: > 0 and <= 40 } name ||
            !root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("插件协议消息无效。");
        return new(id.GetString()!, name, payload.Clone());
    }

    internal static async Task WriteAsync(Stream stream, string type, string requestId, object payload, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { protocolVersion = 1, requestId, type, payload });
        if (bytes.Length is <= 0 or > MaximumBytes) throw new InvalidDataException("插件消息过大，请缩小展示范围后重试。");
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
        await stream.WriteAsync(header, token);
        await stream.WriteAsync(bytes, token);
        await stream.FlushAsync(token);
    }
}

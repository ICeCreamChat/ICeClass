using System.Buffers.Binary;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

/// <summary>The local ICeClass v1 pipe envelope. Images never use BoothServer routes.</summary>
public static class IceClassProtocol
{
    public const int MaximumMessageBytes = 3 * 1024 * 1024;

    public static byte[] Encode(string type, object payload, string requestId)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { protocolVersion = 1, requestId, type, payload });
        _ = Decode(body);
        var frame = new byte[body.Length + 4];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, 4);
        return frame;
    }

    public static JsonElement Decode(byte[] body)
    {
        if (body.Length is <= 0 or > MaximumMessageBytes) throw new InvalidDataException("展台消息超过允许大小。");
        using var json = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 16 });
        var root = json.RootElement;
        var fields = new HashSet<string>(StringComparer.Ordinal);
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Any(property => !fields.Add(property.Name))
            || fields.Count != 4 || !fields.SetEquals(["protocolVersion", "requestId", "type", "payload"])
            || root.GetProperty("protocolVersion").ValueKind != JsonValueKind.Number
            || !root.GetProperty("protocolVersion").TryGetInt32(out var version) || version != 1
            || root.GetProperty("requestId").ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(root.GetProperty("requestId").GetString(), "N", out _)
            || root.GetProperty("type").ValueKind != JsonValueKind.String
            || root.GetProperty("type").GetString() is not { Length: > 0 and <= 64 }
            || root.GetProperty("payload").ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("展台消息格式无效。");
        return root.Clone();
    }

    public static async Task<JsonElement?> ReadAsync(Stream stream, CancellationToken cancellationToken)
    {
        var prefix = new byte[4];
        var first = await stream.ReadAsync(prefix.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
        if (first == 0) return null;
        await stream.ReadExactlyAsync(prefix.AsMemory(1), cancellationToken).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
        if (length is <= 0 or > MaximumMessageBytes) throw new InvalidDataException("展台消息长度无效。");
        var body = new byte[length];
        await stream.ReadExactlyAsync(body, cancellationToken).ConfigureAwait(false);
        return Decode(body);
    }
}

using System.Text.Json;

namespace ICeClass.VideoBooth;

internal static class ProtocolValidation
{
    internal const long MaximumSafeInteger = 9007199254740991;
    internal static long Integer(JsonElement value, long minimum = 0, long maximum = MaximumSafeInteger)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDecimal(out var number)
            || decimal.Truncate(number) != number || number < minimum || number > maximum)
            throw new InvalidDataException("展台数字信息无效。");
        return checked((long)number);
    }

    internal static Dictionary<string, object?> EventPayload(string type, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidDataException("展台事件信息无效。");
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in payload.EnumerateObject())
        {
            if (!values.TryAdd(property.Name, property.Name is "generation" or "capturedAt" ? Integer(property.Value) : property.Value.Clone()))
                throw new InvalidDataException("展台事件字段重复。");
        }
        if (type != "open_workshop" && !values.ContainsKey("generation")) throw new InvalidDataException("展台事件缺少代次。");
        return values;
    }

    internal static object Frame(JsonElement frame)
    {
        var data = frame.GetProperty("dataUrl").GetString();
        if (data is null || !data.StartsWith("data:image/png;base64,", StringComparison.Ordinal) || data.Length > 2800000)
            throw new InvalidDataException("固定画面信息无效或过大。");
        var rotation = Integer(frame.GetProperty("rotation"), 0, 270);
        if (rotation % 90 != 0) throw new InvalidDataException("固定画面方向无效。");
        return new
        {
            dataUrl = data,
            width = Integer(frame.GetProperty("width"), 1, 1920), height = Integer(frame.GetProperty("height"), 1, 1920),
            capturedAt = Integer(frame.GetProperty("capturedAt")), rotation,
            mirrored = frame.GetProperty("mirrored").GetBoolean(), generation = Integer(frame.GetProperty("generation"))
        };
    }
}

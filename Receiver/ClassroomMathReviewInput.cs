using System.Text.Json;

namespace ICeClass.Receiver;

internal sealed record ClassroomMathImage(string DataUrl, int Width, int Height, long CapturedAt)
{
    internal static ClassroomMathImage FromPayload(JsonElement payload)
    {
        try
        {
            var image = new ClassroomMathImage(payload.GetProperty("dataUrl").GetString() ?? "", payload.GetProperty("width").GetInt32(),
                payload.GetProperty("height").GetInt32(), payload.GetProperty("capturedAt").GetInt64());
            if (!image.DataUrl.StartsWith("data:image/png;base64,", StringComparison.Ordinal) || image.DataUrl.Length > 2_796_230 ||
                image.Width is < 1 or > 1920 || image.Height is < 1 or > 1920 || image.CapturedAt <= 0)
                throw new InvalidDataException("本次画面不符合点评要求，请调整展示范围后重试。");
            var bytes = Convert.FromBase64String(image.DataUrl[22..]);
            if (bytes.Length is < 24 or > 2 * 1024 * 1024 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
                throw new InvalidDataException("本次画面不是有效的 PNG 图片。");
            if (System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(16, 4)) != image.Width ||
                System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(20, 4)) != image.Height)
                throw new InvalidDataException("画面尺寸与原图不符，请重新点评。");
            return image;
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        { throw new InvalidDataException("视频展台返回的画面无效，请继续展示后重试。"); }
    }
    internal byte[] Bytes() => Convert.FromBase64String(DataUrl[22..]);
    internal object Payload() => new { dataUrl = DataUrl, width = Width, height = Height, capturedAt = CapturedAt };
    internal static void ValidatePair(ClassroomMathImage question, ClassroomMathImage answer, long now)
    {
        if (Math.Abs((decimal)question.CapturedAt - answer.CapturedAt) > 2000 ||
            question.CapturedAt > now + 1000 || answer.CapturedAt > now + 1000 ||
            now - question.CapturedAt > 10000 || now - answer.CapturedAt > 10000)
            throw new InvalidOperationException("两次取图间隔过长，请继续展示后重新点评。");
    }
}

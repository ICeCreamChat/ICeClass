using System.Buffers.Binary;

namespace ICeClass.Receiver;

/// <summary>Bounded, in-memory transcription of the ideas page's PCM WAV recordings.</summary>
internal sealed class IdeasVoiceTranscriber
{
    private const int MaximumWavBytes = 2 * 1024 * 1024;
    internal const int MaximumEncodedLength = (MaximumWavBytes + 2) / 3 * 4;
    internal const string BusyMessage = "正在转写录音，请稍后重试。";
    private const string NoSpeechMessage = "没有识别到文字，请靠近麦克风说话后重试。";
    private const string FormatMessage = "录音格式不正确，请使用 16 kHz、16 位的单声道 PCM WAV 录音。";
    // All ideas windows share this limit, including cancelled calls still inside native inference.
    private static readonly SemaphoreSlim NativeGate = new(1, 1);
    private readonly Func<float[], CancellationToken, string> _recognize;
    private int _busy;

    internal IdeasVoiceTranscriber(Func<float[], CancellationToken, string>? recognize = null) =>
        _recognize = recognize ?? Recognize;

    internal static bool IsValidRequestId(string? value) => value?.Length == 36
        && Guid.TryParseExact(value, "D", out var id) && id != Guid.Empty;

    internal async Task<string> TranscribeAsync(string? audioBase64, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) throw new InvalidOperationException(BusyMessage);
        try
        {
            return await Task.Run(() =>
            {
                token.ThrowIfCancellationRequested();
                var samples = ReadSamples(audioBase64);
                token.ThrowIfCancellationRequested();
                if (!samples.Any(sample => Math.Abs(sample) > .001f)) throw new InvalidDataException(NoSpeechMessage);
                if (!NativeGate.Wait(0)) throw new InvalidOperationException(BusyMessage);
                try
                {
                    token.ThrowIfCancellationRequested();
                    var text = _recognize(samples, token);
                    // Native decoding cannot be interrupted. Keep its slot and model until it returns.
                    token.ThrowIfCancellationRequested();
                    if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException(NoSpeechMessage);
                    return text.Trim();
                }
                finally { NativeGate.Release(); }
            }, token).ConfigureAwait(false);
        }
        finally { Volatile.Write(ref _busy, 0); }
    }

    private static float[] ReadSamples(string? audioBase64)
    {
        if (string.IsNullOrEmpty(audioBase64)) throw new InvalidDataException("没有收到录音，请重新录制后重试。");
        // Bound the allocation before asking the base64 decoder to allocate a byte array.
        if (audioBase64.Length > MaximumEncodedLength) throw new InvalidDataException("录音文件不能超过 2 MB。");
        byte[] audio;
        try { audio = Convert.FromBase64String(audioBase64); }
        catch (FormatException) { throw new InvalidDataException(FormatMessage); }
        if (audio.Length > MaximumWavBytes) throw new InvalidDataException("录音文件不能超过 2 MB。");
        if (audio.Length < 44 || !audio.AsSpan(0, 4).SequenceEqual("RIFF"u8)
            || !audio.AsSpan(8, 4).SequenceEqual("WAVE"u8)
            || BinaryPrimitives.ReadUInt32LittleEndian(audio.AsSpan(4)) != audio.Length - 8)
            throw new InvalidDataException(FormatMessage);

        var formatSeen = false;
        var dataOffset = -1;
        var dataLength = 0;
        for (var offset = 12; offset < audio.Length;)
        {
            if (audio.Length - offset < 8) throw new InvalidDataException(FormatMessage);
            var header = audio.AsSpan(offset, 8);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(header[4..]);
            var start = offset + 8;
            if (length > audio.Length - start) throw new InvalidDataException(FormatMessage);
            var chunk = audio.AsSpan(start, (int)length);
            if (header[..4].SequenceEqual("fmt "u8))
            {
                if (formatSeen || length is not (16 or 18)
                    || BinaryPrimitives.ReadUInt16LittleEndian(chunk) != 1
                    || BinaryPrimitives.ReadUInt16LittleEndian(chunk[2..]) != 1
                    || BinaryPrimitives.ReadUInt32LittleEndian(chunk[4..]) != 16000
                    || BinaryPrimitives.ReadUInt32LittleEndian(chunk[8..]) != 32000
                    || BinaryPrimitives.ReadUInt16LittleEndian(chunk[12..]) != 2
                    || BinaryPrimitives.ReadUInt16LittleEndian(chunk[14..]) != 16
                    || length == 18 && BinaryPrimitives.ReadUInt16LittleEndian(chunk[16..]) != 0)
                    throw new InvalidDataException(FormatMessage);
                formatSeen = true;
            }
            else if (header[..4].SequenceEqual("data"u8))
            {
                if (!formatSeen || dataOffset >= 0 || length == 0 || length % 2 != 0)
                    throw new InvalidDataException(FormatMessage);
                if (length > 60 * 16000 * 2) throw new InvalidDataException("录音不能超过 60 秒。");
                dataOffset = start; dataLength = (int)length;
            }
            offset = start + (int)length;
            if (length % 2 != 0)
            {
                if (offset == audio.Length) throw new InvalidDataException(FormatMessage);
                ++offset; // RIFF chunks with an odd byte count have one padding byte.
            }
        }
        if (!formatSeen || dataOffset < 0) throw new InvalidDataException(FormatMessage);
        var samples = new float[dataLength / 2];
        for (var index = 0; index < samples.Length; ++index)
            samples[index] = BinaryPrimitives.ReadInt16LittleEndian(audio.AsSpan(dataOffset + index * 2)) / 32768f;
        return samples;
    }

    private static string Recognize(float[] samples, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var folder = BanbanVoiceModels.Extract("ICeClass.Voice.Asr.", "sensevoice-small-int8-2365baea");
        token.ThrowIfCancellationRequested();
        // Occasional student requests need no resident model cache. The process gate bounds native memory.
        using var recognizer = new SenseVoiceRecognizer(folder);
        token.ThrowIfCancellationRequested();
        return recognizer.Recognize(samples);
    }
}

using SherpaOnnx;

namespace ICeClass.Receiver;

/// <summary>One conversation follows its waking speaker. No identity or audio is persisted.</summary>
internal sealed class BanbanSpeakerFocus : IDisposable
{
    private readonly object _gate = new();
    private readonly SpeakerEmbeddingExtractor _extractor;
    private readonly SpeakerEmbeddingManager _speakers;
    private bool _focused;

    internal BanbanSpeakerFocus()
    {
        var folder = BanbanVoiceModels.Extract("ICeClass.Voice.Speaker.", "campplus-zh-en-20261027");
        _extractor = new(new SpeakerEmbeddingExtractorConfig {
            Model = Path.Combine(folder, "speaker.onnx"), NumThreads = 1, Provider = "cpu"
        });
        try { _speakers = new(_extractor.Dim); }
        catch { _extractor.Dispose(); throw; }
    }

    internal bool Focus(float[] samples)
    {
        lock (_gate)
        {
            ClearCore();
            var embedding = Embedding(samples);
            return _focused = embedding is not null && _speakers.Add("conversation", [embedding]);
        }
    }

    internal bool Matches(float[] samples)
    {
        lock (_gate)
        {
            if (!_focused) return false;
            var embedding = Embedding(samples);
            return embedding is not null && _speakers.Verify("conversation", embedding, .5f);
        }
    }

    private float[]? Embedding(float[] samples)
    {
        // Remove endpoint silence, keeping a small margin for quiet consonants.
        // Short answers remain valid; silence/noise cannot establish a speaker.
        var start = Array.FindIndex(samples, sample => Math.Abs(sample) > .01f);
        var end = Array.FindLastIndex(samples, sample => Math.Abs(sample) > .01f);
        if (start < 0 || end - start < 3200) return null;
        start = Math.Max(0, start - 1600); end = Math.Min(samples.Length, end + 1601);
        using var stream = _extractor.CreateStream();
        stream.AcceptWaveform(16000, samples.AsSpan(start, Math.Min(end - start, 6 * 16000)).ToArray());
        stream.InputFinished();
        if (!_extractor.IsReady(stream)) return null;
        var embedding = _extractor.Compute(stream);
        return embedding.Length > 0 && embedding.All(float.IsFinite) ? embedding : null;
    }

    internal void Clear() { lock (_gate) ClearCore(); }
    private void ClearCore()
    {
        if (_focused) _speakers.Remove("conversation");
        _focused = false;
    }
    public void Dispose()
    {
        lock (_gate) { ClearCore(); _speakers.Dispose(); _extractor.Dispose(); }
    }
}

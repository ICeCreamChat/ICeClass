using SherpaOnnx;

namespace ICeClass.Receiver;

/// <summary>Shared local utterance recognition for Banban and teacher voice messages.</summary>
internal sealed class SenseVoiceRecognizer : IDisposable
{
    private readonly OfflineRecognizer _recognizer;

    internal SenseVoiceRecognizer(string modelFolder, string language = "auto", bool useInverseTextNormalization = true)
    {
        var config = new OfflineRecognizerConfig();
        config.FeatConfig.SampleRate = 16000;
        config.FeatConfig.FeatureDim = 80;
        config.ModelConfig.SenseVoice.Model = Path.Combine(modelFolder, "model.int8.onnx");
        config.ModelConfig.SenseVoice.Language = language;
        config.ModelConfig.SenseVoice.UseInverseTextNormalization = useInverseTextNormalization ? 1 : 0;
        config.ModelConfig.Tokens = Path.Combine(modelFolder, "tokens.txt");
        config.ModelConfig.NumThreads = Math.Min(2, Environment.ProcessorCount);
        config.ModelConfig.Provider = "cpu";
        config.DecodingMethod = "greedy_search";
        _recognizer = new OfflineRecognizer(config);
    }

    internal string Recognize(float[] samples)
    {
        if (samples.Length == 0) return "";
        using var stream = _recognizer.CreateStream();
        stream.AcceptWaveform(16000, samples);
        _recognizer.Decode(stream);
        return stream.Result.Text.Trim();
    }

    public void Dispose() => _recognizer.Dispose();
}

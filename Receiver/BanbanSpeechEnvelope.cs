namespace ICeClass.Receiver;

/// <summary>A small speech-energy timeline, sampled by the output device's clock.</summary>
internal sealed class BanbanSpeechEnvelope
{
    private readonly double[] _rms;
    private readonly int _sampleRate, _samplesPerFrame, _sampleCount;
    private readonly double _reference, _volume;

    internal BanbanSpeechEnvelope(float[] samples, int sampleRate, float volume = 1)
    {
        if (sampleRate <= 0) throw new ArgumentOutOfRangeException(nameof(sampleRate));
        _sampleRate = sampleRate; _sampleCount = samples.Length;
        _samplesPerFrame = Math.Max(1, sampleRate / 50);
        _volume = Math.Clamp(volume, 0, 1);
        _rms = new double[(samples.Length + _samplesPerFrame - 1) / _samplesPerFrame];
        for (var frame = 0; frame < _rms.Length; frame++)
        {
            var start = frame * _samplesPerFrame;
            var count = Math.Min(_samplesPerFrame, samples.Length - start);
            var energy = 0d;
            for (var i = start; i < start + count; i++) energy += (double)samples[i] * samples[i];
            _rms[frame] = Math.Sqrt(energy / count);
        }
        // A phrase-relative reference keeps normal and softly spoken syllables
        // visible. The fixed floor keeps quiet gaps and digital noise closed.
        var ordered = (double[])_rms.Clone(); Array.Sort(ordered);
        _reference = ordered.Length == 0 ? .03 : Math.Max(.03, ordered[(int)((ordered.Length - 1) * .9)] - .006);
    }

    internal double OpeningAt(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds < 0 || seconds * _sampleRate >= _sampleCount) return 0;
        var frame = (int)(seconds * _sampleRate / _samplesPerFrame);
        var energy = Math.Clamp((_rms[frame] * _volume - .006) / _reference, 0, 1);
        return Math.Sqrt(energy);
    }
}

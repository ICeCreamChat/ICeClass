using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class NotificationChimeChecks
{
    internal static void Run(Action<bool, string> check)
    {
        check(NotificationChime.ForLevel("info") == NotificationCue.None
            && NotificationChime.ForLevel("warning") == NotificationCue.Important
            && NotificationChime.ForLevel("urgent") == NotificationCue.Urgent
            && NotificationChime.ForLevel("unknown") == NotificationCue.None,
            "only important and urgent notifications select a cue");

        var distinct = new List<float[]>();
        foreach (var rate in new[] { 8000, 16000, 22050, 44100, 48000 })
        {
            var speech = Enumerable.Range(0, rate / 5).Select(index => (float)(.12 * Math.Sin(index * .03))).ToArray();
            var bytes = new byte[speech.Length * sizeof(float)];
            Buffer.BlockCopy(speech, 0, bytes, 0, bytes.Length);
            RawSourceWaveStream Source() => new(new MemoryStream(bytes, false), WaveFormat.CreateIeeeFloatWaveFormat(rate, 1));
            using (var source = Source())
            {
                var provider = source.ToSampleProvider();
                check(ReferenceEquals(provider, NotificationChime.Prepend(provider, NotificationCue.None))
                    && ReadAll(provider).SequenceEqual(speech),
                    $"conversation and reminder audio stays unchanged without a cue at {rate} Hz");
            }
            foreach (var (cue, seconds) in new[] { (NotificationCue.Important, .66), (NotificationCue.Urgent, .67) })
            {
                using var source = Source();
                var provider = NotificationChime.Prepend(source.ToSampleProvider(), cue);
                var rendered = ReadAll(provider);
                var prefix = rendered.Length - speech.Length;
                var pause = (int)Math.Round(rate * .2);
                check(Math.Abs((double)prefix / rate - seconds - .2) < .005
                    && rendered.AsSpan(prefix - pause, pause).ToArray().All(value => value == 0)
                    && rendered.AsSpan(0, prefix - pause).ToArray().Max(Math.Abs) is > .05f and < .35f,
                    $"{cue} cue is short, softened and followed by a 0.2 second pause at {rate} Hz");
                check(rendered.AsSpan(prefix).SequenceEqual(speech) && provider.Read(new float[64], 0, 64) == 0,
                    $"{cue} cue plays once and preserves every original speech sample at {rate} Hz");
                if (rate == 22050) distinct.Add(rendered[..prefix]);
            }
        }
        check(distinct.Count == 2 && !distinct[0].SequenceEqual(distinct[1]),
            "important and urgent use distinct previewed sounds");

        using var quietSource = new RawSourceWaveStream(new MemoryStream(new byte[4410 * sizeof(float)]),
            WaveFormat.CreateIeeeFloatWaveFormat(22050, 1));
        var unscaled = ReadAll(NotificationChime.Prepend(quietSource.ToSampleProvider(), NotificationCue.Important));
        quietSource.Position = 0;
        var scaled = ReadAll(new VolumeSampleProvider(NotificationChime.Prepend(quietSource.ToSampleProvider(), NotificationCue.Important)) { Volume = .25f });
        check(unscaled.Length == scaled.Length && unscaled.Zip(scaled).All(pair => Math.Abs(pair.First * .25f - pair.Second) < 1e-7),
            "notification volume scales its cue and speech together");
    }

    private static float[] ReadAll(ISampleProvider provider)
    {
        var samples = new List<float>();
        var buffer = new float[317];
        int read;
        while ((read = provider.Read(buffer, 0, buffer.Length)) > 0) samples.AddRange(buffer.AsSpan(0, read).ToArray());
        return samples.ToArray();
    }
}

using System.Diagnostics;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class SenseVoiceAccuracyReview
{
    internal static void Run(string corpus, string output)
    {
        Directory.CreateDirectory(output);
        using var previous = JsonDocument.Parse(File.ReadAllText(Path.Combine(corpus, "speech-checks.json")));
        var rows = new List<object>();
        foreach (var setting in new[] { ("auto", true), ("auto", false), ("zh", true), ("zh", false) })
        {
            using var asr = new BanbanSpeechRecognizer(language: setting.Item1, useInverseTextNormalization: setting.Item2);
            var index = 0;
            foreach (var transcript in previous.RootElement.GetProperty("transcripts").EnumerateArray())
            {
                var expected = transcript.GetProperty("expected").GetString()!;
                var path = Path.Combine(corpus, "speech-" + index++ + ".wav");
                if (expected is not ("Open Steam" or "等差数列的前n项和" or "等比数列的前n项和" or "把验收文字改成Hello class" or "Open Word" or "Set the volume to forty percent")) continue;
                using var source = new AudioFileReader(path);
                var resampled = new WdlResamplingSampleProvider(source, 16000);
                var samples = new List<float>(); var frame = new float[800]; int count;
                while ((count = resampled.Read(frame, 0, frame.Length)) > 0) samples.AddRange(frame.AsSpan(0, count).ToArray());
                var watch = Stopwatch.StartNew();
                var actual = asr.Recognize(samples.ToArray()).Text;
                rows.Add(new { language = setting.Item1, itn = setting.Item2, expected, actual, milliseconds = watch.ElapsedMilliseconds });
                Console.WriteLine($"{setting.Item1} ITN={setting.Item2} {expected} => {actual}");
            }
        }
        File.WriteAllText(Path.Combine(output, "comparison.json"), JsonSerializer.Serialize(new { source = "same synthetic waveforms; not human speech", rows }, new JsonSerializerOptions { WriteIndented = true }));
    }
}

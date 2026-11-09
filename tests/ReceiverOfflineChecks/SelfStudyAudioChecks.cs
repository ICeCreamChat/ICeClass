using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;

/// <summary>Real local VAD/ASR on synthetic lessons, never the microphone or a paid model.</summary>
internal static class SelfStudyAudioChecks
{
    internal static void Run(string output)
    {
        Directory.CreateDirectory(output);
        var path = Path.Combine(output, "synthetic-lesson.wav");
        using (var synth = new SpeechSynthesizer())
        {
            var voice = synth.GetInstalledVoices().First(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "zh");
            synth.SelectVoice(voice.VoiceInfo.Name);
            synth.SetOutputToWaveFile(path, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.Speak(string.Concat(Enumerable.Repeat("这道题先移项再求解。为什么这个系数要变号？等式两边同时除以这个数。", 4)));
            synth.SetOutputToNull();
        }
        using var reader = new AudioFileReader(path);
        var source = new NAudio.Wave.SampleProviders.WdlResamplingSampleProvider(reader, 16000);
        var pcm = new List<float>(new float[32000]);
        var frame = new float[800];
        int size;
        while ((size = source.Read(frame, 0, frame.Length)) > 0) pcm.AddRange(frame.AsSpan(0, size).ToArray());
        pcm.AddRange(new float[32000]);
        using var activity = new BanbanVoiceActivity();
        var gate = new SelfStudyNoiseGate();
        using var segmenter = new BanbanSpeechSegmenter(8 * 16000, continuous: true,
            detectSpeech: s => gate.Accept(s, activity.Accept(s)));
        var clips = new List<BanbanSpeechAudio>();
        var buffer = new SelfStudyCandidateBuffer();
        SelfStudyCandidate? candidate = null;
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var offset = 0; offset < pcm.Count; offset += 800)
        {
            var samples = pcm.GetRange(offset, Math.Min(800, pcm.Count - offset)).ToArray();
            if (segmenter.Accept(samples) is not { } segment) continue;
            clips.Add(segment);
            var end = start + (offset + samples.Length) / 16;
            buffer.Add(segment, end);
            candidate ??= buffer.Take(end);
        }
        void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
            Console.WriteLine("PASS " + message);
        }
        Check(clips.Count >= 3 && clips.All(c => !c.TooLong && c.CapturedSamples <= 8 * 16000 + 800),
            "实际Silero连续讲题保持有界分段，不丢弃长发言");
        Check(clips.Sum(c => c.SpeechSamples) > 6 * 16000 && clips.Sum(c => c.SpeechSamples) < pcm.Count,
            "实际VAD有效人声与完整采集时间分开，静音不累计");
        Check(candidate is { Segments: >= 3 } && candidate.Clips.Zip(candidate.Clips.Skip(1)).All(p => p.First.EndAt <= p.Second.StartAt),
            "实际语音候选保留独立且不重叠的时间段");
        using var recognizer = new BanbanSpeechRecognizer();
        var utterances = SelfStudyMonitor.Transcribe(candidate!, s => recognizer.Recognize(s).Text, default);
        Check(utterances.Length >= 3 && utterances.Sum(u => u.Text.Length) <= 120,
            "实际SenseVoice逐段转写保持总输入上限");
        Check(utterances.Any(u => u.Text.Contains("题") || u.Text.Contains("等式") || u.Text.Contains("系数")),
            "合成讲题转写保留学习上下文供服务端优先排除");
        File.WriteAllText(Path.Combine(output, "result.json"), JsonSerializer.Serialize(new {
            source = "synthetic lesson; no classroom microphone, camera or paid AI",
            audioSeconds = pcm.Count / 16000d, speechSeconds = clips.Sum(c => c.SpeechSamples) / 16000d,
            capturedSeconds = clips.Sum(c => c.CapturedSamples) / 16000d,
            chunkCount = clips.Count, elapsedMs = watch.ElapsedMilliseconds, utterances
        }, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        Console.WriteLine("Self-study real VAD/ASR synthetic checks passed: 5");
    }
}

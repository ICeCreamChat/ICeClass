using System.Diagnostics;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;

/// <summary>Reproducible synthetic corpus through the real shipping VAD, gate, segmenter and ASR.</summary>
internal static class SelfStudyScenarioChecks
{
    private const int Rate = 16000;
    private sealed record Scenario(string Id, string Label, string[] Lines, int Repeats = 2,
        double Pause = .35, double Gain = 1, double? Snr = null, bool Echo = false,
        bool Overlap = false, string Noise = "", int Seconds = 0, string Language = "zh",
        bool RequireCandidate = false, bool RequireQuiet = false, bool Muffled = false,
        bool RequireScheduledFollowup = false);
    private sealed record Clip(long StartAt, long EndAt, int SpeechMs, int CapturedSamples,
        bool TooLong, string Text, double DecodeMs);
    private sealed record Window(long StartAt, long EndAt, int SpeechMs, int Segments,
        int LongestMs, double Level, SelfStudyUtterance[] Utterances);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    internal static void Run(string output)
    {
        Directory.CreateDirectory(output);
        var cache = Path.Combine(output, "tts");
        Directory.CreateDirectory(cache);
        using var synth = new SpeechSynthesizer();
        var voices = synth.GetInstalledVoices().Where(v => v.Enabled).Select(v => v.VoiceInfo).ToArray();
        var math = new[] { "这道题先移项再求解，注意等式两边的符号。", "为什么这个系数需要变号，我们再看一下计算过程。", "请把答案写在练习册上，再检查一遍方程的解。" };
        var qa = new[] { "老师，这道题我还是有点不明白，可以再解释一下吗？", "你先看看题目给出的条件，再把公式代进去计算。", "现在明白了，我再自己算一遍，谢谢老师。" };
        var chat = new[] { "放学以后我们去哪里吃饭，我想去新开的那家店。", "昨天那个游戏特别好玩，你今天晚上要不要一起玩？", "我周末买了新的球鞋，准备和朋友一起出去看电影。", "你刚才说的那个视频真有意思，等会儿发给我看看。" };
        var scenarios = new List<Scenario>
        {
            new("math-continuous", "teaching", math, Pause: 0, RequireCandidate: true),
            new("math-paused", "teaching", math, Pause: 2, RequireCandidate: true),
            new("study-qa", "study", qa, Pause: 1.6, RequireCandidate: true),
            new("literature", "teaching", ["我们一起朗读这篇课文，注意作者描述景物的顺序。", "这里写的是思念故乡的感受，请结合上下文理解。", "接下来找出课文中的比喻，想一想这样写有什么作用。"], RequireCandidate: true),
            new("history", "teaching", ["同学们，我们接着分析这段历史材料的背景。", "工业革命改变了生产方式，也推动了城市的发展。", "请从经济和社会两个方面解释变化的原因。"], RequireCandidate: true),
            new("science", "teaching", ["植物通过光合作用把光能转化为化学能。", "我们对照实验记录，观察光照强弱造成的变化。", "请根据实验现象解释绿色植物释放氧气的过程。"], RequireCandidate: true),
            new("everyday-teaching-example", "teaching", ["我们用一个生活中的例子来理解刚才的内容。", "假设你和朋友约好周末看电影，却临时改变了时间。", "这里讨论的是约定和责任之间的关系，请解释理由。"], RequireCandidate: true),
            new("english-lesson", "teaching", ["Read this sentence and explain the grammar. The present perfect connects the past with the present.", "Look at the verb in this question. Discuss your answer with your partner."], Language: "en", RequireCandidate: true),
            new("brief-normal-exchange", "normal", ["谢谢。", "借我一支笔。", "好，给你。"], Repeats: 1, Pause: 5, RequireQuiet: true),
            new("brief-chat", "chat-short", ["周末看电影吗？", "好啊，晚点再说。"], Repeats: 1, Pause: 4, RequireQuiet: true),
            new("chat-continuous", "chat", chat, Pause: 0, RequireCandidate: true),
            new("chat-paused", "chat", chat, Pause: 2, RequireCandidate: true),
            new("chat-long", "chat", chat, Repeats: 6, Pause: 2, RequireCandidate: true, RequireScheduledFollowup: true),
            new("teaching-cooldown-example", "teaching", ["这道题用周末约朋友看电影来说明约定和责任，接下来都是这个例子的分析。", .. chat], Repeats: 4, Pause: 2),
            new("chat-academic-word", "chat-with-academic-cue", ["今天的作业终于写完了，晚上一起玩游戏怎么样？", "我已经约好了朋友，放学去新开的店吃饭。", "周末我们再一起去看电影，你想看哪一部？"], RequireCandidate: true),
            new("silence", "non-speech", [], Seconds: 90, RequireQuiet: true),
            new("fan", "non-speech", [], Noise: "fan", Seconds: 90, RequireQuiet: true),
            new("impulses", "non-speech", [], Noise: "impulses", Seconds: 60, RequireQuiet: true),
            new("tones", "non-speech", [], Noise: "tones", Seconds: 60, RequireQuiet: true),
            new("quiet-chat", "chat", chat, Gain: .06),
            new("below-floor-chat", "chat-low-level", chat, Gain: .003),
            new("chat-overlap", "chat", chat, Overlap: true),
            new("study-overlap", "study", qa, Overlap: true),
            new("chat-echo", "chat", chat, Echo: true),
            new("study-echo", "study", qa, Echo: true),
            new("distant-study", "study", qa, Gain: .08, Snr: 10, Muffled: true),
            new("corridor-chat", "external-speech", chat, Gain: .08, Snr: 10, Muffled: true),
        };
        foreach (var snr in new[] { 20d, 10d, 0d, -5d })
        {
            scenarios.Add(new($"math-fan-snr-{snr}", "teaching", math, Snr: snr));
            scenarios.Add(new($"chat-fan-snr-{snr}", "chat", chat, Snr: snr, RequireCandidate: snr >= 10));
        }
        // A ten-minute stream checks recurrent VAD/gate/segment lifecycle with actual model calls.
        scenarios.Add(new("ten-minute-mixed", "mixed-soak", [.. math, .. chat, .. qa], Repeats: 20, Pause: 2, Snr: 10, Seconds: 600));
        var spoken = new Dictionary<(string, string, int), float[]>();
        float[] Speak(string line, string language, int speed)
        {
            var key = (line, language, speed);
            if (spoken.TryGetValue(key, out var existing)) return existing;
            var voice = voices.First(v => v.Culture.TwoLetterISOLanguageName == language);
            synth.SelectVoice(voice.Name);
            synth.Rate = speed;
            var path = Path.Combine(cache, $"{spoken.Count:D3}.wav");
            synth.SetOutputToWaveFile(path, new SpeechAudioFormatInfo(Rate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.Speak(line);
            synth.SetOutputToNull();
            using var reader = new AudioFileReader(path);
            var samples = new float[reader.Length / sizeof(float)];
            var count = reader.Read(samples, 0, samples.Length);
            return spoken[key] = samples[..count];
        }

        var results = new List<object>();
        var failures = new List<string>();
        var checks = 0;
        void Check(bool condition, string message)
        {
            checks++;
            if (!condition) { failures.Add(message); Console.WriteLine("FAIL " + message); }
        }
        using var process = Process.GetCurrentProcess();
        var total = Stopwatch.StartNew();
        var cpuStart = process.TotalProcessorTime;
        var modelLoad = Stopwatch.StartNew();
        using var recognizer = new BanbanSpeechRecognizer();
        var modelLoadMs = modelLoad.Elapsed.TotalMilliseconds;
        foreach (var scenario in scenarios)
        {
            var reference = new List<string>();
            var stream = new List<float>(new float[2 * Rate]);
            for (var repeat = 0; repeat < scenario.Repeats; repeat++)
                for (var i = 0; i < scenario.Lines.Length; i++)
                {
                    stream.AddRange(Speak(scenario.Lines[i], scenario.Language, i % 2 == 0 ? 0 : -1));
                    reference.Add(scenario.Lines[i]);
                    stream.AddRange(new float[(int)(scenario.Pause * Rate)]);
                }
            stream.AddRange(new float[2 * Rate]);
            var pcm = stream.ToArray();
            if (scenario.Seconds > 0)
            {
                Array.Resize(ref pcm, scenario.Seconds * Rate);
                // Only use reference CER for scenarios without cropped speech.
                if (scenario.Lines.Length > 0) reference.Clear();
            }
            if (scenario.Overlap)
            {
                // Different utterances and speaking rate, still one synthetic voice, not real speakers.
                var second = new List<float>(new float[Rate + Rate / 2]);
                for (var repeat = 0; repeat < scenario.Repeats; repeat++)
                    foreach (var line in scenario.Lines.Reverse())
                    {
                        second.AddRange(Speak(line, scenario.Language, 2));
                        second.AddRange(new float[Rate / 3]);
                    }
                for (var i = 0; i < Math.Min(pcm.Length, second.Count); i++) pcm[i] += .65f * second[i];
                reference.Clear();
            }
            if (scenario.Muffled)
            {
                var previous = 0f;
                for (var i = 0; i < pcm.Length; i++) pcm[i] = previous += .12f * (pcm[i] - previous);
            }
            if (scenario.Echo)
            {
                var original = pcm.ToArray();
                for (var i = 0; i < pcm.Length; i++)
                {
                    if (i >= 960) pcm[i] += .35f * original[i - 960];
                    if (i >= 2080) pcm[i] += .2f * original[i - 2080];
                }
            }
            var nonzero = pcm.Where(s => Math.Abs(s) > .0001).ToArray();
            var speechRms = nonzero.Length == 0 ? 0 : Math.Sqrt(nonzero.Average(s => (double)s * s));
            var noiseRms = scenario.Snr is { } snr ? speechRms / Math.Pow(10, snr / 20) : .02;
            var random = new Random(59240);
            var noise = new float[pcm.Length];
            for (var i = 0; i < noise.Length; i++)
            {
                var seconds = i / (double)Rate;
                if (scenario.Snr is not null || scenario.Noise == "fan")
                    noise[i] = (float)(Math.Sin(seconds * 2 * Math.PI * 120) + .35 * Math.Sin(seconds * 2 * Math.PI * 240) + .3 * (2 * random.NextDouble() - 1));
                else if (scenario.Noise == "impulses" && i % (3 * Rate) < 2000)
                    noise[i] = (float)((2 * random.NextDouble() - 1) * Math.Exp(-(i % (3 * Rate)) / 400d));
                else if (scenario.Noise == "tones")
                    noise[i] = (float)(Math.Sin(seconds * 2 * Math.PI * (440 + ((i / Rate) % 4) * 110)) * (i % Rate < Rate / 2 ? 1 : 0));
            }
            var actualNoiseRms = Math.Sqrt(noise.Average(s => (double)s * s));
            var clipped = 0;
            for (var i = 0; i < pcm.Length; i++)
            {
                var value = scenario.Gain * (pcm[i] + (actualNoiseRms == 0 ? 0 : noise[i] * noiseRms / actualNoiseRms));
                if (Math.Abs(value) > 1) clipped++;
                pcm[i] = (float)Math.Clamp(value, -1, 1);
            }
            var path = Path.Combine(output, scenario.Id + ".wav");
            using (var wav = new WaveFileWriter(path, new WaveFormat(Rate, 16, 1))) wav.WriteSamples(pcm, 0, pcm.Length);
            // Replay exactly the saved 16-bit samples, matching the production microphone format.
            using (var wav = new AudioFileReader(path))
                if (wav.Read(pcm, 0, pcm.Length) != pcm.Length) throw new InvalidOperationException("Incomplete synthetic WAV");
            var watch = Stopwatch.StartNew();
            var beforeCpu = process.TotalProcessorTime;
            using var activity = new BanbanVoiceActivity();
            var gate = new SelfStudyNoiseGate();
            long rawSpeechSamples = 0, acceptedSpeechSamples = 0;
            using var segmenter = new BanbanSpeechSegmenter(8 * Rate, continuous: true,
                detectSpeech: s =>
                {
                    var raw = activity.Accept(s);
                    var accepted = gate.Accept(s, raw);
                    if (raw) rawSpeechSamples += s.Length;
                    if (accepted) acceptedSpeechSamples += s.Length;
                    return accepted;
                });
            var buffer = new SelfStudyCandidateBuffer();
            var scheduledBuffer = new SelfStudyCandidateBuffer();
            var windows = new List<Window>();
            var scheduledWindows = new List<Window>();
            long nextReview = 0;
            var clips = new List<Clip>();
            var decoded = new Dictionary<float[], string>();
            var vadTimes = new List<double>();
            var maxBufferClips = 0;
            var decodeMs = 0d;
            for (var offset = 0; offset < pcm.Length; offset += 800)
            {
                var frame = pcm.AsSpan(offset, Math.Min(800, pcm.Length - offset)).ToArray();
                var started = Stopwatch.GetTimestamp();
                var segment = segmenter.Accept(frame);
                vadTimes.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                if (segment is null) continue;
                var end = (offset + frame.Length) / 16;
                var text = "";
                var elapsed = 0d;
                if (!segment.TooLong && segment.SpeechSamples >= 4800)
                {
                    started = Stopwatch.GetTimestamp();
                    text = recognizer.Recognize(segment.Samples).Text;
                    elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                    decodeMs += elapsed;
                    decoded[segment.Samples] = text;
                }
                clips.Add(new(end - segment.CapturedSamples / 16, end, segment.SpeechSamples / 16,
                    segment.CapturedSamples, segment.TooLong, text, elapsed));
                buffer.Add(segment, end);
                scheduledBuffer.Add(segment, end);
                if (end >= nextReview && scheduledBuffer.Take(end) is { } scheduled)
                {
                    var scheduledUtterances = SelfStudyMonitor.Transcribe(scheduled, samples => decoded[samples], default);
                    scheduledWindows.Add(new(scheduled.StartAt, scheduled.EndAt, scheduled.SpeechMs, scheduled.Segments,
                        scheduled.LongestMs, scheduled.Level, scheduledUtterances));
                    nextReview = end + 90000;
                }
                maxBufferClips = Math.Max(maxBufferClips, buffer.Count);
                if (buffer.Take(end) is not { } candidate) continue;
                var utterances = SelfStudyMonitor.Transcribe(candidate, samples => decoded[samples], default);
                windows.Add(new(candidate.StartAt, candidate.EndAt, candidate.SpeechMs, candidate.Segments,
                    candidate.LongestMs, candidate.Level, utterances));
                Check(candidate.Clips.Zip(candidate.Clips.Skip(1)).All(p => p.First.EndAt <= p.Second.StartAt), scenario.Id + ": evidence intervals do not overlap");
                Check(utterances.Length == 0 || utterances.Sum(u => u.Text.Length) <= 120, scenario.Id + ": bounded ASR payload");
                var fullTexts = candidate.Clips.Select(c => decoded[c.Samples].Trim()).ToArray();
                Check(fullTexts.Any(string.IsNullOrEmpty) || fullTexts.Sum(t => t.Length) > 120
                    ? utterances.Length == 0
                    : utterances.Select(u => u.Text).SequenceEqual(fullTexts), scenario.Id + ": complete context or abstention");
            }
            Check(clips.All(c => !c.TooLong && c.CapturedSamples <= 128800), scenario.Id + ": bounded speech chunks");
            Check(maxBufferClips <= 6, scenario.Id + ": bounded candidate buffer");
            if (scenario.RequireQuiet) Check(windows.Count == 0, scenario.Id + ": no candidate from silence, noise or brief exchanges");
            if (scenario.RequireCandidate) Check(windows.Count > 0, scenario.Id + ": sustained clear speech produces a local candidate");
            if (scenario.RequireScheduledFollowup) Check(scheduledWindows.Count(w => w.Utterances.Length >= 3) >= 2,
                scenario.Id + ": complete evidence survives the real 90-second review cadence");
            var orderedTimes = vadTimes.Order().ToArray();
            process.Refresh();
            results.Add(new { scenario, sampleRate = Rate, audioSeconds = pcm.Length / (double)Rate,
                referenceText = string.Concat(reference), voice = voices.First(v => v.Culture.TwoLetterISOLanguageName == scenario.Language).Name,
                speechRms = speechRms * scenario.Gain, noiseRms = actualNoiseRms == 0 ? 0 : noiseRms * scenario.Gain,
                clippedSamples = clipped, elapsedMs = watch.Elapsed.TotalMilliseconds,
                cpuMs = (process.TotalProcessorTime - beforeCpu).TotalMilliseconds,
                vadMs = vadTimes.Sum(), vadP99Ms = orderedTimes[(int)((orderedTimes.Length - 1) * .99)],
                vadMaxMs = orderedTimes[^1], decodeMs, workingSetBytes = process.WorkingSet64,
                privateBytes = process.PrivateMemorySize64, rawSpeechMs = rawSpeechSamples / 16,
                acceptedSpeechMs = acceptedSpeechSamples / 16, clips, windows, scheduledWindows });
            Console.WriteLine($"{scenario.Id}: {pcm.Length / (double)Rate:F1}s audio, {clips.Count} clips, {windows.Count} windows, {watch.Elapsed.TotalMilliseconds:F0}ms");
            File.WriteAllText(Path.Combine(output, "results.json"), JsonSerializer.Serialize(new
            {
                source = "Windows local synthesized speech; fixed seed; no microphone/camera/remote AI",
                semantics = "Not measured here. Full actual ASR and bounded production text are retained for isolated server replay.",
                timing = "Offline sequential replay with one shared ASR instance. Includes diagnostic decoding of every speech clip; not target-device utilization.",
                cadence = "scheduledWindows uses the production buffer/Transcribe at a 90-second review interval. Provider-specific longer cooldown and async capture timing are not simulated.",
                modelLoadMs, elapsedMs = total.Elapsed.TotalMilliseconds,
                cpuMs = (process.TotalProcessorTime - cpuStart).TotalMilliseconds,
                peakWorkingSetBytes = process.PeakWorkingSet64, checks, failures,
                completed = results.Count == scenarios.Count, expectedScenarioCount = scenarios.Count, scenarios = results
            }, Json));
        }
        Console.WriteLine($"Self-study acoustic scenario checks: {checks - failures.Count}/{checks}; cases: {scenarios.Count}");
        if (failures.Count != 0) throw new InvalidOperationException(string.Join(Environment.NewLine, failures));
    }
}

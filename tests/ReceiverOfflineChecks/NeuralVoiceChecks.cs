using System.Diagnostics;
using System.Collections.Concurrent;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class NeuralVoiceChecks
{
    // Consume the actual server speech events; do not invent a second formula
    // converter or capture a microphone to test synthesized playback.
    internal static void RunFormulaReview(string input, string output)
    {
        Directory.CreateDirectory(output);
        using var report = JsonDocument.Parse(File.ReadAllText(input));
        if (!report.RootElement.GetProperty("passed").GetBoolean()) throw new InvalidOperationException("Formula conversion review has not passed.");
        var phrases = report.RootElement.GetProperty("checks").EnumerateArray()
            .Select(row => BanbanVoiceService.SpeechText(row.GetProperty("speech").GetString() ?? "")).ToArray();
        if (phrases.Length == 0 || phrases.Any(string.IsNullOrWhiteSpace)) throw new InvalidDataException("Formula speech is empty.");
        var samplesReport = new List<object>();
        using (var synthesizer = new BanbanNeuralSynthesizer())
        {
            foreach (var phrase in phrases)
            {
                var watch = Stopwatch.StartNew();
                var samples = synthesizer.Generate(phrase);
                if (samples.Length < 8000 || samples.Any(sample => !float.IsFinite(sample)) || samples.Max(Math.Abs) < .02f)
                    throw new InvalidDataException("Formula synthesis did not produce usable audio.");
                var path = Path.Combine(output, "formula-" + samplesReport.Count + ".wav");
                using (var wave = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(synthesizer.SampleRate, 1)))
                    wave.WriteSamples(samples, 0, samples.Length);
                samplesReport.Add(new { text = phrase, file = Path.GetFileName(path), sampleRate = synthesizer.SampleRate,
                    seconds = (double)samples.Length / synthesizer.SampleRate, synthesisMs = watch.ElapsedMilliseconds });
                Console.WriteLine("PASS formula neural synthesis: " + phrase);
            }
        }
        var completed = new ConcurrentQueue<long>();
        var played = new ConcurrentQueue<string>();
        var errors = new ConcurrentQueue<Exception>();
        using (var player = new BanbanSpeechPlayer(completed.Enqueue, (_, text) => played.Enqueue(text), errors.Enqueue))
        {
            if (!SpinWait.SpinUntil(() => player.Ready || !errors.IsEmpty, TimeSpan.FromSeconds(30)) || !player.Ready)
                throw new InvalidOperationException("Neural playback did not become ready.");
            var generation = player.Generation;
            player.Enqueue(phrases[0], true);
            if (!SpinWait.SpinUntil(() => completed.Contains(generation) || !errors.IsEmpty, TimeSpan.FromSeconds(40))
                || !completed.Contains(generation) || !played.Contains(phrases[0]) || !errors.IsEmpty)
                throw new InvalidOperationException("The actual formula did not play to completion.");
        }
        File.WriteAllText(Path.Combine(output, "formula-neural-review.json"), JsonSerializer.Serialize(new {
            source = "actual server speech events, bundled neural synthesis and default Windows output; no microphone recording",
            passed = true, synthesis = samplesReport, completedPlayback = phrases[0],
            limitation = "Audio generation and completion do not establish human listening intelligibility."
        }, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine("PASS actual formula played to completion on the Windows default output.");
    }

    internal static void Run(string output, string? modelFolder = null)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>(); var synthesis = new List<object>();
        var failures = new List<string>();
        void Check(bool value, string name)
        {
            checks.Add(new { name, passed = value }); Console.WriteLine((value ? "PASS " : "FAIL ") + name);
            if (!value) failures.Add(name);
        }
        var watch = Stopwatch.StartNew();
        using var voice = new BanbanNeuralSynthesizer(modelFolder,
            threads:int.TryParse(Environment.GetEnvironmentVariable("ICECLASS_NEURAL_THREADS"), out var threads) ? threads : null,
            debug:Environment.GetEnvironmentVariable("ICECLASS_NEURAL_DEBUG") == "1");
        var startupMs = watch.ElapsedMilliseconds;
        Check(voice.SampleRate >= 22050, "neural Chinese voice loads offline at a speech sample rate of at least 22 kHz");
        using var recognizer = new BanbanSpeechRecognizer();
        using var vad = new BanbanVoiceActivity();
        Check(!Enumerable.Range(0, 80).Any(_ => vad.Accept(new float[512])), "VAD does not classify digital silence as speech");
        Check(BanbanLocalAudio.CanBargeIn("打开数学课件", "您可以让我查看课表"), "a new ordinary command can interrupt speech");
        Check(!BanbanLocalAudio.CanBargeIn("查看课表", "您可以让我查看课表")
            && !BanbanLocalAudio.CanBargeIn("确认执行", "请核对操作")
            && !BanbanLocalAudio.CanBargeIn("打开", "请核对操作"), "echo, incomplete words and consent cannot become a barge-in task");
        foreach (var sentence in new[] { "我在，请说。", "请说。", "我在。请说。", "打开数学课件", "把验收文字改成今天开始上课", "班班停一下", "已经打开数学课件。", "音量已调到百分之四十。", "高一一班今天有效发声九分三十秒。" })
        {
            watch.Restart(); var samples = voice.Generate(sentence); var elapsed = watch.ElapsedMilliseconds;
            var seconds = (double)samples.Length / voice.SampleRate;
            Check(samples.Length > 8000 && samples.All(float.IsFinite) && samples.Max(Math.Abs) > .02f,
                "real neural synthesis returns usable audio: " + sentence);
            var path = Path.Combine(output, "neural-" + synthesis.Count + ".wav");
            using (var wave = new WaveFileWriter(path, WaveFormat.CreateIeeeFloatWaveFormat(voice.SampleRate, 1))) wave.WriteSamples(samples, 0, samples.Length);
            vad.Reset(); var speech = false;
            var raw = new byte[samples.Length * sizeof(float)]; Buffer.BlockCopy(samples, 0, raw, 0, raw.Length);
            using var memory = new MemoryStream(raw, false);
            using var source = new RawSourceWaveStream(memory, WaveFormat.CreateIeeeFloatWaveFormat(voice.SampleRate, 1));
            var resampled = new WdlResamplingSampleProvider(source.ToSampleProvider(), 16000);
            var buffer = new float[512]; int count; var utterance = new List<float>();
            while ((count = resampled.Read(buffer, 0, buffer.Length)) > 0)
            {
                var frame = buffer.AsSpan(0, count).ToArray(); speech |= vad.Accept(frame);
                utterance.AddRange(frame);
            }
            var text = recognizer.Recognize(utterance.ToArray()).Text;
            Console.WriteLine($"NEURAL {sentence} => {text}; {elapsed}ms / {seconds:F2}s");
            if (BanbanVoiceService.Normalize(sentence).Length >= 3)
                Check(speech, "real synthesized speech is detected by the bundled VAD: " + sentence);
            var expected = BanbanVoiceService.Normalize(sentence); var actual = BanbanVoiceService.Normalize(text).Replace("斑斑", "班班").Replace("班伴", "班班");
            var edit = new int[expected.Length + 1, actual.Length + 1];
            for (var i = 0; i <= expected.Length; i++) edit[i, 0] = i;
            for (var j = 0; j <= actual.Length; j++) edit[0, j] = j;
            for (var i = 1; i <= expected.Length; i++) for (var j = 1; j <= actual.Length; j++)
                edit[i, j] = Math.Min(edit[i - 1, j] + 1, Math.Min(edit[i, j - 1] + 1, edit[i - 1, j - 1] + (expected[i - 1] == actual[j - 1] ? 0 : 1)));
            // TTS -> ASR measures both models together, including homophones.
            // This diagnostic does not establish human microphone accuracy.
            synthesis.Add(new { sentence, recognized = text, synthesisMs = elapsed, seconds,
                realTimeFactor = elapsed / (seconds * 1000), vadDetected = speech,
                characterErrorRate = (double)edit[expected.Length, actual.Length] / expected.Length });
        }
        Check(voice.Generate("不应播放", () => false).Length == 0, "cancelled neural generation yields no playable audio");
        if (modelFolder is null)
        {
            var completed = new ConcurrentQueue<long>(); var playing = new ConcurrentQueue<(long Generation, string Text)>();
            var errors = new ConcurrentQueue<Exception>();
            using var player = new BanbanSpeechPlayer(generation => completed.Enqueue(generation),
                (generation, text) => playing.Enqueue((generation, text)), errors.Enqueue);
            Check(SpinWait.SpinUntil(() => player.Ready || !errors.IsEmpty, TimeSpan.FromSeconds(30)) && player.Ready,
                "bundled natural voice prewarms and starts its playback worker");
            player.Enqueue("这是本机播放检查，这段声音会被中途停止。", false);
            player.Enqueue("这段排队的旧播报不应播放。", true);
            Check(SpinWait.SpinUntil(() => !playing.IsEmpty || !errors.IsEmpty, TimeSpan.FromSeconds(25)) && !playing.IsEmpty,
                "real default Windows output begins neural playback");
            var oldGeneration = player.Generation; player.Stop();
            var countAfterStop = playing.Count;
            player.Enqueue("播放检查已经完成。", true);
            Check(SpinWait.SpinUntil(() => completed.Contains(player.Generation) || !errors.IsEmpty, TimeSpan.FromSeconds(25))
                && completed.Contains(player.Generation), "fresh speech plays to completion after interruption");
            Check(!completed.Contains(oldGeneration) && playing.Skip(countAfterStop).All(p => p.Generation != oldGeneration),
                "cancelled synthesis and queued audio never resume after stop");
            player.Dispose(); player.Dispose();
            Check(errors.IsEmpty, "playback stops and disposes repeatedly without audio failures");
        }
        File.WriteAllText(Path.Combine(output, "neural-checks.json"), JsonSerializer.Serialize(new {
            source = "generated test speech; no microphone recordings", startupMs, synthesis, checks,
            workingSetMiB = Process.GetCurrentProcess().WorkingSet64 / 1048576.0
        }, new JsonSerializerOptions { WriteIndented = true }));
        if (failures.Count > 0) throw new InvalidOperationException(string.Join("; ", failures));
    }
}

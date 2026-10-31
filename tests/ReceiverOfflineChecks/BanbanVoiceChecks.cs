using System.Diagnostics;
using System.Collections.Concurrent;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using System.Text.Json;
using NAudio.Wave;
using ICeClass.Receiver;

internal static class BanbanVoiceChecks
{
    internal static void Run(string output, string? modelFolder = null, bool boundariesOnly = false)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        var transcripts = new List<object>();
        var failures = new List<string>();
        void Check(bool condition, string name)
        {
            checks.Add(new { name, passed = condition });
            Console.WriteLine((condition ? "PASS " : "FAIL ") + name);
            if (!condition) failures.Add(name);
        }
        void Save() => File.WriteAllText(Path.Combine(output, "speech-checks.json"), JsonSerializer.Serialize(new {
            engine = BanbanSpeechRecognizer.EngineName, transcripts,
            source = "synthetic Chinese, English and code-switched speech; not a human classroom microphone test", checks
        }, new JsonSerializerOptions { WriteIndented = true }));
        var unstartedEcho = new BanbanEchoMicrophone((_, _) => { }, _ => { });
        unstartedEcho.Dispose(); unstartedEcho.Dispose();
        Check(!unstartedEcho.Ready, "microphone startup failure can dispose an unstarted echo worker safely and repeatedly");
        Check(BanbanVoiceService.WakeRemainder("你好，班班！") == "", "punctuated Chinese wake phrase");
        Check(BanbanVoiceService.WakeRemainder("你好班班，打开数学课件") == "打开数学课件", "wake and task text parsing");
        Check(BanbanVoiceService.WakeRemainder("同学们请打开课件") is null, "ordinary classroom speech is not a wake request");
        Check(BanbanVoiceService.Intent("班班，取消操作。") == "cancel", "explicit cancellation is distinct from interrupting speech");
        Check(BanbanVoiceService.Intent("班班停一下") == "interrupt", "spoken interruption");
        foreach (var phrase in new[] { "等一下", "班班等一下", "先停一下", "暂停播报", "别念了" })
        {
            Check(BanbanVoiceService.Intent(phrase) == "interrupt", "natural short stop remains distinct from cancellation: " + phrase);
            Check(BanbanVoiceService.SpeechControl(phrase) == "班班停一下", "short stop crosses the playback boundary: " + phrase);
            Check(BanbanVoiceService.SpeechControl(BanbanVoiceService.SpeechText("您可以说" + phrase)) is null,
                "spoken help cannot trigger its own stop phrase: " + phrase);
        }
        Check(BanbanVoiceService.Intent("再见班班") == "leave", "return to standby");
        Check(BanbanVoiceService.Intent("斑斑，取消操作") == "cancel", "phonetic name variants retain the explicit control intent");
        Check(BanbanVoiceService.SpeechControl("播报中间的文字，班班停一下") == "班班停一下", "interruption can follow microphone speaker echo");
        Check(BanbanVoiceService.SpeechControl("斑斑听一下") == "班班停一下", "named interruption tolerates the stop/listen homophone");
        Check(BanbanVoiceService.SpeechControl("确认执行") is null && BanbanVoiceService.SpeechControl("把验收文字改成课程开始") is null,
            "speaking boundary never accepts consent or an ordinary task");
        Check(BanbanVoiceService.SpeechControl("取消操作") is null && BanbanVoiceService.SpeechControl("班班取消操作") == "班班取消操作",
            "cancellation during TTS still requires the assistant name");
        Check(BanbanVoiceService.SpeechControl(BanbanVoiceService.SpeechText("请说斑斑听一下、班班停一下，或者班伴取消操作。")) is null,
            "TTS sanitizes the complete control vocabulary against self-interruption");
        Check(!BanbanVoiceService.Normalize(BanbanVoiceService.SpeechText("请说你好，班班；或班班，取消操作。")).Contains("你好班班")
            && !BanbanVoiceService.Normalize(BanbanVoiceService.SpeechText("请说班班，取消操作。")).Contains("班班取消操作"), "spoken instructions cannot echo punctuated wake or cancellation keywords");
        Check(BanbanVoiceService.Normalize("Open PowerPoint") == BanbanVoiceService.Normalize("OPEN POWERPOINT"),
            "bilingual deduplication and playback echo comparisons ignore letter case");
        foreach (var text in new[] { "打开<unk>", "确认<UNK>执行", "取消[unk]操作", "< unknown >班班停一下", "打开\uFFFD" })
            Check(BanbanVoiceService.HasUnrecognizedSpeech(text) && BanbanVoiceService.SpeechControl(text) is null
                && !BanbanLocalAudio.CanBargeIn(text, "正在播报"), "unknown speech cannot become a control or barge-in task: " + text);
        Check(!BanbanVoiceService.HasUnrecognizedSpeech("Open Word, Excel, PowerPoint and Chrome"), "ordinary English is valid recognized text");

        string SynthesizeSegments(string name, params (string Text, string Language)[] segments)
        {
            var path = Path.Combine(output, name + ".wav");
            using var synth = new SpeechSynthesizer();
            var prompt = new PromptBuilder();
            foreach (var segment in segments)
            {
                var voice = synth.GetInstalledVoices().First(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == segment.Language);
                prompt.StartVoice(voice.VoiceInfo.Name); prompt.AppendText(segment.Text); prompt.EndVoice();
            }
            synth.SetOutputToWaveFile(path, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            synth.Speak(prompt); synth.SetOutputToNull();
            return path;
        }
        string Synthesize(string name, string sentence) => SynthesizeSegments(name, (sentence, "zh"));
        static IEnumerable<float[]> Frames(string path)
        {
            using var reader = new AudioFileReader(path);
            var resampled = new NAudio.Wave.SampleProviders.WdlResamplingSampleProvider(reader, 16000);
            var samples = new float[800]; int count;
            while ((count = resampled.Read(samples, 0, samples.Length)) > 0) yield return samples.AsSpan(0, count).ToArray();
            for (var i = 0; i < 50; i++) yield return new float[800];
        }
        using var asr = new BanbanSpeechRecognizer(modelFolder);
        using var segmenter = new BanbanSpeechSegmenter();
        Check(Enumerable.Range(0, 120).All(_ => segmenter.Accept(new float[800]) is null),
            "six seconds of silence never become an utterance or request");
        var corpus = new (string Expected, (string Text, string Language)[] Segments)[] {
            ("把验收文字改成今天开始上课", [("把验收文字改成今天开始上课", "zh")]),
            ("确认执行", [("确认执行", "zh")]), ("取消操作", [("取消操作", "zh")]), ("打开数学课件", [("打开数学课件", "zh")]),
            ("退下吧", [("退下吧", "zh")]),
            ("Open Word", [("Open Word", "en")]), ("Open Excel", [("Open Excel", "en")]),
            ("Open PowerPoint", [("Open PowerPoint", "en")]), ("Open Google Chrome", [("Open Google Chrome", "en")]),
            ("Open Steam", [("Open Steam", "en")]),
            ("Please open the browser and search for English lesson plans", [("Please open the browser and search for English lesson plans", "en")]),
            ("Set the volume to forty percent", [("Set the volume to forty percent", "en")]),
            ("帮我打开PowerPoint", [("帮我打开", "zh"), ("PowerPoint", "en")]),
            ("打开Word文档", [("打开", "zh"), ("Word", "en"), ("文档", "zh")]),
            ("打开Chrome浏览器", [("打开", "zh"), ("Chrome", "en"), ("浏览器", "zh")]),
            ("把验收文字改成Hello class", [("把验收文字改成", "zh"), ("Hello class", "en")]),
            ("打开Excel", [("打开", "zh"), ("Excel", "en")]),
            ("打开Steam", [("打开", "zh"), ("Steam", "en")]),
            ("Please open Word", [("Please open Word", "en")]),
            ("The students are reading quietly", [("The students are reading quietly", "en")]),
            ("等差数列的前n项和", [("等差数列的前", "zh"), ("n", "en"), ("项和", "zh")]),
            ("等比数列的前n项和", [("等比数列的前", "zh"), ("n", "en"), ("项和", "zh")]),
            ("Hello class", [("Hello class", "en")]),
        };
        foreach (var sample in corpus.Where(_ => !boundariesOnly))
        {
            segmenter.Reset();
            var sentence = sample.Expected;
            var path = SynthesizeSegments("speech-" + transcripts.Count, sample.Segments);
            var updates = new List<BanbanSpeechResult>();
            var endpoints = new List<object>(); var audioSamples = 0;
            var watch = Stopwatch.StartNew();
            segmenter.Accept(new float[8000]);
            foreach (var samples in Frames(path))
            {
                audioSamples += samples.Length;
                var audio = segmenter.Accept(samples);
                if (audio is null) continue;
                var result = asr.Recognize(audio.Samples);
                updates.Add(result); endpoints.Add(new { seconds = audioSamples / 16000d, result.Text });
            }
            var finals = updates.Where(r => r.Final && r.Text.Length > 0).Select(r => r.Text).ToArray();
            var actual = string.Join("", finals);
            using var waveform = new WaveFileReader(path);
            var audioSeconds = waveform.TotalTime.TotalSeconds;
            var milliseconds = watch.ElapsedMilliseconds;
            var alternatives = sentence == "Set the volume to forty percent" ? new[] { sentence, "Set the volume to 40 percent", "Set the volume to 40%" } : new[] { sentence };
            // Punctuation-insensitive comparison must not hide a missing unit.
            var unitsPreserved = sentence != "Set the volume to forty percent"
                || actual.Contains('%') || actual.Contains("percent", StringComparison.OrdinalIgnoreCase);
            var matches = unitsPreserved && alternatives.Any(expected => BanbanVoiceService.Normalize(actual) == BanbanVoiceService.Normalize(expected));
            var unsegmented = matches ? null : asr.Recognize(Frames(path).SelectMany(frame => frame).ToArray()).Text;
            transcripts.Add(new { expected = sentence, actual, exactMatch = matches, milliseconds, audioSeconds,
                realTimeFactor = milliseconds / (audioSeconds * 1000), endpoints, updates, unsegmented });
            Console.WriteLine("ASR " + sentence + " => " + actual);
            Save();
            if (unsegmented is not null) Console.WriteLine("WHOLE " + unsegmented);
            Check(matches, "actual neural decoding: " + sentence);
            if (sentence == "退下吧") Check(BanbanVoiceService.Intent(actual) == "leave"
                && BanbanVoiceService.SpeechControl(actual) == "再见班班", "decoded departure reaches the local control during listening or playback");
            Check(finals.Length == 1, "one complete utterance is finalized exactly once: " + sentence);
            Check(milliseconds < audioSeconds * 1000, "recognition keeps up with real time on this machine: " + sentence);
        }
        var unfinished = Synthesize("unfinished", "打开数学课件");
        segmenter.Reset();
        var endpointFrames = Frames(unfinished).ToList();
        var lastSoundFrame = endpointFrames.FindLastIndex(frame => frame.Any(sample => Math.Abs(sample) > .005f));
        var finalFrame = -1;
        for (var i = 0; i < endpointFrames.Count; i++)
            if (segmenter.Accept(endpointFrames[i]) is { Final: true }) { finalFrame = i; break; }
        var endpointDelayMs = (finalFrame - lastSoundFrame) * 50;
        transcripts.Add(new { test = "endpoint latency", endpointDelayMs });
        Check(finalFrame > lastSoundFrame && endpointDelayMs <= 1450,
            $"finished speech is finalized within 1.45 seconds while preserving code switches ({endpointDelayMs} ms)");

        // A normal pause before an English app name must remain one command.
        segmenter.Reset();
        var paused = new List<BanbanSpeechAudio>();
        var chinese = Frames(Synthesize("pause-prefix", "帮我打开")).ToList();
        var english = Frames(SynthesizeSegments("pause-suffix", ("PowerPoint", "en"))).ToList();
        static IEnumerable<float[]> Voiced(List<float[]> frames)
        {
            var first = frames.FindIndex(frame => frame.Any(sample => Math.Abs(sample) > .005f));
            var last = frames.FindLastIndex(frame => frame.Any(sample => Math.Abs(sample) > .005f));
            return frames.Skip(first).Take(last - first + 1);
        }
        foreach (var frame in Voiced(chinese).Concat(Enumerable.Range(0, 10).Select(_ => new float[800]))
                     .Concat(Voiced(english)).Concat(Enumerable.Range(0, 50).Select(_ => new float[800])))
            if (segmenter.Accept(frame) is { } audio) paused.Add(audio);
        Check(paused.Count == 1 && paused[0].Final
            && BanbanVoiceService.Normalize(asr.Recognize(paused[0].Samples).Text) == "帮我打开powerpoint",
            "a 500 ms pause before the English app name stays one complete instruction");
        segmenter.Reset();
        foreach (var samples in Frames(unfinished))
        {
            segmenter.Accept(samples);
            if (segmenter.SpeechDetected) break;
        }
        segmenter.Reset();
        Check(Enumerable.Range(0, 80).All(_ => segmenter.Accept(new float[800]) is null),
            "cancelling before the end drops the unfinished audio instead of finalizing it");

        var bargeAudio = new List<BanbanSpeechAudio>();
        foreach (var frame in Frames(Synthesize("barge-preview", "帮我打开数学课件，然后查看今天的课表")))
            if (segmenter.Accept(frame, preview:true) is { } audio) bargeAudio.Add(audio);
        Check(bargeAudio.Count(a => !a.Final) == 1 && bargeAudio.Count(a => a.Final) == 1
            && bargeAudio.Last().Samples.Length > bargeAudio.First().Samples.Length
            && bargeAudio.All(a => a.DuringPlayback),
            "playback has one bounded preview and preserves the beginning for the final utterance");
        var preview = asr.Recognize(bargeAudio.First().Samples);
        Check(BanbanLocalAudio.CanBargeIn(preview.Text, "您可以问我其他问题"), "a real SenseVoice preview can identify an ordinary new arrangement: " + preview.Text);

        segmenter.Reset();
        var boundaryResults = new List<BanbanSpeechAudio>(); var playbackEnded = false;
        foreach (var frame in Frames(unfinished))
        {
            var audio = segmenter.Accept(frame, preview: !playbackEnded);
            if (segmenter.SpeechDetected) playbackEnded = true;
            if (audio is not null) boundaryResults.Add(audio);
        }
        Check(boundaryResults.Count == 1 && boundaryResults[0] is { Final: true, DuringPlayback: true }
            && BanbanVoiceService.Normalize(asr.Recognize(boundaryResults[0].Samples).Text) == "打开数学课件",
            "speech starting just before playback ends keeps its opening words and playback provenance");

        segmenter.Reset(); boundaryResults.Clear();
        var firstCapture = true; var boundaryFrame = 0; var soundStart = -1; var speechStart = -1;
        foreach (var frame in Frames(unfinished))
        {
            if (segmenter.Accept(frame, duringPlayback: firstCapture) is { } audio) boundaryResults.Add(audio);
            if (segmenter.SpeechDetected && speechStart < 0) speechStart = boundaryFrame;
            if (frame.Any(sample => Math.Abs(sample) > .015f)) { firstCapture = false; if (soundStart < 0) soundStart = boundaryFrame; }
            boundaryFrame++;
        }
        // Preserve provenance even when queued capture frames are processed
        // after playback ends, before VAD has accumulated enough speech.
        Check(boundaryResults.Count == 1 && boundaryResults[0].DuringPlayback,
            $"pre-roll retains capture provenance before VAD declares an utterance active (sound frame {soundStart}, VAD frame {speechStart})");

        using (var entered = new ManualResetEventSlim())
        using (var release = new ManualResetEventSlim())
        using (var completed = new ManualResetEventSlim())
        {
            var generation = 1; var calls = 0; var delivered = new ConcurrentQueue<int>(); var errors = new ConcurrentQueue<Exception>();
            var retainedProvenance = false;
            using var decoder = new BanbanSpeechDecoder(samples => {
                if (Interlocked.Increment(ref calls) == 1) { entered.Set(); release.Wait(TimeSpan.FromSeconds(5)); }
                return new("任务 " + samples[0], true);
            }, value => value == Volatile.Read(ref generation), (job, result, _) => {
                retainedProvenance = result.DuringPlayback; delivered.Enqueue(job.Generation); completed.Set();
            }, errors.Enqueue, () => { });
            decoder.Start(); decoder.Enqueue(new([1], true), 1, false);
            Check(entered.Wait(TimeSpan.FromSeconds(3)), "neural inference runs off the caller thread");
            Check(decoder.Enqueue(new([2], true), 1, false), "a following utterance queues while inference is busy");
            Interlocked.Exchange(ref generation, 2);
            Check(decoder.Enqueue(new([3], true, DuringPlayback: true), 2, false), "a fresh listening generation can queue after cancellation");
            release.Set();
            Check(completed.Wait(TimeSpan.FromSeconds(3)) && delivered.SequenceEqual(new[] { 2 }) && calls == 2 && errors.IsEmpty,
                "cancelled in-flight and queued results are discarded; only the fresh task is delivered");
            Check(retainedProvenance, "delayed recognition retains playback provenance even after the listening window changes");
        }
        Check(asr.Recognize(new float[BanbanSpeechSegmenter.MaximumSamples + 1]).Unrecognized,
            "an overlong arrangement cannot become a truncated executable instruction");

        using var detector = new BanbanWakeDetector();
        Check(detector.Accept(new float[16000]) is null, "keyword spotting does not wake on silence");
        string? detected = null;
        foreach (var samples in Frames(Synthesize("synthetic-wake", "你好班班")))
        {
            var keyword = detector.Accept(samples); detected ??= keyword;
        }
        Check(detected == "你好班班", "bundled keyword model detects synthesized wake independently of Windows dictation");
        foreach (var command in new[] { "班班停一下", "班班取消操作", "再见班班" })
        {
            var keywords = new List<string>();
            foreach (var samples in Frames(Synthesize("keyword-" + command, command)))
            {
                var keyword = detector.Accept(samples); if (keyword is not null) keywords.Add(keyword);
            }
            Check(keywords.Contains(command), "independent keyword interruption/control: " + command + " (" + string.Join(",", keywords) + ")");
        }
        Save();
        if (failures.Count > 0) throw new InvalidOperationException(string.Join("\n", failures));
    }
}

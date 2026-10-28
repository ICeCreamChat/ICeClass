using System.Collections.Concurrent;
using System.Reflection;
using System.Speech.Synthesis;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class SpeakerFocusChecks
{
    internal static void Run(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        var errors = new List<string>();
        void Check(bool passed, string name)
        {
            checks.Add(new { name, passed });
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) errors.Add(name);
        }
        float[] WindowsVoice(string text)
        {
            using var memory = new MemoryStream();
            using (var voice = new SpeechSynthesizer())
            {
                voice.SelectVoice(voice.GetInstalledVoices().First(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "zh").VoiceInfo.Name);
                voice.SetOutputToWaveStream(memory); voice.Speak(text); voice.SetOutputToNull();
            }
            memory.Position = 0;
            using var wave = new WaveFileReader(memory);
            return Read(new WdlResamplingSampleProvider(wave.ToSampleProvider(), 16000));
        }
        using var natural = new BanbanNeuralSynthesizer();
        float[] OtherVoice(string text)
        {
            var samples = natural.Generate(text);
            var bytes = new byte[samples.Length * sizeof(float)]; Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
            using var wave = new RawSourceWaveStream(new MemoryStream(bytes), WaveFormat.CreateIeeeFloatWaveFormat(natural.SampleRate, 1));
            return Read(new WdlResamplingSampleProvider(wave.ToSampleProvider(), 16000));
        }
        var wake = WindowsVoice("你好班班");
        var ownerCommand = WindowsVoice("打开数学课件");
        var otherGreeting = OtherVoice("嗨小雨");
        var otherQuestion = OtherVoice("你在吃什么");
        var observations = new ConcurrentQueue<BanbanAudioObservation>();
        using (var filteredInput = new OfflineMicrophone(observations.Enqueue))
        {
            filteredInput.EchoAvailable(true);
            filteredInput.Feed(wake, waitForResult: false);
            Check(SpinWait.SpinUntil(() => filteredInput.Wakes > 0, 1500),
                "the echo-cancelled microphone can wake the assistant while it is not speaking");
        }
        using var input = new OfflineMicrophone(observations.Enqueue);
        input.Feed(wake, waitForResult: false);
        Check(SpinWait.SpinUntil(() => input.Wakes > 0, 4000), "a spoken wake starts a conversation without opening a microphone");
        input.Feed(ownerCommand);
        Check(input.Delivered.Any(r => r.Final && BanbanVoiceService.Normalize(r.Text) == "打开数学课件"), "the waking speaker can issue a complete task");
        var before = input.Delivered.Count;
        input.Feed(otherGreeting);
        Check(input.Delivered.Count == before, "another speaker saying hi to someone else never enters the assistant conversation");
        input.Feed(otherQuestion);
        Check(input.Delivered.Count == before, "another speaker's ordinary question never becomes a task");
        input.Feed(WindowsVoice("需要你打开它"));
        Check(input.Delivered.Count > before, "the original speaker can continue without repeating the wake phrase");
        before = input.Delivered.Count;
        input.Feed(WindowsVoice("需要"));
        Check(input.Delivered.Count > before, "a short follow-up from the original speaker remains usable");
        float[] LongSpeech(float[] sentence) => Enumerable.Range(0, 32 * 16000 / sentence.Length + 2).SelectMany(_ => sentence).ToArray();
        before = input.Delivered.Count;
        input.Feed(LongSpeech(otherQuestion));
        Check(input.Delivered.Count == before, "an overlong bystander utterance cannot trigger an ask-to-repeat response through a separate path");
        input.Feed(LongSpeech(ownerCommand));
        Check(input.Delivered.Skip(before).Any(r => r.Unrecognized && r.Text.Length == 0),
            "an overlong task from the current speaker is rejected without executing a truncated instruction");

        input.Playback(true);
        var barges = input.Barges.Count;
        input.Feed(otherQuestion);
        Check(input.Barges.Count == barges && input.Delivered.All(r => BanbanVoiceService.Normalize(r.Text) != "你在吃什么"), "a bystander cannot interrupt playback with an ordinary question");
        var controls = input.Controls.Count;
        input.Feed(OtherVoice("班班停一下"));
        Check(input.Controls.Count == controls && input.Barges.Count == barges,
            "the keyword shortcut does not bypass the focused speaker during playback");
        input.Feed(WindowsVoice("班班停一下"));
        Check(SpinWait.SpinUntil(() => input.Controls.Count > controls || input.Delivered.Any(r => BanbanVoiceService.SpeechControl(r.Text) is not null), 4000),
            "the current speaker can still stop playback");
        controls = input.Controls.Count;
        input.Feed(WindowsVoice("班班取消操作"));
        Check(input.Controls.Count > controls || input.Delivered.Any(r => BanbanVoiceService.SpeechControl(r.Text) == "班班取消操作"),
            "the current speaker can still cancel a task during playback");
        barges = input.Barges.Count;
        input.Feed(ownerCommand);
        Check(input.Barges.Count > barges && input.Barges.Any(r => r.Final && BanbanVoiceService.Normalize(r.Text) == "打开数学课件"),
            "an ordinary new task from the current speaker can still interrupt without another wake phrase");
        input.Playback(false);
        input.Standby();
        before = input.Delivered.Count;
        input.Feed(ownerCommand, waitForResult: false);
        Check(input.Delivered.Count == before, "standby does not accept tasks from the former speaker");
        var wakes = input.Wakes;
        input.Feed(OtherVoice("你好班班"), waitForResult: false);
        Check(SpinWait.SpinUntil(() => input.Wakes > wakes, 4000), "another teacher can explicitly wake the assistant for a new conversation");
        before = input.Delivered.Count;
        input.Feed(OtherVoice("打开数学课件"));
        Check(input.Delivered.Count > before, "the new waking speaker can issue a task");
        before = input.Delivered.Count;
        input.Feed(ownerCommand);
        Check(input.Delivered.Count == before, "a new wake replaces the former conversation's speaker instead of accumulating identities");
        Check(input.Failures.IsEmpty, "the complete input path finishes without capture or inference errors");
        File.WriteAllText(Path.Combine(output, "speaker-focus-checks.json"), JsonSerializer.Serialize(new {
            source = "two synthetic voices fed directly into the real keyword/VAD/recognition path; no microphone capture or playback",
            checks, observations
        }, new JsonSerializerOptions { WriteIndented = true }));
        if (errors.Count > 0) throw new InvalidOperationException(string.Join("\n", errors));
    }

    internal static void RunCorpus(string corpus, string output)
    {
        Directory.CreateDirectory(output);
        float[] Audio(string name)
        {
            using var reader = new AudioFileReader(Path.Combine(corpus, name));
            return Read(new WdlResamplingSampleProvider(reader, 16000));
        }
        using var focus = new BanbanSpeakerFocus();
        var enrolled = focus.Focus(Audio("enroll-fangjun-sr-1.wav").Take(32000).ToArray());
        var rows = new List<object>(); var passed = enrolled;
        foreach (var (name, expected) in new[] {
            ("test-fangjun-test-sr-1.wav", true),
            ("test-leijun-test-sr-1.wav", false),
            ("test-liudehua-test-sr-1.wav", false)
        })
        {
            var samples = Audio(name); var watch = System.Diagnostics.Stopwatch.StartNew();
            var matched = focus.Matches(samples); watch.Stop();
            passed &= matched == expected;
            rows.Add(new { name, matched, expected, milliseconds = watch.Elapsed.TotalMilliseconds });
            Console.WriteLine($"{(matched == expected ? "PASS" : "FAIL")} public spoken fixture {name}: {matched}; {watch.ElapsedMilliseconds} ms");
        }
        focus.Clear();
        var cleared = !focus.Matches(Audio("test-fangjun-test-sr-1.wav"));
        File.WriteAllText(Path.Combine(output, "public-speaker-checks.json"), JsonSerializer.Serialize(new {
            source = "public sherpa-onnx sr-data fixtures; not this user's microphone or an acoustic classroom test",
            enrolled, cleared, rows
        }, new JsonSerializerOptions { WriteIndented = true }));
        if (!passed || !cleared) throw new InvalidOperationException("Public speaker fixtures did not meet the expected conversation isolation.");
    }

    private static float[] Read(ISampleProvider provider)
    {
        var result = new List<float>(); var buffer = new float[16000]; int count;
        while ((count = provider.Read(buffer, 0, buffer.Length)) > 0) result.AddRange(buffer.AsSpan(0, count).ToArray());
        return result.ToArray();
    }

    // Drive the existing capture callbacks without starting WaveIn or the AEC
    // device. Reflection belongs here, rather than test controls in production.
    private sealed class OfflineMicrophone : IDisposable
    {
        private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
        private readonly BanbanLocalAudio _audio;
        private readonly BanbanEchoMicrophone _echo;
        private readonly MethodInfo _capture;
        private readonly object _frames;
        private readonly PropertyInfo _count;
        private readonly ManualResetEventSlim _finished = new();
        private readonly Action<byte[], int> _echoReceive;
        private int _wakes;
        private bool _echoEnabled;
        private bool _finalRecognition;
        internal int Wakes => Volatile.Read(ref _wakes);
        internal ConcurrentQueue<BanbanSpeechResult> Delivered { get; } = new();
        internal ConcurrentQueue<BanbanSpeechResult> Barges { get; } = new();
        internal ConcurrentQueue<string> Controls { get; } = new();
        internal ConcurrentQueue<Exception> Failures { get; } = new();

        internal OfflineMicrophone(Action<BanbanAudioObservation> observe)
        {
            BanbanLocalAudio? audio = null;
            audio = new BanbanLocalAudio(keyword => {
                if (BanbanVoiceService.WakeRemainder(keyword) is not null)
                { audio!.SetConversation(true, DateTime.MinValue); Interlocked.Increment(ref _wakes); }
                else Controls.Enqueue(keyword);
            }, (result, _) => { Delivered.Enqueue(result); if (_finalRecognition) _finished.Set(); }, _ => { }, Failures.Enqueue,
            observation => {
                observe(observation);
                if (observation.Kind == "recognition") _finalRecognition = observation.Final;
                if (observation.Kind == "speaker-rejected" && observation.Final) _finished.Set();
            },
            (_, result) => { Barges.Enqueue(result); if (result.Final) _finished.Set(); });
            _audio = audio;
            _capture = typeof(BanbanLocalAudio).GetMethods(Private).Single(m => m.Name == "Capture" && m.GetParameters().Length == 2);
            _echo = (BanbanEchoMicrophone)typeof(BanbanLocalAudio).GetField("_echo", Private)!.GetValue(audio)!;
            _echoReceive = (Action<byte[], int>)typeof(BanbanEchoMicrophone).GetField("_receive", Private)!.GetValue(_echo)!;
            _frames = typeof(BanbanLocalAudio).GetField("_frames", Private)!.GetValue(audio)!;
            _count = _frames.GetType().GetProperty("Count")!;
            ((BanbanSpeechDecoder)typeof(BanbanLocalAudio).GetField("_decoder", Private)!.GetValue(audio)!).Start();
            ((Thread)typeof(BanbanLocalAudio).GetField("_worker", Private)!.GetValue(audio)!).Start();
            typeof(BanbanLocalAudio).GetField("_started", Private)!.SetValue(audio, true);
        }
        internal void Playback(bool enabled)
        {
            EchoAvailable(true);
            _audio.SetPlaybackText("正在介绍班班能做什么，请告诉我新的安排");
            _audio.SetConversation(true, DateTime.MinValue, controlsOnly: enabled);
        }
        internal void EchoAvailable(bool enabled)
        {
            _echoEnabled = enabled;
            typeof(BanbanEchoMicrophone).GetField("_ready", Private)!.SetValue(_echo, enabled ? 1 : 0);
        }
        internal void Standby() => _audio.SetConversation(false, DateTime.MinValue);
        internal void Feed(float[] samples, bool waitForResult = true)
        {
            _finished.Reset();
            for (var offset = 0; offset < samples.Length + 32000; offset += 800)
            {
                if (!SpinWait.SpinUntil(() => (int)_count.GetValue(_frames)! < 5, 5000)) throw new TimeoutException("Offline audio queue stalled.");
                var pcm = new byte[1600];
                for (var i = 0; i < 800 && offset + i < samples.Length; i++)
                    BitConverter.TryWriteBytes(pcm.AsSpan(i * 2, 2), (short)Math.Clamp(samples[offset + i] * 32767, short.MinValue, short.MaxValue));
                if (_echoEnabled) _echoReceive(pcm, pcm.Length);
                else _capture.Invoke(_audio, [null, new WaveInEventArgs(pcm, pcm.Length)]);
            }
            if (!SpinWait.SpinUntil(() => (int)_count.GetValue(_frames)! == 0, 5000)) throw new TimeoutException("Offline audio was not consumed.");
            if (waitForResult && !_finished.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException("No utterance decision was produced.");
        }
        public void Dispose() { _audio.Dispose(); _finished.Dispose(); }
    }
}

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Speech.Synthesis;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class BanbanBackgroundReview
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;

    internal static void Run(string bindingPath, string output, bool dialogue = false)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("Background voice review requires a loopback classroom binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(binding, Path.GetFullPath(output), dialogue)))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Check(ReceiverConfig binding, string output, bool dialogue)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var states = new ConcurrentQueue<string>();
        var observations = new ConcurrentQueue<string>();
        BanbanVoiceWindow? assistant = null;
        void Record(bool passed, string name)
        {
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) throw new InvalidOperationException(name);
            checks.Add(name);
        }
        try
        {
            var preference = Path.Combine(output, "pet-preferences.json");
            File.WriteAllText(preference, "{\"Visible\":false}");
            assistant = new BanbanVoiceWindow(binding, () => { }, enabled: true, petPreferencePath: preference);
            var voice = Field<BanbanVoiceService>(assistant, "_voice");
            voice.Changed += e => { if (e.Kind == "state") states.Enqueue(e.State + ":" + e.Text); };
            voice.AudioObservation += e => { if (e.Kind != "frames") observations.Enqueue(e.Kind); };
            await assistant.StartAsync(background: true);
            var clock = Stopwatch.StartNew();
            while (clock.Elapsed.TotalSeconds < 35 && (!Field<bool>(assistant, "_authorized")
                || voice.Microphone.Length == 0 || !voice.Status.Contains("等候")))
                await Task.Delay(150);
            var browser = Field<ReadingBrowser>(assistant, "_browser");
            using var devices = new MMDeviceEnumerator();
            using var input = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
            var page = browser.Core is null ? "no browser" : await browser.Core.ExecuteScriptAsync(
                "JSON.stringify({ready:document.readyState,native:window.ICeClassVoiceHost?.version===1,chat:!!document.getElementById('bbInput'),user:!!window.ICeClass?.state?.user,status:document.querySelector('.bb-privacy')?.textContent})");
            File.WriteAllText(Path.Combine(output, "startup.json"), JsonSerializer.Serialize(new {
                pageReady = Field<bool>(assistant, "_pageReady"), authorized = Field<bool>(assistant, "_authorized"),
                voice.Status, microphoneStarted = voice.Microphone.Length > 0, states = states.ToArray(),
                voice.Microphone, microphoneMuted = input.AudioEndpointVolume.Mute,
                microphoneVolume = input.AudioEndpointVolume.MasterVolumeLevelScalar,
                observations = observations.ToArray(), page
            }, new JsonSerializerOptions { WriteIndented = true }));
            Record(!assistant.IsVisible && !assistant.CompanionVisible && !assistant.ShowActivated,
                "background startup does not show or focus either window");
            Record(Field<bool>(assistant, "_pageReady") && Field<bool>(assistant, "_authorized"),
                "a hidden classroom page authorizes its bound account without opening chat");
            Record(voice.Microphone.Length > 0, "the hidden classroom session starts its local wake microphone");
            Record(voice.Status.Contains("等候"), "background voice reaches wake standby");

            if (dialogue)
            {
                await Dialogue(assistant, voice, browser, output, Record);
                return;
            }

            var audio = Field<BanbanLocalAudio>(voice, "_audio");
            Field<BanbanEchoMicrophone>(audio, "_echo").Dispose();
            Field<WaveInEvent>(audio, "_capture").StopRecording();
            clock.Restart();
            // The old audio worker has a bounded three-second disposal join.
            while (clock.Elapsed.TotalSeconds < 10 && !states.Any(s => s.StartsWith("error:"))) await Task.Delay(100);
            Record(states.Any(s => s.StartsWith("error:")),
                "a recording stop without a driver exception is detected instead of leaving wake silently inactive");
            clock.Restart();
            while (clock.Elapsed.TotalSeconds < 15 && !voice.Status.Contains("等候")) await Task.Delay(100);
            Record(voice.Status.Contains("等候") && !ReferenceEquals(audio, Field<BanbanLocalAudio>(voice, "_audio")),
                "a stopped microphone returns to wake standby automatically without opening chat");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            assistant?.Shutdown();
            File.WriteAllText(Path.Combine(output, "states.json"), JsonSerializer.Serialize(states.ToArray()));
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(new {
                passed = Environment.ExitCode == 0, checks
            }, new JsonSerializerOptions { WriteIndented = true }));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private static async Task Dialogue(BanbanVoiceWindow assistant, BanbanVoiceService voice, ReadingBrowser browser,
        string output, Action<bool, string> record)
    {
        // Replace only this fixture's hardware source with PCM. Keep the actual
        // keyword, speaker, VAD, ASR, service callbacks and hidden web bridge.
        var audio = Field<BanbanLocalAudio>(voice, "_audio");
        var capture = Field<WaveInEvent>(audio, "_capture");
        var stopped = Field<EventHandler<StoppedEventArgs>>(capture, "RecordingStopped");
        capture.RecordingStopped -= stopped;
        capture.StopRecording();
        var echo = Field<BanbanEchoMicrophone>(audio, "_echo");
        echo.Dispose();
        typeof(BanbanEchoMicrophone).GetField("_ready", Private)!.SetValue(echo, 1);
        var receive = Field<Action<byte[], int>>(echo, "_receive");
        var frames = Field<object>(audio, "_frames");
        var frameCount = frames.GetType().GetProperty("Count")!;
        var events = new ConcurrentQueue<BanbanVoiceEvent>();
        var decisions = new ConcurrentQueue<BanbanAudioObservation>();
        var mascot = Field<BanbanPetMascot>(Field<BanbanPetWindow>(assistant, "_pet"), "_mascot");
        var mouthOpenings = new List<double>();
        var mouthTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(25) };
        mouthTimer.Tick += (_, _) => mouthOpenings.Add(mascot.SpeechOpening?.Invoke() ?? 0);
        mouthTimer.Start();
        // Let the real player finish naturally. Forcing StopSpeaking here would
        // bypass the greeting-to-listening transition reported by the user.
        voice.Changed += events.Enqueue;
        voice.AudioObservation += e => { if (e.Kind != "frames") decisions.Enqueue(e); };
        float[] Speech(string text)
        {
            using var memory = new MemoryStream();
            using (var synth = new SpeechSynthesizer())
            {
                synth.SelectVoice(synth.GetInstalledVoices().First(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "zh").VoiceInfo.Name);
                synth.SetOutputToWaveStream(memory); synth.Speak(text); synth.SetOutputToNull();
            }
            memory.Position = 0;
            using var source = new WaveFileReader(memory);
            var resampler = new WdlResamplingSampleProvider(source.ToSampleProvider(), 16000);
            var samples = new List<float>(); var buffer = new float[4096]; int count;
            while ((count = resampler.Read(buffer, 0, buffer.Length)) > 0) samples.AddRange(buffer.Take(count));
            return samples.ToArray();
        }
        Task Feed(float[] samples) => Task.Run(() => {
            for (var offset = 0; offset < samples.Length + 32000; offset += 800)
            {
                if (!SpinWait.SpinUntil(() => (int)frameCount.GetValue(frames)! < 5, 5000)) throw new TimeoutException("PCM queue stalled.");
                var pcm = new byte[1600];
                for (var i = 0; i < 800 && offset + i < samples.Length; i++)
                    BitConverter.TryWriteBytes(pcm.AsSpan(i * 2, 2), (short)Math.Clamp(samples[offset + i] * 32767, short.MinValue, short.MaxValue));
                receive(pcm, pcm.Length);
            }
            if (!SpinWait.SpinUntil(() => (int)frameCount.GetValue(frames)! == 0, 5000)) throw new TimeoutException("PCM queue did not drain.");
        });
        async Task<bool> Until(Func<Task<bool>> condition, int seconds = 20)
        {
            var timer = Stopwatch.StartNew();
            while (timer.Elapsed.TotalSeconds < seconds) { if (await condition()) return true; await Task.Delay(100); }
            return false;
        }
        try
        {
            await Feed(Speech("你好班班"));
            record(await Until(() => Task.FromResult(events.Any(e => e.Kind == "wake"))),
                "PCM wake reaches the real background voice service");
            record(await Until(() => Task.FromResult(voice.Status == "您说，我在听")),
                "natural completion of the wake response leaves the microphone in conversational listening");
            record(mouthOpenings.Any(value => value > .2),
                "the real synthesized welcome reaches the native pet's speech envelope provider");
            record(mascot.SpeechOpening?.Invoke() == 0,
                "natural welcome completion clears the pet's live mouth opening");
            await Task.Delay(350);
            var initialReplies = await browser.Core!.ExecuteScriptAsync("document.querySelectorAll('.bb-message-assistant').length");
            await Feed(Speech("等差数列的前n项和是什么"));
            record(await Until(() => Task.FromResult(events.Any(e => e.Kind == "transcript"))),
                "the waking speaker's complete mathematics question passes recognition after the wake response");
            var transcript = events.Last(e => e.Kind == "transcript").Text;
            record(BanbanVoiceService.Normalize(transcript).Contains("等差数列"),
                "the delivered mathematics question retains its subject");
            record(await Until(async () => await browser.Core.ExecuteScriptAsync(
                "document.querySelectorAll('.bb-message-assistant').length > " + initialReplies
                + " && /首项|公差|末项/.test([...document.querySelectorAll('.bb-message-assistant')].at(-1)?.textContent || '')") == "true", 50),
                "the hidden page sends the recognized question and receives a real model answer");
            record(await Until(() => Task.FromResult(voice.Status == "您说，我在听"), 40),
                "natural completion of the model answer returns to conversational listening");
            var repliesBeforeFollowup = await browser.Core.ExecuteScriptAsync("document.querySelectorAll('.bb-message-assistant').length");
            var transcriptsBeforeFollowup = events.Count(e => e.Kind == "transcript");
            await Feed(Speech("首项是二，公差是三，前十项和是多少"));
            record(await Until(() => Task.FromResult(events.Count(e => e.Kind == "transcript") > transcriptsBeforeFollowup)),
                "the same waking speaker can ask a follow-up without another wake word");
            record(await Until(async () => await browser.Core.ExecuteScriptAsync(
                "document.querySelectorAll('.bb-message-assistant').length > " + repliesBeforeFollowup
                + " && /155|一百五十五/.test([...document.querySelectorAll('.bb-message-assistant')].at(-1)?.textContent || '')") == "true", 50),
                "the continued background dialogue receives the correct arithmetic-series sum");
            record(await Until(() => Task.FromResult(voice.Status == "您说，我在听"), 40),
                "the follow-up answer also completes playback naturally");
            var repliesBeforeThird = await browser.Core.ExecuteScriptAsync("document.querySelectorAll('.bb-message-assistant').length");
            var transcriptsBeforeThird = events.Count(e => e.Kind == "transcript");
            await Feed(Speech("那前二十项的和是多少"));
            record(await Until(() => Task.FromResult(events.Count(e => e.Kind == "transcript") > transcriptsBeforeThird)),
                "a third question reaches the model without another wake or click");
            record(await Until(async () => await browser.Core.ExecuteScriptAsync(
                "document.querySelectorAll('.bb-message-assistant').length > " + repliesBeforeThird
                + " && /610|六百一十/.test([...document.querySelectorAll('.bb-message-assistant')].at(-1)?.textContent || '')") == "true", 50),
                "the third answer keeps the preceding conversation's first term and common difference");
            record(await Until(() => Task.FromResult(voice.Status == "您说，我在听"), 40),
                "the third answer finishes naturally and keeps conversational listening available");
            voice.Standby();
            record(await Until(() => Task.FromResult(voice.Status.Contains("等候"))),
                "ending the voice conversation returns to wake standby");
            voice.StartConversation();
            record(await Until(() => Task.FromResult(voice.Status == "您说，我在听")),
                "clicking the pet starts a fresh listening session");
            await Task.Delay(350);
            var transcriptsBeforeClick = events.Count(e => e.Kind == "transcript");
            await Feed(Speech("等差数列的前n项和是什么"));
            record(await Until(() => Task.FromResult(events.Count(e => e.Kind == "transcript") > transcriptsBeforeClick)),
                "a conversation started by clicking the pet accepts its first question without a wake phrase");
            record(!assistant.IsVisible && !assistant.CompanionVisible,
                "a complete background dialogue does not open either user window");
        }
        finally
        {
            mouthTimer.Stop();
            File.WriteAllText(Path.Combine(output, "dialogue-events.json"), JsonSerializer.Serialize(events.ToArray(), new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllText(Path.Combine(output, "dialogue-decisions.json"), JsonSerializer.Serialize(decisions.ToArray(), new JsonSerializerOptions { WriteIndented = true }));
        }
    }
}

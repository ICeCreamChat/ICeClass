using System.Collections.Concurrent;
using System.Reflection;
using System.Runtime.CompilerServices;
using ICeClass.Receiver;

internal static class VoiceMemoryChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

    // This opt-in entry keeps the independent voice checks in this file.
    // The normal offline suite and its existing entry point are unchanged.
    [ModuleInitializer]
    internal static void Entry()
    {
        var args = Environment.GetCommandLineArgs();
        if (args is not [_, "--voice-memory-checks" or "--voice-memory-playback-checks"]
            && args is not [_, "--voice-memory-fixture", _]) return;
        try
        {
            if (args.Length == 3) Fixture(args[2]);
            else Run(args[1] == "--voice-memory-playback-checks");
            Environment.Exit(0);
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.Exit(1); }
    }

    internal static void Run(bool playback = false)
    {
        var failures = new List<string>();
        var checks = 0;
        void Check(bool passed, string name)
        {
            checks++;
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) failures.Add(name);
        }

        using (var voice = new BanbanVoiceService())
        using (var entered = new ManualResetEventSlim())
        using (var release = new ManualResetEventSlim())
        {
            var queue = (BlockingCollection<Action>)typeof(BanbanVoiceService).GetField("_queue", Private)!.GetValue(voice)!;
            var timer = (Timer)typeof(BanbanVoiceService).GetField("_timer", Private)!.GetValue(voice)!;
            for (var pass = 0; pass < 2; pass++)
            {
                entered.Reset(); release.Reset();
                typeof(BanbanVoiceService).GetMethod("Post", Private)!.Invoke(voice, [new Action(() => {
                    entered.Set(); release.Wait(TimeSpan.FromSeconds(5));
                })]);
                if (!entered.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("Voice owner thread did not start.");
                try
                {
                    timer.Change(0, 5);
                    SpinWait.SpinUntil(() => queue.Count > 1, TimeSpan.FromMilliseconds(250));
                    Check(queue.Count == 1, pass == 0 ? "slow voice work keeps at most one pending maintenance tick"
                        : "maintenance ticks resume after the previous queued check finishes");
                }
                finally { timer.Change(Timeout.Infinite, Timeout.Infinite); release.Set(); }
                OnVoice(voice, () => { });
            }
        }

        using (var completed = new ManualResetEventSlim())
        {
            var errors = new ConcurrentQueue<Exception>();
            var recognizedSamples = 0;
            var playbackProvenance = false;
            using var decoder = new BanbanSpeechDecoder(samples => {
                recognizedSamples = samples.Length;
                return new("打开数学课件", true);
            }, generation => generation == 1, (_, result, _) => {
                playbackProvenance = result.DuringPlayback; completed.Set();
            }, errors.Enqueue, () => { });
            decoder.Start();
            var samples = EnqueueSamples(decoder, 1, duringPlayback: true);
            if (!completed.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("Utterance did not complete.");
            WaitForIdle(decoder, "_thread", "_jobs");
            Check(recognizedSamples == BanbanSpeechSegmenter.MaximumSamples && playbackProvenance && errors.IsEmpty,
                "a full utterance still decodes and retains its playback provenance");
            Check(Collectible(samples), "completed utterance PCM is collectible while the decoder stays ready and idle");

            completed.Reset();
            var cancelled = EnqueueSamples(decoder, 2);
            WaitForIdle(decoder, "_thread", "_jobs");
            Check(!completed.IsSet && recognizedSamples == BanbanSpeechSegmenter.MaximumSamples && errors.IsEmpty,
                "a stale generation is discarded without delivering or decoding it");
            Check(Collectible(cancelled), "discarded utterance PCM is collectible while the decoder stays ready and idle");
        }

        var busyProperty = typeof(BanbanVoiceService).GetProperty("Busy", Private);
        Check(busyProperty is not null, "download coordination can observe voice activity");
        if (busyProperty is not null)
        {
            using var voice = new BanbanVoiceService();
            // Keep this state-only check independent of microphone recovery.
            ((Timer)typeof(BanbanVoiceService).GetField("_timer", Private)!.GetValue(voice)!).Change(Timeout.Infinite, Timeout.Infinite);
            OnVoice(voice, () => { });
            void Set(string field, object value) => typeof(BanbanVoiceService).GetField(field, Private)!.SetValue(voice, value);
            bool Busy() => (bool)busyProperty.GetValue(voice)!;
            Set("_enabled", true); Set("_ready", true);
            Check(!Busy(), "continuous microphone standby alone does not block idle downloads");
            Set("_active", true);
            Check(Busy(), "an active conversation blocks idle downloads between utterances");
            Set("_active", false); Set("_speaking", true);
            Check(Busy(), "speech playback blocks idle downloads");
            Set("_speaking", false); Set("_workState", "confirming");
            Check(Busy(), "a pending confirmation blocks idle downloads");
            Set("_workState", "thinking");
            Check(Busy(), "an unfinished voice task blocks idle downloads");
            voice.Standby();
            OnVoice(voice, () => { });
            Check(!Busy(), "returning to wake standby releases the idle-download block");
            Set("_workState", "thinking");
            voice.SetEnabled(false);
            OnVoice(voice, () => { });
            Check(!Busy(), "disabling voice clears an abandoned task's busy state");
        }

        using (var completed = new ManualResetEventSlim())
        using (var playbackHeld = new ManualResetEventSlim())
        using (var releasePlayback = new ManualResetEventSlim())
        {
            var errors = new ConcurrentQueue<Exception>();
            using var player = new BanbanSpeechPlayer(_ => completed.Set(), (_, text) => {
                if (text == "hold") { playbackHeld.Set(); releasePlayback.Wait(TimeSpan.FromSeconds(10)); }
            }, errors.Enqueue);
            if (!SpinWait.SpinUntil(() => player.Ready || !errors.IsEmpty, TimeSpan.FromSeconds(30)) || !player.Ready)
                throw new InvalidOperationException("Neural voice did not warm up.", errors.FirstOrDefault());
            var samples = EnqueuePlaybackSamples(player, cancelled: true);
            WaitForIdle(player, "_playback", "_audio");
            Check(Collectible(samples), "cancelled playback PCM is collectible while the neural voice stays warm and idle");
            player.Enqueue("", true);
            Check(completed.Wait(TimeSpan.FromSeconds(3)) && player.Ready && errors.IsEmpty,
                "the same warmed player accepts the next synthesis turn after cancelled playback");
            if (playback)
            {
                completed.Reset();
                var played = EnqueuePlaybackSamples(player, cancelled: false);
                if (!completed.Wait(TimeSpan.FromSeconds(3)))
                    throw new InvalidOperationException("Muted PCM did not finish on the default output.", errors.FirstOrDefault());
                WaitForIdle(player, "_playback", "_audio");
                Check(Collectible(played), "completed playback PCM is collectible while the neural voice stays warm and idle");

                try
                {
                    EnqueuePlaybackSamples(player, cancelled: false, text: "hold");
                    if (!playbackHeld.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("Playback did not reach the controlled pause.");
                    player.Enqueue("这是一段语音生命周期测试。", true, volume: 0);
                    if (!SpinWait.SpinUntil(() => Pending(player, "_audio") > 0 || !errors.IsEmpty, TimeSpan.FromSeconds(5)))
                        throw new TimeoutException("Neural synthesis did not queue PCM.");
                    var generated = QueuedPlaybackSamples(player);
                    var generation = player.Generation;
                    var stopping = Task.Run(player.Stop);
                    if (!SpinWait.SpinUntil(() => player.Generation != generation && Pending(player, "_audio") == 0,
                            TimeSpan.FromSeconds(3))) throw new TimeoutException("Stop did not clear the queued audio.");
                    releasePlayback.Set(); stopping.WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
                    WaitForIdle(player, "_synthesis", "_text"); WaitForIdle(player, "_playback", "_audio");
                    Check(Collectible(generated) && player.Ready && errors.IsEmpty,
                        "cancelled native synthesis PCM is collectible while the same model stays warm");
                }
                finally { releasePlayback.Set(); }
            }
        }

        if (failures.Count > 0) throw new InvalidOperationException(string.Join(Environment.NewLine, failures));
        Console.WriteLine($"{checks} voice memory checks passed.");
    }

    private static void Fixture(string output)
    {
        using var completed = new ManualResetEventSlim();
        var errors = new ConcurrentQueue<Exception>();
        using var decoder = new BanbanSpeechDecoder(_ => new("完整指令", true), _ => true,
            (_, _, _) => completed.Set(), errors.Enqueue, () => { });
        decoder.Start();
        var samples = EnqueueSamples(decoder, 1);
        if (!completed.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("Fixture utterance did not complete.");
        WaitForIdle(decoder, "_thread", "_jobs");
        if (!errors.IsEmpty) throw new InvalidOperationException("Fixture decode failed.", errors.First());
        var collectible = Collectible(samples);
        var retained = RetainedPcmBytes(samples);
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        process.Refresh();
        var report = new {
            source = "production decoder worker with deterministic recognition; no microphone, model unload or working-set trimming",
            comparison = "Run the same fixture before and after the change; retainedPcmBytes is the measured live PCM payload after an idle test GC, not a client RSS claim.",
            assembly = typeof(BanbanSpeechDecoder).Assembly.Location,
            sampleRate = 16000, audioSeconds = 30, submittedPcmBytes = 1920000,
            retainedPcmBytes = retained, collectible,
            managedHeapBytes = GC.GetGCMemoryInfo().HeapSizeBytes,
            privateBytes = process.PrivateMemorySize64, workingSetBytes = process.WorkingSet64
        };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        var json = System.Text.Json.JsonSerializer.Serialize(report, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(output, json); Console.WriteLine(json);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static long RetainedPcmBytes(WeakReference samples) => samples.Target is float[] pcm ? pcm.LongLength * sizeof(float) : 0;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference EnqueueSamples(BanbanSpeechDecoder decoder, int generation, bool duringPlayback = false)
    {
        var samples = new float[BanbanSpeechSegmenter.MaximumSamples];
        samples[0] = .25f;
        var weak = new WeakReference(samples);
        if (!decoder.Enqueue(new(samples, true, DuringPlayback: duringPlayback), generation, false))
            throw new InvalidOperationException("Utterance was not queued.");
        return weak;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference EnqueuePlaybackSamples(BanbanSpeechPlayer player, bool cancelled, string text = "memory check")
    {
        // Cancelled parts must be dropped without opening an audio device.
        // Optional completed-playback checks use 100 ms of muted PCM.
        var samples = new float[cancelled ? 30 * 22050 : 2205];
        var weak = new WeakReference(samples);
        var partType = typeof(BanbanSpeechPlayer).GetNestedType("AudioPart", BindingFlags.NonPublic)!;
        var part = Activator.CreateInstance(partType, [player.Generation - (cancelled ? 1 : 0), samples, 22050, text, true, 0f, NotificationCue.None]);
        var queue = typeof(BanbanSpeechPlayer).GetField("_audio", Private)!.GetValue(player)!;
        if (!(bool)queue.GetType().GetMethod("TryAdd", [partType])!.Invoke(queue, [part])!)
            throw new InvalidOperationException("Cancelled playback part was not queued.");
        return weak;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference QueuedPlaybackSamples(BanbanSpeechPlayer player)
    {
        // ConcurrentQueue snapshots preserve dequeued slots. Temporarily take
        // and restore the sole queued part so the measurement adds no roots.
        var queue = typeof(BanbanSpeechPlayer).GetField("_audio", Private)!.GetValue(player)!;
        var partType = typeof(BanbanSpeechPlayer).GetNestedType("AudioPart", BindingFlags.NonPublic)!;
        object?[] arguments = [null];
        if (!(bool)queue.GetType().GetMethod("TryTake", [partType.MakeByRefType()])!.Invoke(queue, arguments)!)
            throw new InvalidOperationException("Synthesized PCM was not queued.");
        var part = arguments[0]!;
        var weak = new WeakReference(partType.GetProperty("Samples")!.GetValue(part)!);
        if (!(bool)queue.GetType().GetMethod("TryAdd", [partType])!.Invoke(queue, [part])!)
            throw new InvalidOperationException("Synthesized PCM could not be restored.");
        return weak;
    }

    private static int Pending(object instance, string queueField)
    {
        var queue = instance.GetType().GetField(queueField, Private)!.GetValue(instance)!;
        return (int)queue.GetType().GetProperty("Count")!.GetValue(queue)!;
    }

    private static void WaitForIdle(object instance, string field, string queueField)
    {
        var thread = (Thread)instance.GetType().GetField(field, Private)!.GetValue(instance)!;
        var queue = instance.GetType().GetField(queueField, Private)!.GetValue(instance)!;
        var count = queue.GetType().GetProperty("Count")!;
        if (!SpinWait.SpinUntil(() => (int)count.GetValue(queue)! == 0
                && (thread.ThreadState & ThreadState.WaitSleepJoin) != 0,
                TimeSpan.FromSeconds(3))) throw new TimeoutException("Voice worker did not become idle.");
    }

    private static bool Collectible(WeakReference value)
    {
        // GC is confined to the lifetime regression test, never the client.
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        return !value.IsAlive;
    }

    private static void OnVoice(BanbanVoiceService voice, Action action)
    {
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        typeof(BanbanVoiceService).GetMethod("Post", Private)!.Invoke(voice, [new Action(() => {
            try { action(); completed.SetResult(); }
            catch (Exception error) { completed.SetException(error); }
        })]);
        completed.Task.WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
    }
}

using System.Diagnostics;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using ICeClass.Receiver;
using NAudio.Wave;

internal static class NotificationVoiceChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(output)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static BanbanSpeechPlayer? Player(SpeechService speech)
        => typeof(SpeechService).GetField("_player", Private)?.GetValue(speech) as BanbanSpeechPlayer;

    private static bool Playing(BanbanSpeechPlayer player)
    {
        var gate = typeof(BanbanSpeechPlayer).GetField("_gate", Private)!.GetValue(player)!;
        lock (gate)
            return (typeof(BanbanSpeechPlayer).GetField("_output", Private)!.GetValue(player) as WasapiOut)?.PlaybackState == PlaybackState.Playing;
    }

    private static async Task<bool> Wait(Func<bool> predicate, int seconds = 30)
    {
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed.TotalSeconds < seconds)
        {
            if (predicate()) return true;
            await Task.Delay(25);
        }
        return predicate();
    }

    private static async Task Check(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        void Assert(bool passed, string name)
        {
            checks.Add(new { name, passed });
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) throw new InvalidOperationException(name);
        }
        using var speech = new SpeechService();
        using var island = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        var receiver = new CloudReceiverService(speech) { NotificationPresenter = island };
        try
        {
            Assert(typeof(SpeechService).Assembly.GetType("ICeClass.Receiver.NotificationChime") is not null,
                "notification playback has a short cue before important and urgent speech");
            NotificationChimeChecks.Run(Assert);
            await receiver.ShowTestAsync("info");
            Assert(Player(speech) is null, "ordinary notification stays silent without loading a neural voice");
            island.Clear();

            await receiver.ShowTestAsync("warning");
            var player = Player(speech);
            Assert(player is not null, "important text notification uses Banban's bundled neural speech player");
            Assert(await Wait(() => player!.Ready && Playing(player)), "important notification begins real playback on the Windows default output");

            var beforeUrgent = player!.Generation;
            await receiver.ShowTestAsync("urgent");
            Assert(ReferenceEquals(player, Player(speech)) && player.Generation > beforeUrgent,
                "urgent notification cancels the previous neural speech without creating another player");
            Assert(await Wait(() => Playing(player)), "urgent notification begins real neural playback");

            var window = (ClassroomIslandWindow)typeof(ClassroomIslandService).GetField("_window", Private)!.GetValue(island)!;
            var dismiss = (Button)typeof(ClassroomIslandWindow).GetField("_dismissShout", Private)!.GetValue(window)!;
            dismiss.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            island.Clear();
            Assert(await Wait(() => !Playing(player), 3), "dismissing the notice stops its speech and interrupted audio stays stopped");
            await Task.Delay(1100);
            Assert(!Playing(player), "closing during the cue prevents delayed notification speech");

            speech.SpeakLatest("这是新的通知播报。", 0, .3);
            Assert(await Wait(() => Playing(player)), "a new notification can speak after an interruption");
            speech.Stop();
            Assert(await Wait(() => !Playing(player), 3), "explicit stop cancels neural playback");

            using var muted = new SpeechService();
            muted.SpeakLatest("静音通知不应合成或播放。", 0, 0);
            Assert(Player(muted) is null, "zero-volume notification does not load a second voice model");
            muted.SpeakLatest("", 0, 1);
            Assert(Player(muted) is null, "empty notification does not load a voice model");
            muted.SpeakLatest("静音通知不能播放提示音。", 0, 0, NotificationCue.Important);
            Assert(Player(muted) is null, "zero-volume important notification plays neither cue nor speech");

            speech.SpeakLatest("这条通知播报检查完成。", 2, .3, NotificationCue.Important);
            Assert(await Wait(() => Playing(player)) && await Wait(() => !Playing(player)),
                "important cue and neural speech complete as one playback");
            Assert((int)typeof(SpeechService).GetField("_failed", Private)!.GetValue(speech)! == 0,
                "notification cue and speech finish without output errors");

            var recordedPath = Path.Combine(output, "recorded-notification.wav");
            using (var writer = new WaveFileWriter(recordedPath, new WaveFormat(16000, 16, 1)))
            {
                var samples = Enumerable.Range(0, 16000).Select(index => (float)(.07 * Math.Sin(index * Math.PI * 440 / 16000))).ToArray();
                writer.WriteSamples(samples, 0, samples.Length);
            }
            using (var recording = new AudioPlaybackService())
            using (var cancellation = new CancellationTokenSource())
            {
                bool RecordingPlaying() => (typeof(AudioPlaybackService).GetField("_output", Private)!.GetValue(recording) as IWavePlayer)?.PlaybackState == PlaybackState.Playing;
                var playback = (Task)typeof(AudioPlaybackService).GetMethod("PlayFileAsync", Private)!
                    .Invoke(recording, [recordedPath, cancellation.Token, NotificationCue.Important])!;
                Assert(await Wait(RecordingPlaying), "teacher recording and cue use the real local audio output");
                cancellation.Cancel();
                var cancelled = false;
                try { await playback; } catch (OperationCanceledException) { cancelled = true; }
                Assert(cancelled && !RecordingPlaying(), "cancelling a recording during its cue stops its original audio too");
            }

            var shared = BanbanNeuralSynthesizer.AcquireShared();
            var second = BanbanNeuralSynthesizer.AcquireShared();
            try
            {
                Assert(ReferenceEquals(shared, second), "notification and conversation clients reuse one loaded voice model");
                const string phrase = "请同学们准备好课本和练习册。";
                var slower = shared.Generate(phrase, speed: .85f);
                var faster = shared.Generate(phrase, speed: 1.35f);
                Assert(slower.Length > faster.Length * 1.25, "notification speech speed changes generated duration without replacing the voice");
                Assert(shared.Generate(phrase, () => false).Length == 0, "cancelled inference cannot produce notification audio");
            }
            finally
            {
                BanbanNeuralSynthesizer.ReleaseShared(second);
                BanbanNeuralSynthesizer.ReleaseShared(shared);
            }

            var completed = new ConcurrentQueue<long>();
            var errors = new ConcurrentQueue<Exception>();
            using var conversation = new BanbanSpeechPlayer(completed.Enqueue, (_, _) => { }, errors.Enqueue);
            Assert(await Wait(() => conversation.Ready || !errors.IsEmpty) && conversation.Ready,
                "conversation playback attaches to the already loaded notification voice");
            speech.Dispose();
            conversation.Enqueue("通知和班班使用同一个声音。", true);
            Assert(await Wait(() => completed.Contains(conversation.Generation) || !errors.IsEmpty)
                && completed.Contains(conversation.Generation) && errors.IsEmpty,
                "disposing notification speech leaves the shared conversation voice usable");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            await receiver.StopAsync();
            island.Dispose();
            speech.Dispose();
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new
            {
                source = "real local notification presenter, bundled neural synthesis and default Windows output; no microphone recording",
                checks
            }, new JsonSerializerOptions { WriteIndented = true }));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

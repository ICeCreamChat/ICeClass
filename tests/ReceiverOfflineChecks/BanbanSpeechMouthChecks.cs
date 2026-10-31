using System.Text.Json;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class BanbanSpeechMouthChecks
{
    internal static void Run(string output, bool playback = false)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var traces = new List<object>();
        var passed = false;
        void Check(bool passed, string name)
        {
            if (!passed) throw new InvalidOperationException(name);
            checks.Add(name); Console.WriteLine("PASS " + name);
        }
        try
        {
            var motion = new BanbanPetMotion();
            motion.SetState("speaking");
            var openings = Enumerable.Range(0, 30).Select(_ => motion.Advance(1d / 60).MouthOpen).ToArray();
            Check(openings.All(value => value == 0), "waiting for synthesized audio keeps the mouth closed");
            var samples = Pulse(16000);
            var envelope = new BanbanSpeechEnvelope(samples, 16000);
            Check(envelope.OpeningAt(.1) == 0 && envelope.OpeningAt(.6) == 0 && envelope.OpeningAt(1.15) == 0,
                "leading, middle and trailing digital silence keep the mouth closed");
            Check(envelope.OpeningAt(.3) > .8 && envelope.OpeningAt(.9) > .8,
                "two voiced passages open the mouth at their actual sample positions");
            Check(envelope.OpeningAt(-.01) == 0 && envelope.OpeningAt(1.25) == 0
                && envelope.OpeningAt(double.NaN) == 0 && envelope.OpeningAt(double.PositiveInfinity) == 0,
                "positions outside the phrase produce no stale mouth movement");
            Check(new BanbanSpeechEnvelope([], 16000).OpeningAt(0) == 0,
                "an empty speech part cannot move the mouth");
            Check(new BanbanSpeechEnvelope(samples, 16000, 0).OpeningAt(.3) == 0,
                "muted synthesized speech keeps the mouth closed");
            Check(new BanbanSpeechEnvelope(Enumerable.Repeat(.002f, 1600).ToArray(), 16000).OpeningAt(.03) == 0,
                "quiet noise is not normalized into a talking mouth");
            Check(Math.Abs(new BanbanSpeechEnvelope(Pulse(48000), 48000).OpeningAt(.3) - envelope.OpeningAt(.3)) < .001,
                "the same audio timeline survives mono source and device sample rate differences");
            motion.SetSpeechOpening(envelope.OpeningAt(.3));
            Check(motion.Advance(1d / 30).MouthOpen > .8, "a spoken syllable opens the mouth within one rendered frame");
            motion.SetSpeechOpening(envelope.OpeningAt(.6));
            Check(motion.Advance(1d / 30).MouthOpen == 0, "a pause closes the mouth without the body spring delay");
            motion.SetSpeechOpening(.7); motion.Play("stop");
            Check(motion.Advance(1d / 30).MouthOpen == .7,
                "a hand gesture cannot replace the playing speech envelope");
            motion.SetState("listening");
            Check(motion.Pose.MouthOpen == 0 && motion.Advance(.03).MouthOpen == 0,
                "interrupting speech closes the mouth immediately");
            motion.SetState("speaking");
            Check(motion.Advance(.03).MouthOpen == 0, "a new speaking state cannot reuse an old phrase opening");
            motion.SetSpeechOpening(.8);
            Check(motion.Advance(.03, reduced: true).MouthOpen == 0,
                "reduced motion retains the existing static mouth preference");
            if (playback) Playback(Check, traces);
            passed = true;
        }
        finally
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new {
                passed, checks, traces,
                source = "generated pulse PCM and optional default Windows audio output; no microphone recording",
                limitation = "Energy and playback timing checks do not establish phoneme-specific lip shapes or human audiovisual acceptance."
            }, new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    private static float[] Pulse(int rate)
    {
        var samples = new float[rate * 5 / 4];
        for (var i = 0; i < samples.Length; i++)
        {
            var t = (double)i / rate;
            if (t is >= .2 and < .5 or >= .75 and < 1.05)
                samples[i] = (float)(.18 * Math.Sin(2 * Math.PI * 220 * t));
        }
        return samples;
    }

    private static void Playback(Action<bool, string> check, List<object> traces)
    {
        var completed = new ConcurrentQueue<long>();
        var errors = new ConcurrentQueue<Exception>();
        using var player = new BanbanSpeechPlayer(completed.Enqueue, (_, _) => { }, errors.Enqueue);
        check(SpinWait.SpinUntil(() => player.Ready || !errors.IsEmpty, TimeSpan.FromSeconds(40)) && player.Ready,
            "the real neural player prewarms successfully");
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var type = typeof(BanbanSpeechPlayer);
        var gate = type.GetField("_gate", flags)!.GetValue(player)!;
        var queue = type.GetField("_audio", flags)!.GetValue(player)!;
        var part = type.GetNestedType("AudioPart", BindingFlags.NonPublic)!;
        // Only this test's synthesis output is replaced. Keep the production
        // WASAPI player, buffering, volume, generation and completion handling.
        void Enqueue(float[] samples, bool end = true, float volume = 1, NotificationCue cue = NotificationCue.None)
        {
            var audio = Activator.CreateInstance(part, flags | BindingFlags.Public, null,
                [player.Generation, samples, 16000, "", end, volume, cue], null)!;
            queue.GetType().GetMethod("Add", [part])!.Invoke(queue, [audio]);
        }
        void WaitFor(Func<bool> condition, string name)
            => check(SpinWait.SpinUntil(() => condition() || !errors.IsEmpty, TimeSpan.FromSeconds(12)) && condition(), name);

        void InspectPulse(string name, float volume = 1, NotificationCue cue = NotificationCue.None)
        {
            var generation = player.Generation;
            var offset = NotificationChime.Prepend(new SignalGenerator(16000, 1), cue) is NotificationChime chime
                ? chime.SpeechOffsetSeconds : 0;
            Enqueue(Pulse(16000), volume: volume, cue: cue);
            var rows = new List<(double Seconds, double Opening)>();
            var clock = Stopwatch.StartNew();
            while (!completed.Contains(generation) && errors.IsEmpty && clock.Elapsed.TotalSeconds < 12)
            {
                lock (gate)
                {
                    if (type.GetField("_output", flags)!.GetValue(player) is WasapiOut output
                        && output.PlaybackState == PlaybackState.Playing)
                    {
                        var seconds = (double)output.GetPosition() / output.OutputWaveFormat.AverageBytesPerSecond - offset;
                        rows.Add((seconds, player.MouthOpening));
                    }
                }
                Thread.Sleep(5);
            }
            check(completed.Contains(generation) && errors.IsEmpty, name + " completes on the real Windows output");
            var quiet = rows.Where(r => r.Seconds is >= .06 and < .14 or >= .57 and < .69 or >= 1.12 and < 1.20).ToArray();
            var voiced = rows.Where(r => r.Seconds is >= .27 and < .43 or >= .82 and < .98).ToArray();
            check(quiet.Length >= 12 && quiet.All(r => r.Opening == 0), name + " follows the actual output clock through pauses");
            check(voiced.Length >= 12 && voiced.All(r => volume == 0 ? r.Opening == 0 : r.Opening > .8),
                name + " follows voiced passages after device resampling and buffering");
            if (offset > 0) check(rows.Any(r => r.Seconds < -.1) && rows.Where(r => r.Seconds < 0).All(r => r.Opening == 0),
                "notification music does not animate the speech mouth");
            check(player.MouthOpening == 0, name + " closes the mouth on natural completion");
            traces.Add(new { name, speechOffsetSeconds = offset, observed = rows.Select(r => new { seconds = r.Seconds, opening = r.Opening }) });
        }

        InspectPulse("two pulse passages");
        player.Stop(); completed.Clear();
        InspectPulse("muted pulse passages", volume: 0);
        player.Stop(); completed.Clear();
        InspectPulse("important notification prefix", cue: NotificationCue.Important);
        player.Stop(); completed.Clear();
        Enqueue(Pulse(16000), end: false);
        WaitFor(() => player.MouthOpening > .8, "an unfinished streamed sentence starts its actual mouth envelope");
        WaitFor(() => { lock (gate) return type.GetField("_output", flags)!.GetValue(player) is null; },
            "the first streamed audio part finishes without ending the answer");
        Thread.Sleep(100);
        check(player.MouthOpening == 0 && completed.IsEmpty, "waiting for the next streamed sentence keeps the mouth closed");
        Enqueue(Pulse(16000));
        WaitFor(() => player.MouthOpening > .8, "the next streamed sentence restarts from its own audio clock");
        var old = player.Generation;
        player.Stop();
        check(player.MouthOpening == 0 && player.Generation != old, "stopping playback immediately invalidates the visible opening");
        Thread.Sleep(100);
        check(player.MouthOpening == 0 && !completed.Contains(old), "cancelled audio cannot reopen the mouth or report completion");
        InspectPulse("fresh speech after interruption");
        player.Dispose();
        check(player.MouthOpening == 0 && errors.IsEmpty, "disposing the player leaves the mouth closed without audio failures");
    }
}

using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Avalonia.Media;
using ICeClass.Receiver;

internal static class SelfStudyFeedbackChecks
{
    internal static void Run()
    {
        var checks = 0;
        void Check(bool value, string name) { if (!value) throw new InvalidOperationException(name); checks++; }
        Check(SelfStudySoundMeter.Measure([]) == 0 && SelfStudySoundMeter.Measure(new float[800]) == 0, "silence never produces fabricated motion");
        var previous = 0d;
        foreach (var amplitude in new[] { .001f, .01f, .05f, .2f, 1f })
        {
            var level = SelfStudySoundMeter.Measure(Enumerable.Repeat(amplitude,800).ToArray());
            Check(level > previous && level <= 1, "louder PCM increases the bounded visual amplitude"); previous = level;
        }
        Check(SelfStudySoundMeter.Measure([float.NaN]) == 0 && SelfStudySoundMeter.Measure([float.PositiveInfinity]) == 0, "invalid microphone samples cannot corrupt rendering");
        foreach (var light in new[] { true, false })
        {
            var listening = new SelfStudyFeedback("listening", "", true);
            var observing = listening with { State = "observing" };
            var blue = ClassroomIslandRibbon.SelfStudyTargetColor(listening, 0, light);
            var start = ClassroomIslandRibbon.SelfStudyTargetColor(observing, 0, light);
            var middle = ClassroomIslandRibbon.SelfStudyTargetColor(observing, 5, light);
            var amber = ClassroomIslandRibbon.SelfStudyTargetColor(observing, 10, light);
            Check(start == blue && middle != blue && middle != amber, "observation warms continuously instead of jumping to amber");
            Check(middle == ClassroomIslandRibbon.BlendSelfStudyColor(blue, amber, .5), "observation color follows elapsed observation time");
            var longer = observing with { ObservationSeconds = 30 };
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(longer, 15, light) == middle &&
                ClassroomIslandRibbon.SelfStudyTargetColor(longer, 10, light) != amber,
                "continuous color follows the teacher's actual observation duration");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(observing, 100, light) == amber, "observation alone never advances to red");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = "analyzing" }, 30, light) == amber, "pending review remains amber");
            var warning = ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = "warning" }, 0, light);
            var reported = ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = "reported" }, 0, light);
            Check(warning.R > warning.G && warning.R > warning.B && reported.R > reported.G && reported.R > reported.B && warning != reported,
                "confirmed reminder and teacher report have distinct red levels");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(observing with { Alert = "warning" }, 0, light) == warning,
                "new observation retains the already-confirmed reminder");
            var newEvidence = ClassroomIslandRibbon.SelfStudyTargetColor(observing with { Alert = "warning" }, 10, light);
            Check(newEvidence != warning && newEvidence != reported, "new observation gradually deepens the existing red without claiming a report");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = "analyzing", Alert = "warning" }, 10, light) == newEvidence,
                "second review retains the reminder's red");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(observing with { Alert = "reported" }, 5, light) == reported,
                "a delivered report remains marked until its episode clears");
            Check(ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = "teaching", Alert = "warning" }, 10, light) == blue,
                "learning verdict restores a calm color");
            foreach (var phase in new[] { "budget", "ai_paused" })
                Check(ClassroomIslandRibbon.SelfStudyTargetColor(listening with { State = phase, Alert = "warning" }, 10, light) == blue,
                    "AI pause does not invent a new alert: " + phase);
            Check(ClassroomIslandRibbon.BlendSelfStudyColor(blue, warning, 0) == blue &&
                ClassroomIslandRibbon.BlendSelfStudyColor(blue, warning, 1) == warning, "color transitions preserve both endpoints");
        }
        foreach (var feedback in new[] { new SelfStudyFeedback("observing", "完整说明", true), new("analyzing", "完整说明", true),
            new("warning", "完整说明", true, Reminder:true), new("reported", "完整说明", true), new("teaching", "完整说明", true),
            new("ai_paused", "连接暂不可用", true), new("paused", "本节暂停", false), new("error", "麦克风不可用", false) })
            Check(feedback.ShortLabel.Length > 0 && feedback.AccessibleText.Contains(feedback.Caption) && feedback.AccessibleText.Contains(feedback.Detail),
                "short inline phase retains the full accessible operation and reason: " + feedback.Phase);
        foreach (var width in new[] { 96, 180, 260, 470, 680 })
        {
            var (copy, wave, status) = ClassroomIslandRibbon.SelfStudyRegions(new(0,0,width,48));
            Check(copy.Right <= wave.X && wave.Right <= status.X && status.Right <= width && wave.Width >= 0,
                "copy, waveform and status do not overlap at " + width);
            Check(wave.Top >= 0 && wave.Bottom <= 48 && status.Height == 48,
                "waveform and inline status stay inside the unchanged shell at " + width);
        }
        var wide = ClassroomIslandRibbon.SelfStudyRegions(new(0,0,680,48));
        Check(wide.Wave.Width >= 300, "wide native waveform retains the approved long form");
        foreach (var width in new[] { 180, 260, 470, 680 })
        {
            var (copy, wave, status) = ClassroomIslandRibbon.SelfStudyRegions(new(0, 0, width, 48));
            Check(status.Width >= 74 && copy.Right <= wave.X && wave.Right <= status.X && status.Right <= width,
                "AI pause has a visible short label without overlapping the waveform at " + width);
        }
        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
        foreach (var unavailable in new[] { "disabled", "connection", "budget", "upstream" })
        {
            var reminders = 0;
            using var monitor = new SelfStudyMonitor(_ => { reminders++; return Task.FromResult(false); }, () => false, () => { });
            void Set(string name, object? value) => typeof(SelfStudyMonitor).GetField(name,flags)!.SetValue(monitor,value);
            object? Get(string name) => typeof(SelfStudyMonitor).GetField(name,flags)!.GetValue(monitor);
            var clock = Environment.TickCount64; var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var config = new SelfStudyConfig { Enabled=true, Authorized=true, AiEnabled=unavailable!="disabled" };
            Set("_binding",new ReceiverConfig { Endpoint="", ClassId="test" });
            Set("_snapshot",new SelfStudySnapshot { Config=config, AiReady=unavailable!="connection",ServerTime=now,
                Usage=new() { Calls=unavailable=="budget"?4:0 },Schedule=[new() { Key="live",StartAt=now-1000,EndAt=now+60000 }] });
            Set("_syncedAt",clock); Set("_nextSync",long.MaxValue); Set("_lastStatus",clock);
            Set("_session","live"); Set("_nextReview",long.MaxValue);
            if(unavailable=="upstream")Set("_aiRetryAfter",clock+60000);
            var capture = RuntimeHelpers.GetUninitializedObject(typeof(SelfStudyAudio)); Set("_audio",capture);
            SelfStudyFeedback? feedback=null; monitor.FeedbackChanged+=value=>feedback=value;
            var token=((CancellationTokenSource)Get("_sessionLife")!).Token;
            try
            {
                typeof(SelfStudyMonitor).GetMethod("Tick",flags)!.Invoke(monitor,null);
                var state=JsonSerializer.SerializeToElement(monitor.View()).GetProperty("state").GetString();
                Check(state==(unavailable=="budget"?"budget":"ai_paused") && feedback?.Capturing==true, "AI stop keeps live sound and explicit pause: "+unavailable);
                Check(ReferenceEquals(Get("_audio"),capture) && !token.IsCancellationRequested, "AI stop does not restart or dispose the capture: "+unavailable);
                Check(Get("_analysisEnabled") is false, "AI stop disables VAD segmentation and transcription: "+unavailable);
                var segment = new BanbanSpeechAudio(Enumerable.Repeat(.2f,48000).ToArray(),true,SpeechSamples:32000,CapturedSamples:48000);
                typeof(SelfStudyMonitor).GetMethod("Segment",flags)!.Invoke(monitor,[segment,0]);
                Check(((SelfStudyCandidateBuffer)Get("_buffer")!).Count==0 && reminders==0, "AI stop cannot add evidence or reminders: "+unavailable);
            }
            finally { Set("_audio",null); }
        }
        using (var monitor = new SelfStudyMonitor(_ => Task.FromResult(false), () => false, () => { }))
        {
            void Set(string name, object? value) => typeof(SelfStudyMonitor).GetField(name, flags)!.SetValue(monitor, value);
            object? Get(string name) => typeof(SelfStudyMonitor).GetField(name, flags)!.GetValue(monitor);
            Set("_period", new SelfStudyPeriod { Key = "previous-class" });
            Set("_publishedFeedback", new SelfStudyFeedback("reported", "previous-class-result", false));
            Set("_aiRetryAfter", long.MaxValue);
            Set("_retryAfter", long.MaxValue);
            Set("_eventAttention", "reported");
            SelfStudyFeedback? feedback = new("reported", "previous-class-result", false);
            monitor.FeedbackChanged += value => feedback = value;
            monitor.SetBinding(new ReceiverConfig { Endpoint = "", ClassId = "new-class", DeviceId = "new-device" });
            Check(feedback is null && Get("_period") is null, "rebinding clears the previous lesson and its feedback immediately");
            Check(Get("_aiRetryAfter") is 0L && Get("_retryAfter") is 0L, "rebinding does not inherit another classroom's device or AI retry delay");
            Check(Get("_eventAttention") is "", "rebinding clears another classroom's alert color");
        }
        Console.WriteLine("Self-study feedback checks passed: "+checks);
    }
}

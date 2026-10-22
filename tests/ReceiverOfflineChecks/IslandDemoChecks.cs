using ICeClass.Receiver;

internal static class IslandDemoChecks
{
    public static int Run()
    {
        var checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; Console.WriteLine("PASS " + message); }
        var clock = new DemoClock();
        var demo = new IslandDemoPlayback(new DateOnly(2026, 10, 20), clock);
        IslandRibbonFrame Frame()
        {
            var scene = demo.Scene();
            return IslandRibbonPresentation.Build(scene.Profile, scene.Now, scene.View);
        }
        demo.Play();
        Check(Frame() is { Key: "timetable" } initial && initial.Items.Any(i => i.Current && i.Subject == "课间休息"), "complete demo begins with the production break timetable");
        clock.Advance(2);
        Check(Frame() is { Accent: true, Text: "即将上课" }, "the preset produces the actual preparation attention cue");
        clock.Advance(3);
        Check(Frame() is { Key: "prepare:countdown", Text: "距上课还有 57 秒", Detail: "下节课是：历史 10:40-11:20" }, "the production countdown uses the sample clock and complete course time");
        var progress = Frame().Progress;
        clock.Advance(1);
        Check(Frame().Progress < progress, "countdown and progress advance together without accelerating the real clock");
        clock.Advance(6);
        Check(Frame().Key == "prepare:message" && demo.Scene().Stage == 3, "preparation guidance replaces the countdown in the same presenter");
        demo.Pause(); var paused = demo.Position; var pausedFrame = Frame(); clock.Advance(30);
        Check(demo.Position == paused && Frame().Text == pausedFrame.Text && Frame().Progress == pausedFrame.Progress, "pause holds sample time, message and progress despite wall-clock movement");
        demo.Seek(30);
        Check(!demo.Playing && Frame().Key == "prepare:countdown", "selecting a stage can hold the preset without resuming playback");
        demo.Play(); clock.Advance(32);
        Check(Frame() is { Accent: true, Text: "上课" }, "reaching the sample bell produces the real lesson-start attention cue");
        clock.Advance(5);
        Check(Frame() is { Key: "timetable" } restored && restored.Items.Any(i => i.Current && i.Subject == "历史") && demo.Scene().Stage == 5, "the demonstration restores the advanced timetable after the start cue");
        clock.Advance(100);
        Check(demo.Complete && !demo.Playing && demo.Position == 72 && Frame().Key == "timetable", "playback stops at the restored timetable with no lingering reminder");
        demo.Restart();
        Check(demo.Playing && demo.Position == 0 && Frame().Key == "timetable" && demo.Scene().View.Notice is null, "replay resets the sample timetable and previous notice");
        var sceneProfile = demo.Scene().Profile;
        Check(sceneProfile.Automation.Count == 0 && !sceneProfile.Reminders.Sound && !sceneProfile.Reminders.Speech && !demo.Scene().View.CanOpenReading,
            "the preset contains no app automation, audio playback or real reading action");
        return checks;
    }

    private sealed class DemoClock : TimeProvider
    {
        private long _ticks;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _ticks;
        public void Advance(double seconds) => _ticks += TimeSpan.FromSeconds(seconds).Ticks;
    }
}

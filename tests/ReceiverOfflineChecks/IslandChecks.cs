using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class IslandChecks
{
    public static int Run(string root)
    {
        var checks = 0;
        void Check(bool condition, string description)
        {
            if (!condition) throw new Exception(description);
            ++checks; Console.WriteLine("PASS " + description);
        }
        var clock = new ManualClock();
        var state = new ClassroomIslandState(clock);
        var binding = new ReceiverConfig { Endpoint = "http://127.0.0.1:8838", DeviceId = "island-test", ClassId = "class-a", ClassName = "高一（10）班" };
        state.SetBinding(binding);
        var online = new ReceiverConnectionState(true, "已连接平台");
        var monday = new DateTimeOffset(2026, 10, 19, 7, 25, 0, TimeSpan.FromHours(8));
        var rules = JsonNode.Parse("""
            {"classId":"class-a","hasRules":true,"online":true,"revoked":false,
             "config":{"enabled":true,"reminderEnabled":false,"periods":[
               {"weekdays":[1],"start":440,"end":450},{"weekdays":[1],"start":448,"end":460}]}}
            """)!.AsObject();
        ClassroomIslandView View(JsonObject? snapshot = null, DateTimeOffset? at = null, bool opened = false) =>
            state.Present(snapshot ?? rules, (at ?? monday).ToUnixTimeMilliseconds(), online, opened);
        var active = View();
        Check(active.Clock == "07:25" && active.Date.Contains("周一"), "island uses the server clock in UTC+8");
        Check(active.ReadingTitle == "早读时段" && active.ReadingDetail.Contains("07:20–07:40"), "overlapping scoring periods remain active when reminders are disabled");
        Check(active.ReadingDetail.Contains("15 分钟"), "merged period shows the remaining time without inventing gameplay progress");
        var ended = View(at: monday.AddMinutes(15));
        Check(ended.ReadingTitle == "早读待开始" && ended.ReadingDetail.Contains("10月26日 07:20"), "end boundary switches to the next weekly period");
        Check(View(opened: true).Status == "早读已打开" && View(opened: true).ReadingTitle == "早读时段", "an open window is distinguished from an active scoring period");
        var disabled = rules.DeepClone().AsObject(); disabled["config"]!["enabled"] = false;
        Check(View(disabled).ReadingTitle == "早读计分未启用" && View(disabled).CanOpenReading, "disabled scoring still permits local practice");
        var cached = rules.DeepClone().AsObject(); cached["online"] = false;
        Check(View(cached).ReadingDetail.Contains("本机设置"), "offline cached rules are labelled accurately");
        var missing = state.Present(null, monday.ToUnixTimeMilliseconds(), new(false, "网络已断开"), false);
        Check(missing.CanOpenReading && missing.ReadingDetail.Contains("网络恢复"), "a fresh offline classroom keeps the local reading entry available");
        var revoked = rules.DeepClone().AsObject(); revoked["revoked"] = true;
        Check(!View(revoked).CanOpenReading && View(revoked).ReadingTitle.Contains("重新绑定"), "revoked binding cannot start reading from the island");
        var wrongClass = revoked.DeepClone().AsObject(); wrongClass["classId"] = "class-b";
        Check(View(wrongClass).CanOpenReading && View(wrongClass).ReadingTitle.Contains("同步"), "stale data from another class never describes the current binding");

        var notification = new ShoutData { SenderName = "王老师", Text = "请带好课本。", DisplayDurationSec = 10, AlertLevel = "warning" };
        state.Receive(notification);
        notification.Text = "a later mutation";
        Check(View().Notice is { Sender: "王老师", Text: "请带好课本。" } && View().Status.Contains("王老师"), "displayed notifications are copied into the island without replacing their payload");
        clock.Advance(TimeSpan.FromSeconds(9));
        Check(View().Notice is not null, "notice remains readable for its configured duration");
        Check(Math.Abs(View().Notice!.Progress-.1)<.001 && View().Notice!.AgeSeconds==9, "notice progress and cue age follow the monotonic clock");
        clock.Advance(TimeSpan.FromSeconds(1));
        Check(View().Notice is null && View().Status == "早读时段", "notice expires at the deadline and normal status returns");
        state.Receive(new ShoutData { SenderName = "甲老师", Text = "第一条", DisplayDurationSec = 5 });
        clock.Advance(TimeSpan.FromSeconds(4));
        state.Receive(new ShoutData { SenderName = "乙老师", ContentType = "audio", DisplayDurationSec = 10 });
        clock.Advance(TimeSpan.FromSeconds(2));
        Check(View().Notice is { Sender: "乙老师" } && View().Notice!.Text.Contains("语音"), "newer voice notification replaces the old one and has its own expiry");
        state.DismissNotice(); Check(View().Notice is null, "dismissing the island summary clears only its own notice");
        state.Receive(new ShoutData { Text = "当前班级通知" });
        binding.ClassName = "高一（10）实验班"; state.SetBinding(binding);
        Check(View().ClassName == binding.ClassName && View().Notice is not null, "renaming the current class refreshes the label without losing its notice");
        binding.ClassId = "class-b"; state.SetBinding(binding);
        Check(View().Notice is null, "changing class immediately clears the previous class notification");
        state.Receive(new ShoutData { Text = "来自原服务的通知" });
        binding.Endpoint = "http://127.0.0.1:8839"; state.SetBinding(binding);
        Check(View().Notice is null, "changing the service also clears scoped notification content");

        var preferencesPath = Path.Combine(root, "island", "settings.json");
        var preferences = new ClassroomIslandPreferencesStore(preferencesPath);
        Check(preferences.Load() == new ClassroomIslandPreferences(), "island is visible and clear on first launch");
        preferences.Save(new(false, true));
        Check(new ClassroomIslandPreferencesStore(preferencesPath).Load() == new ClassroomIslandPreferences(false, true), "hidden and dimmed preferences survive restart independently of classroom credentials");
        File.WriteAllText(preferencesPath, "interrupted{");
        Check(preferences.Load() == new ClassroomIslandPreferences(), "damaged optional preferences recover safely");
        var production = new ReceiverConfig { Endpoint = "https://school.example" };
        Check(ClassroomIslandPreferencesStore.PathFor(binding) != ClassroomIslandPreferencesStore.PathFor(production), "local review preferences are isolated from an installed classroom");
        return checks;
    }

    private sealed class ManualClock : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _timestamp;
        public void Advance(TimeSpan elapsed) => _timestamp += elapsed.Ticks;
    }
}

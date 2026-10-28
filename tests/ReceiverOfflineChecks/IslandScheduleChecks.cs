using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class IslandScheduleChecks
{
    public static int Run(string root)
    {
        var checks = 0;
        void Check(bool result, string label) { if (!result) throw new Exception(label); checks++; Console.WriteLine("PASS " + label); }
        var p = new IslandProfile { Slots = [new() { Id = "p1", Label = "第一节", Start = 480, End = 520 }],
            Lessons = [new() { SlotId = "p1", Weekday = 1, Week = "odd", Subject = "语文" }, new() { SlotId = "p1", Weekday = 1, Week = "even", Subject = "数学" }] };
        p = IslandProfile.Parse(JsonSerializer.Serialize(p, IslandProfile.Json));
        Check(IslandSchedule.On(p, new(2026, 9, 7))[0].Lesson.Subject == "语文" && IslandSchedule.On(p, new(2026, 9, 14))[0].Lesson.Subject == "数学", "alternating weeks resolve from the configured Monday");
        Check(IslandSchedule.On(p, new(2026, 8, 31))[0].Lesson.Subject == "数学", "week parity before the anchor uses floor division");
        Check(IslandSchedule.On(p, new(2026, 10, 18)).Count == 0, "empty weekend has no invented lessons");
        p.Overrides.Add(new() { Date = "2026-10-19", SlotId = "p1", Subject = "班会" });
        Check(IslandSchedule.On(p, new(2026, 10, 19))[0] is { Temporary: true, Lesson.Subject: "班会" }, "date substitution replaces one occurrence");
        p.Overrides[0].Cancelled = true;
        Check(IslandSchedule.On(p, new(2026, 10, 19)).Count == 0 && IslandSchedule.On(p, new(2026, 10, 26)).Count == 1, "temporary cancellation leaves subsequent weeks intact");
        p.Overrides.Clear();
        DateTimeOffset At(int h, int m, int s = 0) => new(2026, 10, 19, h, m, s, TimeSpan.FromHours(8));
        Check(IslandSchedule.Status(p, At(7, 59)).Contains("距上课 1 分钟"), "break status counts down to the next lesson");
        Check(IslandSchedule.Status(p, At(8, 0)).Contains("距下课 40 分钟") && IslandSchedule.Status(p, At(8, 39, 59)).Contains("1 秒"), "lesson interval is inclusive at start and shows final seconds");
        Check(!IslandSchedule.Status(p, At(8, 40)).Contains("距下课") && IslandSchedule.Next(p, At(8, 40))?.Date == new DateOnly(2026, 10, 26), "lesson end boundary is exclusive and next week remains discoverable");
        Check(IslandSchedule.Due(p, At(7, 57, 59), At(7, 58)).Single().Title == "准备上课", "preparation reminder fires at the configured lead time");
        Check(IslandSchedule.Due(p, At(7, 59, 59), At(8, 0)).Single().Title == "上课啦", "class reminder fires once at its boundary");
        Check(IslandSchedule.Due(p, At(8, 39, 59), At(8, 40)).Single().Title == "下课啦", "break reminder fires at class end");
        Check(IslandSchedule.Due(p, At(7, 0), At(8, 20)).Count == 0, "resume after sleep does not replay stale reminders");
        p.Automation.Add(new() { Id = "r1", Name = "课前提示", Trigger = "start", Action = "reminder", Value = "请就座" });
        p.Automation.Add(new() { Id = "r2", Name = "定时", Trigger = "time", Minute = 480, Value = "请准备" });
        var due = IslandSchedule.Due(p, At(7, 59, 59), At(8, 0));
        Check(due.Count == 3 && due.Select(e => e.Key).Distinct().Count() == 3, "time and lesson automations have distinct durable identities");
        var store = new IslandLocalStore(Path.Combine(root, "island-ledger")); var ledger = new IslandEventLedger(store);
        Check(ledger.Claim(due[0], At(8, 0).ToUnixTimeMilliseconds()) && !new IslandEventLedger(store).Claim(due[0], At(8, 0).ToUnixTimeMilliseconds()), "event claim survives restart and prevents duplicate side effects");
        p.Enabled = false;
        Check(IslandSchedule.Due(p, At(7, 59, 59), At(8, 0)).Count == 0, "disabled classroom profile stops all automatic actions"); p.Enabled = true;
        p.Reminders.Enabled = false;
        Check(IslandSchedule.Due(p, At(7, 59, 59), At(8, 0)).Count == 2, "reminder switch does not suppress independently configured automation");
        p.Overrides.Add(new() { Date = "2026-10-19", SlotId = "p1", Cancelled = true });
        Check(IslandSchedule.Due(p, At(7, 59, 59), At(8, 0)).Single().Automation?.Trigger == "time", "cancelled lesson suppresses class triggers but preserves clock rules");
        var midnight = new IslandProfile { Slots = [new() { Id = "m", Start = 0, End = 40 }], Lessons = [new() { SlotId = "m", Weekday = 2, Subject = "自习" }] };
        Check(IslandSchedule.Due(midnight, At(23, 57, 59), At(23, 58)).Single().Title == "准备上课", "preparation reminder crosses midnight using the lesson's date");
        var c = new IslandComponent { Type = "countdown", Title = "运动会", Date = "2026-10-20" };
        Check(IslandSchedule.ComponentText(c, At(8, 0)) == "距运动会 1 天", "countdown uses Shanghai calendar days");
        var binding = new ReceiverConfig { Endpoint = "http://127.0.0.1:1", DeviceId = "test", ClassId = "a" };
        Check(IslandLocalStore.RootFor(binding) != IslandLocalStore.RootFor(new() { Endpoint = binding.Endpoint, DeviceId = binding.DeviceId, ClassId = "b" }), "cache and automation claims are isolated by class binding");
        var cacheRoot = Path.Combine(root, "island-profile"); var cache = new IslandLocalStore(cacheRoot);
        cache.Write("profile.json", new { classId = "a", revision = 4, config = p, revoked = false });
        using (var sync = new IslandSyncService(binding, cacheRoot, start: false))
            Check(sync.Snapshot.Profile is not null && sync.Snapshot.Revision == 4 && !sync.Snapshot.Online, "a fresh process recovers its real timetable while offline");
        using (var sync = new IslandSyncService(new() { Endpoint = binding.Endpoint, DeviceId = "test", ClassId = "b" }, cacheRoot, start: false))
            Check(sync.Snapshot.Profile is null, "cached profile from another class cannot be loaded");
        var fakeExe = Path.Combine(root, "not-allowed.exe"); File.WriteAllText(fakeExe, "fixture");
        Check(!IslandActionRunner.ApplicationAllowed(fakeExe, []) && IslandActionRunner.ApplicationAllowed(fakeExe, [fakeExe]) && !IslandActionRunner.ApplicationAllowed(fakeExe + " --arg", [fakeExe]), "only explicitly allowed executable paths can be launched without arguments");
        var invalid = JsonNode.Parse(JsonSerializer.Serialize(p, IslandProfile.Json))!.AsObject(); invalid["slots"]![0]!["end"] = 0;
        try { IslandProfile.Parse(invalid.ToJsonString()); throw new Exception("invalid profile accepted"); } catch (InvalidDataException) { checks++; }
        invalid = JsonNode.Parse(JsonSerializer.Serialize(p, IslandProfile.Json))!.AsObject();
        invalid["components"] = new JsonArray(new JsonObject { ["id"] = "broken", ["type"] = "text", ["text"] = null });
        try { IslandProfile.Parse(invalid.ToJsonString()); throw new Exception("null component accepted"); } catch (InvalidDataException) { checks++; }
        var damaged = new IslandLocalSettings { AllowedApplications = null!, RecentActions = null!, Appearance = new() { Width = 10, Theme = null! } };
        damaged.Normalize();
        Check(damaged.AllowedApplications.Count == 0 && damaged.RecentActions.Count == 0 && damaged.Appearance.Width == 380 && damaged.Appearance.Theme == "light", "partial local preferences recover without disrupting the classroom scheduler");
        var rotations = new IslandProfile { Slots = [new() { Id = "mid", Label = "静校", Start = 750, End = 810 }, new() { Id = "eve", Label = "晚自习", Start = 1100, End = 1190 }],
            DutyRotations = new() {
                ["midday"] = new() { Enabled = true, CycleWeeks = 3, WeekAnchor = "2026-09-07", SlotIds = ["mid"],
                    Lessons = Enumerable.Range(1, 3).Select(w => new IslandDutyLesson { SlotId = "mid", Weekday = 1, CycleWeek = w, Subject = "午间静校", Teacher = "午" + w }).ToList() },
                ["evening"] = new() { Enabled = true, CycleWeeks = 4, WeekAnchor = "2026-09-14", SlotIds = ["eve"],
                    Lessons = Enumerable.Range(1, 4).Select(w => new IslandDutyLesson { SlotId = "eve", Weekday = 1, CycleWeek = w, Subject = "数学", Teacher = "晚" + w }).ToList() }
            } };
        rotations = IslandProfile.Parse(JsonSerializer.Serialize(rotations, IslandProfile.Json));
        Check(IslandSchedule.On(rotations, new(2026, 9, 21)).Select(l => l.Lesson.Teacher).SequenceEqual(new[] { "午3", "晚2" }) &&
            IslandSchedule.On(rotations, new(2026, 9, 28)).Select(l => l.Lesson.Teacher).SequenceEqual(new[] { "午1", "晚3" }), "midday and evening rotate independently and wrap at their own cycle lengths");
        Check(IslandSchedule.On(rotations, new(2026, 8, 31)).Count == 0 && IslandSchedule.On(rotations, new(2026, 9, 7)).Count == 1, "rotations do not start before their independently configured Mondays");
        rotations.Overrides = [new() { Date = "2026-09-21", SlotId = "mid", Cancelled = true }, new() { Date = "2026-09-21", SlotId = "eve", Subject = "语文", Teacher = "代班" }];
        Check(IslandSchedule.On(rotations, new(2026, 9, 21)) is [{ Temporary: true, Lesson.Teacher: "代班" }] &&
            IslandSchedule.On(rotations, new(2026, 9, 28))[0].Lesson.Teacher == "午1", "date cancellation and substitution override duty once without moving the cycle");
        var rotationStore = new IslandLocalStore(Path.Combine(root, "island-duty-cache"));
        rotationStore.Write("profile.json", new { classId = "a", revision = 5, config = rotations, revoked = false });
        using (var sync = new IslandSyncService(binding, Path.Combine(root, "island-duty-cache"), start: false))
            Check(sync.Snapshot.Profile is not null && IslandSchedule.On(sync.Snapshot.Profile, new(2026, 10, 12))[1].Lesson.Teacher == "晚1", "full rotation survives restart and resolves future weeks offline");
        rotations.DutyRotations["evening"].Enabled = false;
        var mid = rotations.DutyRotations["midday"]; mid.WeekAnchor = "2026-12-28";
        mid.Lessons = [new() { SlotId = "mid", Weekday = 1, CycleWeek = 3, Subject = "静校", Teacher = "第三周" }];
        var afterFirstWeek = new DateTimeOffset(2026, 12, 28, 15, 0, 0, TimeSpan.FromHours(8));
        Check(IslandSchedule.Next(rotations, afterFirstWeek)?.Date == new DateOnly(2027, 1, 11), "next lesson crosses an empty rotation week and a year boundary");
        mid.CycleWeeks = 20; mid.Lessons[0].CycleWeek = 20;
        Check(IslandSchedule.Next(rotations, afterFirstWeek)?.Date == new DateOnly(2027, 5, 10), "next lesson searches the full twenty-week duty cycle");
        mid.CycleWeeks = 3; mid.Lessons[0].CycleWeek = 3;
        Check(IslandSchedule.Next(rotations, new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero))?.Date == new DateOnly(2027, 1, 11), "future first-cycle anchor remains discoverable beyond the current cycle window");
        mid.Lessons.Add(mid.Lessons[0]);
        try { IslandProfile.Parse(JsonSerializer.Serialize(rotations, IslandProfile.Json)); throw new Exception("duplicate duty accepted"); } catch (InvalidDataException) { checks++; }
        mid.Lessons.RemoveAt(1); mid.CycleWeeks = 0;
        try { IslandProfile.Parse(JsonSerializer.Serialize(rotations, IslandProfile.Json)); throw new Exception("zero duty cycle accepted"); } catch (InvalidDataException) { checks++; }
        return checks;
    }
}

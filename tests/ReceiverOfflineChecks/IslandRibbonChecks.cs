using ICeClass.Receiver;

internal static class IslandRibbonChecks
{
    internal static IslandProfile Fixture()
    {
        var subjects = new[] { "语文", "数学", "美术", "历史", "音乐", "生物", "语文", "自习", "自习", "自习", "自习" };
        var starts = new[] { 480, 530, 590, 640, 690, 840, 890, 940, 990, 1080, 1130 };
        return new IslandProfile {
            Slots = starts.Select((s, i) => new IslandSlot { Id = "p"+i, Label = "第"+(i+1)+"节", Start=s, End=s+40 }).ToList(),
            Lessons = subjects.Select((s, i) => new IslandLesson { SlotId="p"+i, Weekday=4, Subject=s }).ToList(),
            Reminders = new() { PrepareMinutes=1 }
        };
    }
    internal static DateTimeOffset At(int h, int m, int s=0) => new(2026,2,26,h,m,s,TimeSpan.FromHours(8));
    internal static ClassroomIslandView View(ClassroomIslandNotice? notice=null) => new("高一（1）班", "10:39", "周四", "暂无课程", "早读待开始", "可打开早读活动", true, true, "已连接", notice);
    public static int Run()
    {
        var checks=0;
        void Check(bool value,string label) { if(!value) throw new Exception(label); checks++; Console.WriteLine("PASS "+label); }
        var p=Fixture();
        var normal=IslandRibbonPresentation.Build(p,At(10,38),View());
        Check(normal.Key=="timetable" && normal.Items.Single(i=>i.Current).Subject=="课间休息", "ribbon resolves the real break without entering preparation too early");
        var prep=IslandRibbonPresentation.Build(p,At(10,39,6),View());
        Check(prep.Text.Contains("54 秒") && prep.Detail.Contains("历史") && Math.Abs(prep.Progress-.9)<.001, "preparation countdown uses seconds and the actual next lesson");
        Check(IslandRibbonPresentation.Build(p,At(10,39,16),View()).Key=="prepare:message", "preparation text alternates every ten seconds");
        var start=IslandRibbonPresentation.Build(p,At(10,40),View());
        Check(start.Key=="timetable" && start.Items.Single(i=>i.Current).Subject=="历史" && start.Items.Single(i=>i.Current).Progress==0, "lesson boundary restores the timetable and advances the active lesson");
        p.Reminders.Enabled=false;
        Check(IslandRibbonPresentation.Build(p,At(10,39),View()).Key=="timetable", "disabled reminders never show an automatic countdown");
        p.Overrides.Add(new() { Date="2026-02-26",SlotId="p3",Subject="班会" });
        Check(IslandRibbonPresentation.Build(p,At(10,40),View()).Items.Single(i=>i.Current).Subject=="班会", "ribbon respects date-specific substitutions");
        p.Overrides[0].Cancelled=true;
        Check(!IslandRibbonPresentation.Build(p,At(10,40),View()).Items.Any(i=>i.Id=="p3"), "ribbon removes cancelled lessons");
        p.Overrides.Clear(); p.Lessons[3].Week="even";
        Check(!IslandRibbonPresentation.Build(p,At(10,40),View()).Items.Any(i=>i.Id=="p3"), "ribbon uses the same alternating-week resolution as the timetable");
        var notice = new ClassroomIslandNotice("班主任", "请带好课本到实验室", "warning", Sequence:5, Progress:.5, AgeSeconds:4);
        var body=IslandRibbonPresentation.Build(p,At(10,38),View(notice));
        Check(!body.Accent && body.Text==notice.Text && body.Detail.Contains("重要喊话") && body.Shout?.Sender==notice.Sender && body.AccessibleText.Contains(notice.Text) && body.Color=="#FFD178",
            "a teacher shout displays its complete message inside the ribbon presentation");
        var cue = IslandRibbonPresentation.Build(p,At(10,38),View(notice with {AgeSeconds=0}));
        Check(cue.Accent && cue.Text=="班班传话" && cue.Key!=body.Key,
            "the Banban attention cue transitions to the message in the same ribbon");
        var unicode = string.Concat(Enumerable.Repeat("𠮷语文 e\u0301 📚", 20));
        var pages = IslandShoutText.Pages(unicode, 9, text => System.Globalization.StringInfo.ParseCombiningCharacters(text).Length);
        Check(string.Concat(pages)==unicode, "inline pages preserve every character of a long message");
        Check(pages.All(page=>System.Globalization.StringInfo.ParseCombiningCharacters(page).Length<=9) && pages.All(page=>!char.IsLowSurrogate(page[0]) && page[0]!='\u0301'),
            "inline pagination fits the available width without splitting Unicode text elements");
        var sentence = IslandShoutText.Pages("同学们，请准备好课本和练习册，回到座位后保持安静。", 23, text => text.Length);
        Check(sentence.SequenceEqual(new[] { "同学们，请准备好课本和练习册，", "回到座位后保持安静。" }),
            "message pages prefer complete clauses over an isolated sentence ending");
        var punctuation = IslandShoutText.Pages("一二三四五六七八九十，接着读。", 10, text => text.Length);
        Check(string.Concat(punctuation) == "一二三四五六七八九十，接着读。" && punctuation.All(line => line.Length <= 10 && !"，。".Contains(line[0])),
            "a comma at the width boundary stays with the preceding character instead of starting a line");
        var unicodePunctuation = IslandShoutText.Pages("𠮷e\u0301甲乙，后文。", 4, text => System.Globalization.StringInfo.ParseCombiningCharacters(text).Length);
        Check(string.Concat(unicodePunctuation) == "𠮷e\u0301甲乙，后文。" && unicodePunctuation.All(line => System.Globalization.StringInfo.ParseCombiningCharacters(line).Length <= 4 && !"，。".Contains(line[0])),
            "punctuation wrapping preserves complete combining and supplementary characters");
        Check(IslandRibbonPresentation.Build(p,At(23,59),View()).Items.All(i=>i.Past) && IslandRibbonPresentation.Build(p,At(23,59),View()).Key=="timetable", "finished days retain their actual timetable without a fabricated active lesson");
        Check(IslandRibbonPresentation.Build(null,At(10,38),View()).Text=="暂无课程", "missing timetable has a readable empty state");
        var midnight=new IslandProfile {Slots=[new(){Id="midnight",Start=0,End=40}],Lessons=[new(){SlotId="midnight",Weekday=5,Subject="自习"}]};
        var beforeMidnight=IslandRibbonPresentation.Build(midnight,At(23,59),View());
        Check(beforeMidnight.Text.Contains("60 秒") && beforeMidnight.Detail.Contains("自习"),"preparation countdown crosses midnight using the upcoming day's actual lesson");
        Check(IslandRibbonPresentation.ShortSubject("𠮷语文")=="𠮷", "subject abbreviation preserves a complete Unicode character");
        return checks;
    }
}

using System.Diagnostics;
using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class NativeIslandVisibilityChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, Private)!.GetValue(owner)!;
    public static void Run(string output)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            var thread = new Thread(() => Run(output)); thread.SetApartmentState(ApartmentState.STA);
            thread.Start(); thread.Join(); return;
        }
        Directory.CreateDirectory(output);
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(output)))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }
    private static async Task Check(string output)
    {
        var passed = new List<string>();
        void Assert(bool value, string label)
        {
            if (!value) throw new Exception(label);
            passed.Add(label); Console.WriteLine("PASS " + label);
        }
        // Unique loopback binding and cached profile: no installed classroom or server records are edited.
        var scope = "quiet-review-" + Guid.NewGuid().ToString("N");
        var binding = new ReceiverConfig { Endpoint = "http://127.0.0.1:1", ClassId = scope,
            DeviceId = scope, DeviceToken = "local-check", ClassName = "课堂免打扰验收" };
        var profile = new IslandProfile {
            Slots = [new() { Id = "day", Label = "第一节", Start = 475, End = 520 },
                new() { Id = "mid", Label = "午间静校", Start = 750, End = 815 },
                new() { Id = "e1", Label = "晚自习第一节", Start = 1100, End = 1190 },
                new() { Id = "e2", Label = "晚自习第二节", Start = 1200, End = 1290 }],
            Lessons = [new() { SlotId = "day", Weekday = 1, Subject = "数学" }, new() { SlotId = "mid", Weekday = 1, Subject = "午间静校" },
                new() { SlotId = "e1", Weekday = 1, Subject = "晚自习" }, new() { SlotId = "e2", Weekday = 1, Subject = "自习" }],
            Visibility = new() { FollowSchool = true, HiddenSlotIds = ["day", "e1"] },
            Appearance = new() { HideFullscreen = false }, Components = []
        };
        var cache = new IslandLocalStore(IslandLocalStore.RootFor(binding));
        cache.Write("profile.json", new { classId = scope, revision = 1, config = profile });
        using var service = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        var window = Field<ClassroomIslandWindow>(service, "_window");
        try
        {
            service.SetBinding(binding);
            Field<DispatcherTimer>(service, "_timer").Stop();
            var sync = Field<IslandSyncService>(service, "_islandSync"); sync.Dispose();
            profile = sync.Snapshot.Profile!;
            var offline = Field<ReadingOfflineService>(service, "_offline"); offline.Dispose();
            var local = Field<IslandLocalSettings>(service, "_local");
            local.Appearance = new() { HideFullscreen = false };
            async Task At(int minute)
            {
                var now = new DateTimeOffset(2026, 10, 26, minute / 60, minute % 60, 0, TimeSpan.FromHours(8));
                lock (Field<object>(offline, "_gate"))
                {
                    typeof(ReadingOfflineService).GetField("_anchor", Private)!.SetValue(offline, now.ToUnixTimeMilliseconds());
                    typeof(ReadingOfflineService).GetField("_anchoredAt", Private)!.SetValue(offline, Stopwatch.GetTimestamp());
                }
                typeof(ClassroomIslandService).GetField("_lastTick", Private)!.SetValue(service, now.AddSeconds(-1));
                typeof(ClassroomIslandService).GetMethod("Refresh", Private)!.Invoke(service, null);
                await Task.Delay(160);
            }
            await At(474); Assert(window.IsVisible, "native island is visible before the lesson");
            await At(475); Assert(!window.IsVisible, "native island hides at the daytime lesson boundary");
            typeof(ClassroomIslandService).GetMethod("Notify", Private)!.Invoke(service, ["上课啦", "请专心上课", 8]);
            Assert(!window.IsVisible, "ordinary attention notices cannot bypass classroom hiding");
            await At(520); Assert(window.IsVisible, "native island returns immediately when the break starts");
            await At(750); Assert(window.IsVisible, "midday remains visible under the school default");
            await At(1100); Assert(!window.IsVisible, "the first evening study period hides the native island");
            await At(1190); Assert(window.IsVisible, "the evening break restores the native island");
            await At(1200); Assert(window.IsVisible, "the second evening period remains visible under the default");
            profile.Visibility!.FollowSchool = false; profile.Visibility.HiddenSlotIds = ["mid", "e2"];
            local.Appearance.HideDuringLessons = true;
            await At(475); Assert(window.IsVisible, "teacher override is respected even with old local hide-all appearance");
            await At(750); Assert(!window.IsVisible, "teacher-selected midday class hides in the real native window");
            await At(815); Assert(window.IsVisible, "custom quiet period also restores at the exact end");
            await At(1100); Assert(window.IsVisible, "teacher may keep the first evening lesson visible");
            await At(1200); Assert(!window.IsVisible, "teacher may hide the second evening lesson instead");
            service.ShowControls(); await Task.Delay(160);
            Assert(window.IsVisible && window.IsExpanded, "explicit classroom controls remain available for maintenance");
            typeof(ClassroomIslandService).GetField("_manualShowUntil", Private)!.SetValue(service, 0L);
            await At(1201); Assert(!window.IsVisible, "automatic classroom hiding resumes after the manual opening expires");
            await At(1290); Assert(window.IsVisible, "the native island restores after the last custom lesson");
            profile.Lessons.Clear();
            profile.Visibility.HiddenSlotIds = ["day", "e1"];
            await At(474); Assert(window.IsVisible && !service.InClass, "an unfilled timetable is idle before selected class time");
            await At(475); Assert(!window.IsVisible && service.InClass, "a classroom with no courses hides and pauses update downloads at class start");
            await At(520); Assert(window.IsVisible && !service.InClass, "an unfilled timetable returns and allows idle downloads at the break");
            await At(1100); Assert(!window.IsVisible, "first evening quiet time works without a course entry");
            await At(1190); Assert(window.IsVisible, "the empty evening timetable restores at the exact end");
            var content = (Control)window.Content!;
            using var screenshot = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(content.Bounds.Width),
                (int)Math.Ceiling(content.Bounds.Height)), new Vector(96, 96));
            screenshot.Render(content); screenshot.Save(Path.Combine(output, "native-after-class.png"));
            Console.WriteLine($"{passed.Count} native classroom visibility checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            File.WriteAllLines(Path.Combine(output, "native-visibility-checks.txt"), passed);
            ReadingOfflineService.Stop(); service.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

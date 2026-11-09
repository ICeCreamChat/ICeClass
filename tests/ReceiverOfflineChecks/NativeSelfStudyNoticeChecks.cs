using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

// Real presentation and state callbacks, with synthetic events and a unique
// loopback cache. No monitor binding, microphone, camera or AI connection.
internal static class NativeSelfStudyNoticeChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, Private)!.GetValue(owner)!;
    private static void Set(object owner, string name, object? value) => owner.GetType().GetField(name, Private)!.SetValue(owner, value);
    private static void Invoke(object owner, string name, params object[] args) => owner.GetType().GetMethod(name, Private)!.Invoke(owner, args);
    private static IClassicDesktopStyleApplicationLifetime Desktop => (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;

    internal static void Run(string output, bool preview = false) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => { if (preview) Preview(Path.GetFullPath(output)); else _ = Check(Path.GetFullPath(output)); }))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private sealed class Fixture : IDisposable
    {
        internal readonly ClassroomIslandService Service = new(_ => Task.CompletedTask, () => { });
        internal readonly SelfStudyMonitor Monitor = new(_ => Task.FromResult(false), () => false, () => { });
        internal readonly ClassroomIslandWindow Window;
        internal readonly IslandAppearance Appearance = new() { Width = 760, OffsetY = 140, HideFullscreen = false, Theme = "light", Opacity = 35 };
        internal readonly IslandProfile Profile;
        internal readonly ReceiverConfig Binding;
        internal Fixture()
        {
            var scope = "self-study-notice-" + Guid.NewGuid().ToString("N");
            Binding = new() { Endpoint = "http://127.0.0.1:1", ClassId = scope, DeviceId = scope, DeviceToken = "local-check", ClassName = "晚自习浮岛验收" };
            Profile = new() { Slots = [new() { Id = "e2", Label = "晚自习第二节", Start = 1200, End = 1290 }],
                Lessons = [new() { SlotId = "e2", Weekday = 1, Subject = "自主学习" }], Reminders = new() { Enabled = false },
                Visibility = new() { FollowSchool = false, HiddenSlotIds = ["e2"] }, Appearance = Appearance };
            new IslandLocalStore(IslandLocalStore.RootFor(Binding)).Write("profile.json", new { classId = scope, revision = 1, config = Profile });
            Service.SetBinding(Binding);
            Field<DispatcherTimer>(Service, "_timer").Stop();
            var sync = Field<IslandSyncService>(Service, "_islandSync"); sync.Dispose(); Profile = sync.Snapshot.Profile!;
            var offline = Field<ReadingOfflineService>(Service, "_offline"); offline.Dispose();
            var now = new DateTimeOffset(2026, 11, 9, 20, 5, 0, TimeSpan.FromHours(8));
            lock (Field<object>(offline, "_gate"))
            { Set(offline, "_anchor", now.ToUnixTimeMilliseconds()); Set(offline, "_anchoredAt", Stopwatch.GetTimestamp()); }
            var local = Field<IslandLocalSettings>(Service, "_local"); local.Appearance = Appearance; local.AnimationsEnabled = false;
            Set(Service, "_store", null); // Never write shared preferences during a synthetic check.
            Set(Service, "_preferences", new ClassroomIslandPreferences(false, true));
            Window = Field<ClassroomIslandWindow>(Service, "_window"); Window.ShowInTaskbar = true;
            Monitor.StateChanged += Service.ShowSelfStudyStatus;
            Refresh();
        }
        internal void Refresh() { Invoke(Service, "Refresh"); Window.UpdateLayout(); }
        internal void Reset()
        {
            Set(Service, "_pendingSelfStudyStatus", null); Service.Clear();
            Field<ClassroomIslandState>(Service, "_state").DismissNotice(); Refresh();
        }
        internal void Status(string state, string detail)
        {
            // Enter the real transition handler without starting physical monitoring.
            Set(Monitor, "_state", state == "observing" ? "warning" : "observing"); Set(Monitor, "_detail", "");
            Invoke(Monitor, "SetState", state, detail); Window.UpdateLayout();
        }
        internal void Expire()
        { Set(Field<ClassroomIslandState>(Service, "_state"), "_noticeDuration", TimeSpan.Zero); Refresh(); }
        internal void Screenshot(string output, string name)
        {
            Directory.CreateDirectory(output); Window.UpdateLayout(); var root = (Control)Window.Content!;
            using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width), (int)Math.Ceiling(root.Bounds.Height)), new Vector(96, 96));
            bitmap.Render(root); bitmap.Save(Path.Combine(output, name + ".png"));
        }
        public void Dispose() { Monitor.Dispose(); Service.Dispose(); ReadingOfflineService.Stop(); }
    }

    private static readonly (string State, string Detail)[] States = [
        ("reported", "持续疑似闲聊已通知班主任，等待核实"), ("paused", "本节已暂停，下次晚自习自动恢复"),
        ("budget", "今日 AI 复核预算不足，已暂停"), ("error", "麦克风或本地语音资源不可用，请检查教室设置"),
        ("inactive", "正在使用语音或早读，晚自习监测暂歇"), ("observing", "已恢复安静，继续观察")];
    private static ShoutData TeacherNotice() => new() { SenderName = "本机验收", Text = "这是合成的老师紧急喊话，请先阅读此消息。",
        AlertLevel = "urgent", DisplayDurationSec = 30, IsPreview = true };

    private static async Task Check(string output)
    {
        var checks = new List<string>();
        void Assert(bool condition, string message)
        { if (!condition) throw new InvalidOperationException(message); checks.Add(message); Console.WriteLine("PASS " + message); }
        try
        {
            using var fixture = new Fixture(); var service = fixture.Service; var window = fixture.Window;
            Assert(!window.IsVisible, "saved hiding and lesson hiding apply before any self-study notice");
            Assert(await service.ShowSelfStudyWarningAsync(default), "first warning receives an actual visible-frame receipt");
            Assert(window.IsVisible && service.HomeState?.Notice is { Sender: "晚自习提醒", Category: "晚自习通知" }, "first warning appears on the real island despite daily hiding");
            Assert(Field<Border>(window, "_surface").Opacity == 1, "local notice stays readable even with 35% opacity and dimmed preferences");
            Assert(AutomationProperties.GetName(Field<Button>(window, "_expand"))?.Contains("交谈声") == true, "warning text is available in the accessible island name");
            var foreground = GetForegroundWindow();
            var obstruction = new Window { Width = window.Width, Height = window.Bounds.Height, Position = window.Position,
                WindowStartupLocation = WindowStartupLocation.Manual, Topmost = true, ShowActivated = false,
                ShowInTaskbar = false, SystemDecorations = SystemDecorations.None, Background = Brushes.Cyan };
            try
            {
                obstruction.Show();
                await Task.Delay(80);
                SetWindowPos(obstruction.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
                fixture.Refresh();
                var ordered = false;
                for (var handle = window.TryGetPlatformHandle()!.Handle; handle != IntPtr.Zero; handle = GetWindow(handle, 2))
                    if (handle == obstruction.TryGetPlatformHandle()!.Handle) { ordered = true; break; }
                var foregroundAfter = GetForegroundWindow();
                Assert(ordered && foregroundAfter == foreground,
                    $"self-study notices reassert above other topmost windows without stealing keyboard focus (ordered={ordered}, foregroundUnchanged={foregroundAfter == foreground})");
            }
            finally { obstruction.Close(); }
            fixture.Screenshot(output, "first-warning");
            var warning = service.HomeState!.Notice!.Sequence;
            fixture.Status("reported", States[0].Detail);
            Assert(service.HomeState?.Notice?.Sequence == warning, "status updates preserve the first reminder until its display ends");
            service.CancelSelfStudyWarning();
            Assert(service.HomeState?.Notice?.Sender == "已通知班主任", "pending report status appears when the reminder ends");
            service.CancelSelfStudyWarning();
            Assert(service.HomeState?.Notice?.Sender == "已通知班主任" && window.IsVisible, "cancelling an old warning does not erase later status notices");
            fixture.Expire();
            Assert(!window.IsVisible, "notice expiry restores saved classroom hiding");
            var preferences = Field<ClassroomIslandPreferences>(service, "_preferences");
            Assert(!preferences.Enabled && preferences.Dimmed && fixture.Appearance.Opacity == 35, "temporary notice visibility never rewrites saved appearance preferences");
            foreach (var theme in new[] { "light", "dark" })
            foreach (var width in new[] { 380, 760, 1000 })
            foreach (var (state, detail) in States)
            {
                fixture.Reset(); fixture.Appearance.Theme = theme; fixture.Appearance.Width = width;
                fixture.Status(state, detail); await Task.Delay(80); window.UpdateLayout();
                Assert(window.IsVisible && service.HomeState?.Notice is { Category: "晚自习通知" } notice && notice.Text == detail,
                    $"{theme}/{width}/{state}: monitor callback reaches the floating island");
                Assert(Field<Border>(window, "_surface").Opacity == 1 && window.Bounds.Width <= width + 1,
                    $"{theme}/{width}/{state}: notice remains readable within the configured width");
                Assert(AutomationProperties.GetName(Field<Button>(window, "_expand"))?.Contains(detail) == true,
                    $"{theme}/{width}/{state}: full notice text remains accessible");
                fixture.Screenshot(output, $"{theme}-{width}-{state}-cue");
                Set(Field<ClassroomIslandState>(service, "_state"), "_receivedAt", Stopwatch.GetTimestamp() - 4 * Stopwatch.Frequency);
                fixture.Refresh();
                Assert(Field<ClassroomIslandRibbon>(window, "_ribbon").Frame?.Text == detail,
                    $"{theme}/{width}/{state}: reminder cue advances to the complete status text");
                fixture.Screenshot(output, $"{theme}-{width}-{state}-message");
            }
            fixture.Reset();
            service.UpdateSelfStudyFeedback(new("listening", "正在感知教室声音", true)); fixture.Refresh();
            Assert(await service.ShowSelfStudyWarningAsync(default), "persistent feedback warning receives a real rendered-frame receipt");
            var ribbon = Field<ClassroomIslandRibbon>(window, "_ribbon");
            Assert(ribbon.Frame?.SelfStudy is { Reminder: true }, "persistent feedback displays the reminder inside the current course");
            service.UpdateSelfStudyFeedback(new("reported", "已通知班主任", true));
            Assert(ribbon.Frame?.SelfStudy is { Reminder: true }, "a phase update cannot erase an active first reminder");
            fixture.Expire();
            Assert(ribbon.Frame?.SelfStudy is { Reminder: false, State: "reported" }, "expired reminder restores the latest persistent phase");
            await service.QueueAsync(TeacherNotice(), _ => { }, () => { });
            Assert(ribbon.Frame?.Shout is not null, "teacher shout takes priority over persistent feedback");
            service.CancelPreviewShouts(); fixture.Refresh();
            Assert(ribbon.Frame is { Shout: null, SelfStudy.State: "reported" }, "closing a teacher shout restores the current self-study phase");
            service.UpdateSelfStudyFeedback(null); fixture.Reset(); fixture.Status("paused", States[1].Detail);
            window.SetExpanded(true); await Task.Delay(120);
            var expand = Field<Button>(window, "_expand"); window.Activate();
            Assert(expand.Focus(), "notice controls can receive keyboard focus");
            window.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
            Assert(!window.IsExpanded, "Escape closes expanded details during a local notice");
            fixture.Reset();
            var closed = 0;
            await service.QueueAsync(TeacherNotice(), _ => closed++, () => { });
            fixture.Status("reported", "较早的上报状态"); fixture.Status("paused", States[1].Detail);
            Assert(service.HomeState?.Notice is { Category: "班级通知", Level: "urgent" }, "self-study statuses never replace an active urgent teacher shout");
            Assert(!await service.ShowSelfStudyWarningAsync(default), "busy teacher shout does not produce a false first-warning receipt");
            service.CancelPreviewShouts();
            Assert(closed == 1 && service.HomeState?.Notice?.Text == States[1].Detail, "after teacher shout closes only the latest waiting status appears");
            fixture.Reset();
            var pendingReceipt = service.ShowSelfStudyWarningAsync(default);
            var teacherReceipt = service.QueueAsync(TeacherNotice(), _ => { }, () => { });
            Assert(!await pendingReceipt, "a warning replaced before its rendered frame is not counted as shown");
            await teacherReceipt; service.CancelPreviewShouts(); fixture.Reset();
            using (var cancelled = new CancellationTokenSource())
            {
                cancelled.Cancel();
                try { await service.ShowSelfStudyWarningAsync(cancelled.Token); throw new InvalidOperationException("cancelled warning was shown"); }
                catch (OperationCanceledException) { Assert(service.HomeState?.Notice is null, "cancelled warning does not create an island notification"); }
            }
            await service.QueueAsync(TeacherNotice(), _ => { }, () => { }); fixture.Status("reported", "旧班级状态");
            service.SetBinding(new ReceiverConfig { Endpoint = fixture.Binding.Endpoint, DeviceId = fixture.Binding.DeviceId, ClassId = "new-" + fixture.Binding.ClassId, DeviceToken = "local-check" });
            Assert(service.HomeState?.Notice is null && Field<object?>(service, "_pendingSelfStudyStatus") is null,
                "changing classroom binding clears both visible and waiting self-study notices");
            Console.WriteLine($"{checks.Count} native self-study island checks passed. {output}");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { Directory.CreateDirectory(output); File.WriteAllLines(Path.Combine(output, "checks.txt"), checks); Desktop.Shutdown(Environment.ExitCode); }
    }

    private static void Preview(string output)
    {
        var fixture = new Fixture(); var service = fixture.Service; var island = fixture.Window;
        fixture.Appearance.Opacity = 100; fixture.Appearance.Width = 760;
        fixture.Profile.Visibility!.HiddenSlotIds.Clear();
        Field<IslandLocalSettings>(service, "_local").AnimationsEnabled = true;
        Set(service, "_preferences", new ClassroomIslandPreferences());
        var screen = island.Screens.Primary!; var work = screen.WorkingArea; var scale = screen.Scaling;
        var wallpaper = new Window { Title = "液态玻璃对照背景 · 本机验收", Width = Math.Min(1100, work.Width / scale - 20), Height = 360,
            Content = new NativeIslandLayoutReview.SampleWallpaper(), CanResize = false, Topmost = true, ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual,
            Position = new PixelPoint(work.X + (int)((work.Width - Math.Min(1100 * scale, work.Width - 20 * scale)) / 2), work.Y + (int)(90 * scale)) };
        var result = new TextBlock { Text = "合成演示，不录音、不拍照、不向老师上报。", TextWrapping = TextWrapping.Wrap };
        var buttons = new WrapPanel { Orientation = Orientation.Horizontal };
        void Button(string text, Func<Task> action)
        {
            var button = new Button { Content = text, Margin = new Thickness(4), Padding = new Thickness(12, 8) };
            button.Click += async (_, _) => { button.IsEnabled = false; try { await action(); } catch (Exception error) { result.Text = error.Message; } finally { button.IsEnabled = true; } };
            buttons.Children.Add(button);
        }
        Button("安静提醒", async () => { fixture.Reset(); result.Text = await service.ShowSelfStudyWarningAsync(default) ? "浮岛已实际展示提醒。" : "未取得展示回执。"; });
        foreach (var (state, detail) in States)
        {
            var label = state switch { "reported" => "已通知老师", "paused" => "暂停", "budget" => "预算不足", "error" => "设备故障", "inactive" => "暂歇", _ => "恢复安静" };
            Button(label, () => { fixture.Reset(); fixture.Status(state, detail); result.Text = "合成状态：" + detail; return Task.CompletedTask; });
        }
        Button("老师紧急喊话", async () => { fixture.Reset(); await service.QueueAsync(TeacherNotice(), _ => { }, () => { }); result.Text = "正在展示合成老师喊话，可再点“喊话期间暂停”。"; });
        Button("喊话期间暂停", () => { fixture.Status("paused", States[1].Detail); result.Text = "暂停状态等待喊话结束后显示。"; return Task.CompletedTask; });
        Button("恢复课表", () => { fixture.Reset(); result.Text = "已恢复课表。"; return Task.CompletedTask; });
        Button("浅色 / 深色", () => { fixture.Appearance.Theme = fixture.Appearance.Theme == "light" ? "dark" : "light"; fixture.Refresh(); return Task.CompletedTask; });
        Button("窄 / 标准 / 宽", () => { fixture.Appearance.Width = fixture.Appearance.Width == 380 ? 760 : fixture.Appearance.Width == 760 ? 1000 : 380; fixture.Refresh(); return Task.CompletedTask; });
        Button("玻璃 / 原底色", () => { fixture.Appearance.Material = fixture.Appearance.Material == "solid" ? "glass" : "solid"; fixture.Refresh(); return Task.CompletedTask; });
        Button("重新显示浮岛", () => { island.Hide(); fixture.Refresh(); result.Text = "已重开，可检查首次出现时的材质。"; return Task.CompletedTask; });
        Button("保存当前画面", () => { fixture.Screenshot(output, "manual-" + DateTime.Now.ToString("HHmmss")); result.Text = "画面已保存到本机验收目录。"; return Task.CompletedTask; });
        var controller = new Window { Title = "晚自习通知与液态玻璃 · 本机验收", Width = 760, Height = 350, CanResize = true, Topmost = true,
            Content = new StackPanel { Margin = new Thickness(18), Spacing = 12, Children = {
                new TextBlock { Text = "晚自习浮岛验收", FontSize = 24, FontWeight = FontWeight.Bold }, result, buttons } },
            WindowStartupLocation = WindowStartupLocation.Manual,
            Position = new PixelPoint(work.X + (int)((work.Width - 760 * scale) / 2), work.Y + Math.Min((int)(470 * scale), work.Height - (int)(365 * scale))) };
        controller.Closed += (_, _) => { fixture.Dispose(); wallpaper.Close(); Desktop.Shutdown(); };
        wallpaper.Show(); fixture.Refresh();
        // The topmost comparison wallpaper is created after the island. Keep
        // the timetable visible on first open, before any notice raises it.
        SetWindowPos(island.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        Field<DispatcherTimer>(service, "_timer").Start(); controller.Show(); controller.Activate();
    }

    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}

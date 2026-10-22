using System.Reflection;
using System.Diagnostics;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal sealed class IslandCheckHost : Application
{
    public override void Initialize()
    {
        var product = new App(); product.Initialize();
        foreach (var resource in product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = product.Styles.ToArray(); product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
}

internal static class NativeIslandChecks
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    public static void Run(string bindingPath)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("Native checks require an explicit localhost review binding.");
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont().AfterSetup(builder =>
            Dispatcher.UIThread.Post(() => _ = Check(binding))).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }
    private static async Task Check(ReceiverConfig binding)
    {
        var output = Path.GetFullPath("output/island-full-20261019"); Directory.CreateDirectory(output);
        var checks = new List<string>();
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks.Add(label); Console.WriteLine("PASS " + label); }
        using var service = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        var localField = typeof(ClassroomIslandService).GetField("_local", Private)!;
        var window = (ClassroomIslandWindow)typeof(ClassroomIslandService).GetField("_window", Private)!.GetValue(service)!;
        window.ShowInTaskbar = true;
        void Refresh() => typeof(ClassroomIslandService).GetMethod("Refresh", Private)!.Invoke(service, null);
        void Screenshot(string name)
        {
            var root = (Control)window.Content!;
            using var image = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width), (int)Math.Ceiling(root.Bounds.Height)), new Vector(96, 96));
            image.Render(root); image.Save(Path.Combine(output, name + ".png"));
        }
        try
        {
            service.SetBinding(binding);
            service.SetConnection(new(true, "已连接本地验收平台"));
            var sync = (IslandSyncService)typeof(ClassroomIslandService).GetField("_islandSync", Private)!.GetValue(service)!;
            var until = DateTime.UtcNow.AddSeconds(25);
            while (!sync.Snapshot.Online && DateTime.UtcNow < until) await Task.Delay(200);
            Assert(sync.Snapshot is { Online: true, Profile.Slots.Count: > 0 }, "native client obtains the real class timetable from the authenticated endpoint");
            var local = (IslandLocalSettings)localField.GetValue(service)!;
            local.Appearance = new() { Width = 640, HideFullscreen = false };
            service.ShowControls(); Refresh(); await Task.Delay(650);
            var component = (TextBlock)typeof(ClassroomIslandWindow).GetField("_component", Private)!.GetValue(window)!;
            Assert(component.IsVisible && !string.IsNullOrWhiteSpace(component.Text), "native details display the configured information components");
            Screenshot("expanded-dark");
            var lessonPanel = (Border)typeof(ClassroomIslandWindow).GetField("_lessonPanel", Private)!.GetValue(window)!;
            lessonPanel.IsVisible = true; await Task.Delay(650);
            var lessons = (StackPanel)typeof(ClassroomIslandWindow).GetField("_lessonList", Private)!.GetValue(window)!;
            Assert(lessons.Children.Count > 1, "today's complete timetable expands inside the existing animated viewport");
            Screenshot("timetable-dark");
            local.Appearance.Width = 380; local.Appearance.Theme = "light"; Refresh(); await Task.Delay(650);
            Assert(window.Width <= 380 && window.Classes.Contains("island-light"), "local width and light appearance apply to the native island");
            var root = (Control)window.Content!;
            var overflow = root.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible).Where(b =>
            { var point = b.TranslatePoint(default, root)!.Value; return point.X < -1 || point.X + b.Bounds.Width > root.Bounds.Width + 1; }).ToArray();
            Assert(overflow.Length == 0, "all island actions fit at 380 DIP without horizontal overflow");
            Screenshot("timetable-light-380");
            lessonPanel.IsVisible = false; window.SetExpanded(false); await Task.Delay(650);
            Assert(window.ClientSize.Height <= 60, "timetable and component support preserve the compact native header height");
            Screenshot("compact-light-380");
            // Advance only this test process's reading clock to a real timetable boundary.
            // The OS clock, remote profile and classroom records are unchanged.
            var profile = sync.Snapshot.Profile!;
            profile.Reminders.Enabled = false; profile.Reminders.DisplaySeconds = 3;
            var ruleId = Guid.NewGuid().ToString();
            var ruleName = "集成课表提醒 · " + ruleId[..6];
            var day = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).DateTime);
            var target = Enumerable.Range(0, 8).SelectMany(i => IslandSchedule.On(profile, day.AddDays(i))).First();
            profile.Automation.Add(new() { Id = ruleId, Name = ruleName, Trigger = "start", Action = "reminder", Value = $"下一节是{target.Lesson.Subject}，请准备好课本和文具。", Weekdays = [1,2,3,4,5,6,7] });
            var at = target.At(target.Slot.Start);
            var offline = (ReadingOfflineService)typeof(ClassroomIslandService).GetField("_offline", Private)!.GetValue(service)!;
            var gate = typeof(ReadingOfflineService).GetField("_gate", Private)!.GetValue(offline)!;
            lock (gate)
            {
                typeof(ReadingOfflineService).GetField("_anchor", Private)!.SetValue(offline, at.ToUnixTimeMilliseconds());
                typeof(ReadingOfflineService).GetField("_anchoredAt", Private)!.SetValue(offline, Stopwatch.GetTimestamp());
            }
            typeof(ClassroomIslandService).GetField("_lastTick", Private)!.SetValue(service, at.AddSeconds(-1));
            Refresh(); await Task.Delay(650);
            Assert(!window.IsExpanded && window.ClientSize.Height <= 60 && local.RecentActions.Any(s => s.Contains(ruleName)), "a timetable event executes its automation inside the compact native ribbon"); Screenshot("reminder-light-380");
            Refresh(); Refresh(); await Task.Delay(50);
            Assert(local.RecentActions.Count(s => s.Contains(ruleName)) == 1, "repeated native refreshes cannot execute the same timetable action twice");
            await Task.Delay(4000);
            Assert(!window.IsExpanded, "reminder expiry automatically retracts the native island");
            local.Appearance.ClickThrough = true; Refresh();
            service.ShowControls(); await Task.Delay(650);
            Assert(window.IsVisible && window.IsExpanded, "the classroom entry restores controls while mouse click-through is enabled");
            local.Appearance.ClickThrough = false;
            typeof(ClassroomIslandService).GetMethod("ShowSettings", Private)!.Invoke(service, null);
            await Task.Delay(300);
            var settings = (IslandSettingsWindow)typeof(ClassroomIslandService).GetField("_settingsWindow", Private)!.GetValue(service)!;
            Assert(settings.IsVisible && settings.GetVisualDescendants().OfType<Button>().Any(b => b.Content?.ToString() == "选择并允许应用…"), "native settings expose working appearance controls and the application picker");
            var widths = settings.GetVisualDescendants().OfType<NumericUpDown>().ToArray(); widths[0].Value = 420;
            settings.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == "保存本机设置").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            var applied = (IslandLocalSettings)localField.GetValue(service)!;
            Assert(applied.Appearance?.Width == 420 && sync.Store.Read<IslandLocalSettings>("local-settings.json")?.Appearance?.Width == 420,
                "saving native appearance updates the live island and durable local preferences");
            Console.WriteLine($"{checks.Count} native profile checks passed. {output}");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            File.WriteAllLines(Path.Combine(output, "native-checks.txt"), checks);
            ReadingOfflineService.Stop(); service.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

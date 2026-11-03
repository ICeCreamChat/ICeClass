using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class IslandMotionNativeChecks
{
    internal static async Task RunAsync(string output, Action<bool, string> check)
    {
        // Old installs have no animation setting. Exercise the same JSON round-trip
        // used by the local store without touching the installed client's data.
        var saved = JsonSerializer.Deserialize<IslandLocalSettings>(
            "{\"AllowedApplications\":[],\"RecentActions\":[]}", IslandProfile.Json)!;
        var store = new IslandLocalStore(Path.Combine(output, "isolated-store"));
        IslandLocalSettings? applied = null;
        var settings = new IslandSettingsWindow(saved, new(), local => applied = local, () => { });
        try
        {
            settings.Show();
            await Task.Delay(150);
            var motion = settings.GetVisualDescendants().OfType<CheckBox>()
                .SingleOrDefault(control => control.Content as string == "播放浮岛动画");
            check(motion is not null, "The existing island settings expose a manual animation control");
            check(motion!.IsChecked == true && motion.IsEffectivelyEnabled,
                "An existing install defaults to animation without enabling independent appearance");
            foreach (var width in new[] { 760, 440 })
            {
                settings.Width = width;
                await Task.Delay(150);
                motion.BringIntoView(); motion.Focus();
                await Task.Delay(100);
                var point = motion.TranslatePoint(default, settings);
                var saveTop = settings.GetVisualDescendants().OfType<Button>()
                    .Single(button => button.Content as string == "保存本机设置").TranslatePoint(default, settings)!.Value.Y;
                check(point.HasValue && point.Value.X >= 0 && point.Value.Y >= 0
                    && point.Value.X + motion.Bounds.Width <= settings.ClientSize.Width + 1
                    && point.Value.Y + motion.Bounds.Height < saveTop
                    && motion.Bounds.Width >= motion.DesiredSize.Width - 1,
                    $"The motion control fits the {width} DIP settings window");
                check(motion.IsFocused && AutomationProperties.GetName(motion) == "播放浮岛动画",
                    $"The motion control is keyboard reachable and named at {width} DIP");
                Capture(settings, output, $"settings-{width}");
            }
            motion.IsChecked = false;
            ClickSave(settings);
            check(applied is not null && !JsonSerializer.SerializeToElement(applied, IslandProfile.Json)
                .GetProperty("animationsEnabled").GetBoolean(), "Saving records the user's explicit motion opt-out");
            store.Write("local-settings.json", applied);
        }
        finally { settings.Close(); }

        var restored = new IslandLocalStore(Path.Combine(output, "isolated-store"))
            .Read<IslandLocalSettings>("local-settings.json")!;
        var reopened = new IslandSettingsWindow(restored, new(), local => applied = local, () => { });
        try
        {
            reopened.Show();
            await Task.Delay(150);
            var motion = reopened.GetVisualDescendants().OfType<CheckBox>()
                .Single(control => control.Content as string == "播放浮岛动画");
            check(motion.IsChecked == false, "Reopening settings preserves the saved motion opt-out");
            motion.IsChecked = true;
            ClickSave(reopened);
            check(JsonSerializer.SerializeToElement(applied, IslandProfile.Json)
                .GetProperty("animationsEnabled").GetBoolean(), "The same control can enable animation again");
        }
        finally { reopened.Close(); }
        await CheckPlayback(output, restored, check);
    }

    private static async Task CheckPlayback(string output, IslandLocalSettings restored, Action<bool, string> check)
    {
        var messages = new List<string>();
        var window = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => { }, null,
            diagnostic: messages.Add);
        var normal = new ClassroomIslandView("本机隔离验收", "10:00", "11月03日", "课间", "早读", "", true, true, "已连接", null);
        var appearance = new IslandAppearance { Width = 560, Theme = "light", HideFullscreen = false };
        var notice = new ClassroomIslandNotice("本机检查", "通知动画默认开启", "warning", Sequence: 1, DurationSeconds: 12);
        try
        {
            window.Update(normal, false);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            window.Show();
            window.Update(normal with { Notice = notice }, false);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            var mascot = window.GetVisualDescendants().OfType<IslandBanbanMascot>().Single();
            var ribbon = window.GetVisualDescendants().OfType<ClassroomIslandRibbon>().Single();
            var companion = window.GetVisualDescendants().OfType<IslandShoutCompanion>().Single();
            var elapsed = Stopwatch.StartNew();
            var intermediate = false;
            while (elapsed.Elapsed.TotalSeconds < 2.6)
            {
                intermediate |= companion.Expansion is > 8 and < 100;
                await Task.Delay(20);
            }
            check(mascot.Animate && ribbon.Animate && mascot.AnimationFrames >= 6,
                "A fresh classroom window plays both animations by default");
            check(intermediate && companion.Expansion > 127,
                "The default important notification gradually pulls the actual window wider");
            check(messages.Any(message => message.Contains("islandAnimations=True")),
                "Notification diagnostics distinguish the app setting from the Windows preference");
            Capture(window, output, "notification-enabled");

            window.Update(normal with { Notice = notice }, false, restored.AnimationsEnabled);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            await Task.Delay(200);
            var stopped = mascot.AnimationFrames;
            await Task.Delay(250);
            check(!mascot.Animate && !ribbon.Animate && stopped == mascot.AnimationFrames && companion.Expansion == 128,
                "The saved opt-out stops both animations on the current notification without restarting");

            notice = notice with { Sequence = 2, Level = "urgent" };
            window.Update(normal with { Notice = notice }, false, restored.AnimationsEnabled);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            await Task.Delay(250);
            check(mascot.AnimationFrames == 0 && mascot.IsVisible && companion.Expansion == 128 && window.HasShout,
                "An opted-out urgent notification remains visible at its final size without starting animation");
            Capture(window, output, "notification-disabled");

            window.Update(normal with { Notice = notice }, false, true);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            await Task.Delay(250);
            check(mascot.Animate && ribbon.Animate && mascot.AnimationFrames >= 3,
                "Re-enabling motion resumes the current notification without restarting the app");
            window.Update(normal, false);
            window.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "已连接");
            await Task.Delay(200);
            stopped = mascot.AnimationFrames;
            await Task.Delay(250);
            check(stopped == mascot.AnimationFrames, "Closing the notification stops the mascot callback loop");
        }
        finally { window.DisposeWindow(); }
    }

    internal static void Preview()
    {
        var local = new IslandLocalSettings();
        var normal = new ClassroomIslandView("本机预览班级", "10:00", "11月03日", "课间", "早读", "", true, true, "本机预览", null);
        var appearance = new IslandAppearance { Width = 560, Theme = "light", HideFullscreen = false };
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        ClassroomIslandNotice? notice = null;
        var started = Stopwatch.StartNew();
        long sequence = 0;
        IslandSettingsWindow? settings = null;
        ClassroomIslandWindow? island = null;
        var host = new Window { Title = "教室端 · 浮岛动画本机验收", Width = 660, Height = 220 };
        void Render()
        {
            var current = notice is not null && started.Elapsed.TotalSeconds < 12
                ? notice with { AgeSeconds = started.Elapsed.TotalSeconds } : null;
            island!.Update(normal with { Notice = current }, false, local.AnimationsEnabled);
            island.ApplyProfile(appearance, null, DateTimeOffset.Now, "", "本机预览");
            if (!island.IsVisible) island.Show();
        }
        void Settings()
        {
            if (settings is not null) { settings.Activate(); return; }
            settings = new IslandSettingsWindow(local, appearance, saved => { local = saved; Render(); }, () => { });
            settings.Title = "教室浮岛设置 · 本机验收";
            settings.Closed += (_, _) => settings = null;
            settings.Show(host);
            Dispatcher.UIThread.Post(() => settings?.GetVisualDescendants().OfType<CheckBox>()
                .Single(control => control.Content as string == "播放浮岛动画").BringIntoView(), DispatcherPriority.Loaded);
        }
        island = new ClassroomIslandWindow(() => Task.CompletedTask, () => host.Activate(), () => { }, () => { },
            () => { notice = null; Render(); }, Settings);
        var actions = new WrapPanel { Orientation = Orientation.Horizontal };
        foreach (var (level, label) in new[] { ("info", "普通通知"), ("warning", "重要通知"), ("urgent", "紧急通知") })
        {
            var button = ClassroomStyle.Button(label); button.Margin = new Thickness(0, 0, 10, 10);
            button.Click += (_, _) => { notice = new("本机预览", "保持安静，请查看通知", level, Sequence: ++sequence); started.Restart(); Render(); };
            actions.Children.Add(button);
        }
        var open = ClassroomStyle.Button("浮岛设置"); open.Click += (_, _) => Settings(); actions.Children.Add(open);
        host.Content = new StackPanel { Margin = new Thickness(24), Spacing = 12, Children = {
            ClassroomStyle.Text("浮岛动画已默认开启", 20, true),
            ClassroomStyle.Caption("本机隔离预览，可切换三类通知并保存动画开关。"), actions } };
        ClassroomStyle.Apply(host);
        timer.Tick += (_, _) => Render();
        host.Opened += (_, _) => { notice = new("本机预览", "保持安静，请查看通知", "warning", Sequence: ++sequence); started.Restart(); Render(); timer.Start(); Settings(); };
        host.Closed += (_, _) =>
        {
            timer.Stop(); settings?.Close(); island.DisposeWindow();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        };
        host.Show();
    }

    private static void Capture(Window window, string output, string name)
    {
        Directory.CreateDirectory(output);
        using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(window.ClientSize.Width),
            (int)Math.Ceiling(window.ClientSize.Height)), new Vector(96, 96));
        bitmap.Render(window); bitmap.Save(Path.Combine(output, name + ".png"));
    }

    private static void ClickSave(Window window) => window.GetVisualDescendants().OfType<Button>()
        .Single(button => button.Content as string == "保存本机设置")
        .RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
}

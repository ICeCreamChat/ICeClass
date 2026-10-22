using System.Net;
using System.Net.Sockets;
using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeShoutChecks
{
    public static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check()
    {
        const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Instance;
        var output = Path.GetFullPath(Environment.GetEnvironmentVariable("ICECLASS_SHOUT_CHECK_OUTPUT") ?? "output/island-megaphone-grip-20261021"); Directory.CreateDirectory(output);
        var checks = new List<string>();
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks.Add(label); Console.WriteLine("PASS " + label); }
        object Field(object target, string name) => target.GetType().GetField(name, flags)!.GetValue(target)!;
        void Capture(Window window, string name)
        {
            using var image = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(window.Bounds.Width), (int)Math.Ceiling(window.Bounds.Height)), new Vector(96, 96));
            image.Render(window); image.Save(Path.Combine(output, name + ".png"));
        }
        using var speech = new SpeechService();
        using var island = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        var receiver = new CloudReceiverService(speech) { NotificationPresenter = island };
        Window? restoration = null;
        try
        {
            var displayed = 0; receiver.NotificationDisplayed += (_, _) => displayed++;
            var window = (ClassroomIslandWindow)Field(island, "_window");
            var card = (IslandShoutCard)Field(window, "_shoutCard");
            var mascot = (IslandBanbanMascot)Field(window, "_mascot");
            var companion = (IslandShoutCompanion)Field(window, "_companion");
            var ribbon = (ClassroomIslandRibbon)Field(window, "_ribbon");
            async Task<Task?> Display(ShoutData data, ReceiverConfig? config = null) => await (Task<Task?>)typeof(CloudReceiverService)
                .GetMethod("DisplayAsync", flags)!.Invoke(receiver, [new ShoutPayload { Data = data }, config, CancellationToken.None])!;
            void Dismiss() => ((Button)Field(window, "_dismissShout")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));

            await receiver.ShowShoutPreviewAsync(); await Task.Delay(650);
            Assert(displayed == 1 && window.IsVisible && window.HasShout && !window.IsExpanded && !window.IsShoutExpanded,
                "the original receiver displays its shout in the thin island without opening a separate card");
            Assert(!((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Windows.OfType<AlertWindow>().Any(),
                "the configured island replaces the legacy alert window without a duplicate popup");
            var mascotPoint = mascot.TranslatePoint(default, window)!.Value;
            var ribbonPoint = ribbon.TranslatePoint(default, window)!.Value;
            Assert(mascot.AssetsLoaded && mascot.IsEffectivelyVisible && mascotPoint.X + mascot.Bounds.Width <= ribbonPoint.X + 5
                && mascotPoint.Y <= ribbonPoint.Y && mascotPoint.Y + mascot.Bounds.Height >= ribbonPoint.Y + ribbon.Bounds.Height,
                "the original layered Banban stands beside the island in the ribbon row");
            Capture(window, "cue");
            await Task.Delay(3400); Capture(window, "preview");
            Assert(ribbon.Bounds.Height == 48 && window.ClientSize.Height <= 72 && ribbon.Frame?.Shout is not null && !ribbon.Frame.Accent,
                "the message replaces the cue inside the same 48 DIP capsule with no extra mascot row");

            island.Clear();
            await Display(new() { SenderName = "王老师", Text = "请带好练习册。", AlertLevel = "warning", DisplayDurationSec = 30, TtsVolume = 0 });
            var startingWidth = window.Width; await Task.Delay(850); var middleWidth = window.Width;
            await Task.Delay(1550);
            Assert(!ClassroomIslandReveal.AnimationsEnabled() || window.Width > startingWidth + 96 && middleWidth > startingWidth + 8 && middleWidth < window.Width - 24,
                "the important island spreads visibly over Banban's pull, with a readable intermediate width before settling");
            Assert(!ribbon.ImportantExpanded && window.ClientSize.Height <= 72,
                "a short important message stays in the widened thin island; only long content opens two lines");
            Capture(window, "important-short"); var previousExpandedWidth = window.Width; island.Clear();
            await Display(new() { SenderName = "王老师", Text = "第三节是实验课，请带好课本和练习册，提前到实验室集合，按学号就座。", AlertLevel = "warning", DisplayDurationSec = 30, TtsVolume = 0 });
            var repeatedStartingWidth = window.Width;
            await Task.Delay(2500); Capture(window, "important");
            Assert(!ClassroomIslandReveal.AnimationsEnabled() || repeatedStartingWidth < previousExpandedWidth - 96 && window.Width > repeatedStartingWidth + 96,
                "replaying an important shout starts from the short island again and visibly pulls to its expanded width");
            Assert(((Control)Field(window, "_importantBody")).IsEffectivelyVisible && window.ClientSize.Height is > 120 and < 170,
                "important shouts reveal two lines inside the widened island without a separate card");
            companion.ReviewSeconds = 1.045; companion.InvalidateMeasure(); window.UpdateLayout();
            var pulled = ((Control)Field(window, "_surface")).Bounds;
            companion.ReviewSeconds = 2.25; companion.InvalidateMeasure(); window.UpdateLayout();
            var released = ((Control)Field(window, "_surface")).Bounds;
            Assert(pulled.X < released.X - 3 && pulled.Width > released.Width + 6
                && pulled.Right <= window.ClientSize.Width && pulled.X >= 0,
                "Banban's tug stretches both capsule ends gently within the window bounds");
            companion.ReviewSeconds = null;
            companion.SetActive(true, false);
            companion.ReviewSeconds = 1.045; companion.InvalidateMeasure(); window.UpdateLayout();
            var staticPull = ((Control)Field(window, "_surface")).Bounds;
            companion.ReviewSeconds = 2.25; companion.InvalidateMeasure(); window.UpdateLayout();
            Assert(staticPull == ((Control)Field(window, "_surface")).Bounds,
                "reduced motion also removes the capsule tug while retaining the side layout");
            companion.ReviewSeconds = null; companion.SetActive(true, true);

            byte[] MascotFrame(double seconds, string name)
            {
                mascot.ReviewSeconds = seconds;
                using var bitmap = new RenderTargetBitmap(new PixelSize((int)IslandShoutCompanion.SideWidth, (int)IslandShoutCompanion.MascotHeight), new Vector(96, 96));
                bitmap.Render(mascot); bitmap.Save(Path.Combine(output, name + ".png"));
                using var bytes = new MemoryStream(); bitmap.Save(bytes); return bytes.ToArray();
            }
            Assert(!MascotFrame(1.045, "mascot-pull").SequenceEqual(MascotFrame(2.35, "mascot-wave"))
                && !MascotFrame(2.35, "mascot-wave").SequenceEqual(MascotFrame(2.7, "mascot-blink")),
                "Banban pulls, waves and blinks by animating its original separate layers");
            Assert(!MascotFrame(.51, "important-run-left").SequenceEqual(MascotFrame(.67, "important-run-right")),
                "important pulling renders distinct alternating foot poses from the original painted legs");
            mascot.Animate = false;
            Assert(MascotFrame(.6, "mascot-reduced-a").SequenceEqual(MascotFrame(2.7, "mascot-reduced-b")),
                "reduced motion keeps Banban static instead of running its gestures");
            mascot.Animate = true; mascot.ReviewSeconds = null;

            island.SetEnabled(false);
            var local = (IslandLocalSettings)Field(island, "_local");
            foreach (var width in new[] { 380, 560 })
            {
                island.Clear();
                local.Appearance = new() { Width = width, Theme = "light", Opacity = 30, ClickThrough = true };
                var text = string.Concat(Enumerable.Repeat("请带好课本和练习册，按顺序到实验室集合。", 30))[..500];
                await Display(new() { SenderName = "王老师", Text = text, AlertLevel = "info", DisplayDurationSec = 8 });
                await Task.Delay(650);
                Assert(window.HasShout && window.IsVisible && !island.Enabled && ((Control)Field(window, "_surface")).Opacity == 1,
                    "a shout remains legible when the regular island is hidden, dimmed or configured for click-through at " + width);
                Assert(!window.IsShoutExpanded && window.ClientSize.Height <= 72 && ribbon.Frame?.Shout?.Text == text,
                    "long shouts stay in the thin capsule until the full text is requested at " + width);
                ((Button)Field(window, "_expand")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Task.Delay(650);
                var body = window.GetVisualDescendants().OfType<TextBlock>().Single(t => t.Text == text);
                var scroll = body.GetVisualAncestors().OfType<ScrollViewer>().First();
                Assert(body.Text?.Length == 500 && scroll.Extent.Height > scroll.Viewport.Height && window.ClientSize.Height < 500,
                    "all 500 characters remain scrollable inside the same expanded island at " + width);
                Assert(window.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible).All(b => {
                    var point = b.TranslatePoint(default, window)!.Value; return point.X >= -1 && point.X + b.Bounds.Width <= window.Bounds.Width + 1;
                }), "shout controls stay within the window at " + width);
                Capture(window, "long-" + width);
            }
            local.Appearance = new() { Width = 560, Theme = "light" };
            island.Clear();
            await Display(new() { SenderName = "班主任", Text = "请同学们回到座位，准备上课。", AlertLevel = "urgent", TtsVolume = 0, DisplayDurationSec = 5 });
            var urgentStartingWidth = window.Width;
            await Task.Delay(650);
            Assert(window.WindowState == WindowState.Normal && window.HasShout && window.Topmost && window.IsUrgent && window.ClientSize.Height < 170,
                "urgent shouts remain in the same compact red island with the side Banban");
            Assert(ribbon.Frame is { Accent: false, Shout.Level: "urgent" }, "urgent text appears directly without an introductory cue");
            Assert(ribbon.Frame?.Detail.Contains("紧急喊话") == true, "urgent shouts retain their explicit readable severity in the ribbon");
            Capture(window, "urgent-running");
            Assert(!MascotFrame(.51, "urgent-run-left").SequenceEqual(MascotFrame(.67, "urgent-run-right")),
                "urgent pulling has alternating running poses as well as the important shout");
            mascot.ReviewSeconds = null;
            await Task.Delay(1750);
            Assert(!ClassroomIslandReveal.AnimationsEnabled() || window.Width > urgentStartingWidth + 96,
                "urgent shouts pull the same short red island to its expanded width without delaying the message");
            Capture(window, "urgent");
            Assert(!MascotFrame(.65, "urgent-horn-carried").SequenceEqual(MascotFrame(2.5, "urgent-horn-raised")),
                "Banban carries the large megaphone while pulling, then raises it beside the message");
            mascot.Animate = false;
            Assert(MascotFrame(.5, "urgent-reduced-a").SequenceEqual(MascotFrame(3.1, "urgent-reduced-b")),
                "reduced motion preserves the raised megaphone while removing running and sound-line animation");
            mascot.Animate = true; mascot.ReviewSeconds = null;
            Dismiss(); await Task.Delay(60);
            Assert(!window.HasShout && !window.IsVisible && !island.Enabled, "dismissing a shout restores the previously hidden island preference");

            var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
            using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
            var request = listener.GetContextAsync();
            var audio = await Display(new() { SenderName = "李老师", Text = "语音通知", AlertLevel = "warning", ContentType = "audio",
                AudioUrl = "/api/shouts/local-check/audio", AudioDurationMs = 1000, DisplayDurationSec = 10 },
                new() { Endpoint = $"http://127.0.0.1:{port}", DeviceId = "native-shout-check", DeviceToken = "local-test-only" });
            var context = await request.WaitAsync(TimeSpan.FromSeconds(4));
            Assert(audio is not null && context.Request.Headers["Authorization"] == "Bearer local-test-only" && context.Request.QueryString["deviceId"] == "native-shout-check",
                "voice shouts keep the existing authenticated download and playback task");
            await Task.Delay(650); Capture(window, "voice"); Dismiss();
            var cancelled = false;
            try { await audio!.WaitAsync(TimeSpan.FromSeconds(3)); }
            catch (OperationCanceledException) { cancelled = true; }
            context.Response.Abort();
            Assert(cancelled, "the island acknowledgement button cancels active voice playback and download");

            void DismissOnDisplay(object? sender, ShoutData data) { if (data.SenderName == "关闭检查") Dismiss(); }
            receiver.NotificationDisplayed += DismissOnDisplay;
            try
            {
                var dismissedPlayback = await Display(new() { SenderName = "关闭检查", Text = "语音通知", AlertLevel = "warning", ContentType = "audio",
                    AudioUrl = "/api/shouts/dismissed-check/audio", AudioDurationMs = 1000, DisplayDurationSec = 10 },
                    new() { Endpoint = $"http://127.0.0.1:{port}", DeviceId = "native-shout-check", DeviceToken = "local-test-only" });
                Assert(dismissedPlayback is null && !window.HasShout,
                    "a shout dismissed as its first frame appears cannot start playing audio afterwards");
            }
            finally { receiver.NotificationDisplayed -= DismissOnDisplay; }

            var expired = new TaskCompletionSource<bool>();
            await island.PresentAsync(new() { SenderName = "本机检查", Text = "倒计时结束后收起", AlertLevel = "info", DisplayDurationSec = 5 },
                byUser => expired.TrySetResult(byUser));
            Assert(!await expired.Task.WaitAsync(TimeSpan.FromSeconds(7)) && !window.HasShout,
                "a shout expires at its original display deadline and closes automatically");

            var normal = IslandRibbonChecks.View(); var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
            ClassroomIslandWindow? restored = null;
            restored = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => {
                restored!.Update(normal, false); restored.ApplyProfile(new() { Width = 560, Theme = "light", HideFullscreen = false }, profile, IslandRibbonChecks.At(10, 38), "", "已连接");
            });
            restoration = restored;
            restored.Update(normal, false); restored.ApplyProfile(new() { Width = 560, Theme = "light", HideFullscreen = false }, profile, IslandRibbonChecks.At(10, 38), "", "已连接"); restored.Show();
            restored.Update(normal with { Notice = new("王老师", "同学们，请准备好课本和练习册。", "info", Sequence: 900, DurationSeconds: 10) }, false);
            restored.ApplyProfile(new() { Width = 560, Theme = "light", HideFullscreen = false }, profile, IslandRibbonChecks.At(10, 38), "", "已连接");
            await Task.Delay(650); Capture(restored, "with-timetable");
            ((IslandShoutCard)Field(restored, "_shoutCard")).DismissButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Task.Delay(650);
            Assert(!restored.HasShout && restored.ClientSize.Height <= 60 && ((ClassroomIslandRibbon)Field(restored, "_ribbon")).Frame!.Items.Count(i => i.Id != "break") == 11,
                "closing the animated shout restores the thin complete daily timetable");
            Capture(restored, "restored");
            Assert(Avalonia.Automation.AutomationProperties.GetName((Button)Field(restored, "_expand"))?.Contains("悬浮岛操作") == true,
                "the restored timetable has its normal accessible action label");

            // Deterministic native-render replay: this demonstrates the poses and
            // transition masks, and does not measure desktop frame performance.
            var replayMascot = (IslandBanbanMascot)Field(restored, "_mascot");
            var replayCompanion = (IslandShoutCompanion)Field(restored, "_companion");
            var replayRibbon = (ClassroomIslandRibbon)Field(restored, "_ribbon");
            var replayNotice = new ClassroomIslandNotice("王老师", "同学们，请准备好课本和练习册，回到座位后保持安静。", "info", Sequence: 901, DurationSeconds: 10);
            Directory.CreateDirectory(Path.Combine(output, "frames"));
            replayRibbon.ReviewPhase = 1;
            restored.Update(normal with { Notice = replayNotice }, false);
            restored.ApplyProfile(new() { Width = 560, Theme = "light", HideFullscreen = false }, profile, IslandRibbonChecks.At(10, 38), "", "已连接");
            replayCompanion.SetActive(true, false); replayCompanion.SetActive(true, true);
            for (var index = 0; index < 108; index++)
            {
                var seconds = index / 12.0;
                replayMascot.ReviewSeconds = seconds; replayCompanion.ReviewSeconds = seconds;
                restored.Update(normal with { Notice = replayNotice with { AgeSeconds = seconds } }, false);
                restored.ApplyProfile(new() { Width = 560, Theme = "light", HideFullscreen = false }, profile, IslandRibbonChecks.At(10, 38), "", "已连接");
                replayRibbon.ReviewPhase = seconds < IslandShoutText.CueSeconds ? 1 : Math.Clamp((seconds - IslandShoutText.CueSeconds) / .55, 0, 1);
                replayCompanion.InvalidateMeasure(); restored.UpdateLayout();
                Capture(restored, "frames/" + index.ToString("0000"));
            }
            restored.Update(normal, false);
            replayCompanion.SetActive(false, false); restored.UpdateLayout();
            Capture(restored, "replay-restored");
            restored.DisposeWindow(); restoration = null;
            island.Clear(); local.Appearance = new() { Width = 560, Theme = "light" };
            foreach (var (level, name, message) in new[] {
                ("warning", "important", "第三节是实验课，请带好课本和练习册，提前到实验室集合，按学号就座。"),
                ("urgent", "urgent", "请同学们回到座位，保持通道畅通，听从老师安排。") })
            {
                Directory.CreateDirectory(Path.Combine(output, name + "-frames"));
                await Display(new() { SenderName = "王老师", Text = message, AlertLevel = level, DisplayDurationSec = 30, TtsVolume = 0 });
                var frameTimes = new List<string>(); var motionStart = System.Diagnostics.Stopwatch.GetTimestamp();
                for (var frame = 0; frame < 62; frame++)
                {
                    frameTimes.Add(System.Diagnostics.Stopwatch.GetElapsedTime(motionStart).TotalMilliseconds.ToString("F0", System.Globalization.CultureInfo.InvariantCulture));
                    Capture(window, name + "-frames/" + frame.ToString("0000")); await Task.Delay(60);
                }
                File.WriteAllLines(Path.Combine(output, name + "-frame-times.txt"), frameTimes); island.Clear();
            }
            await NativeShoutQueueChecks.Run(island, receiver, window, Assert, Capture);
            Console.WriteLine(checks.Count + " native island shout checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            await receiver.StopAsync(); island.Dispose();
            if (restoration is ClassroomIslandWindow remaining) remaining.DisposeWindow();
            File.WriteAllLines(Path.Combine(output, "native-checks.txt"), checks);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeIslandAcceptanceChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    private static void Invoke(object target, string name) => target.GetType().GetMethod(name, Private)!.Invoke(target, null);

    public static void Run(string stage, string bindingPath, string output)
    {
        // Match the production [STAThread] entry point before creating WebView2.
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            var thread = new Thread(() => Run(stage, bindingPath, output));
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start(); thread.Join(); return;
        }
        if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("Acceptance checks require an explicit loopback-only binding.");
        Directory.CreateDirectory(output);
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(stage, binding, output)))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }

    private static async Task Until(Func<bool> predicate, string reason, int seconds = 25)
    {
        var clock = Stopwatch.StartNew();
        while (!predicate())
        {
            if (clock.Elapsed.TotalSeconds > seconds) throw new TimeoutException(reason);
            await Task.Delay(100);
        }
    }

    private static void Capture(Window window, string path)
    {
        var root = (Control)window.Content!;
        using var image = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width), (int)Math.Ceiling(root.Bounds.Height)), new Vector(96, 96));
        image.Render(root); image.Save(path);
    }

    private static ProcessStartInfo Child(string command, params string[] args)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
        if (Path.GetFileNameWithoutExtension(Environment.ProcessPath!).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(typeof(NativeIslandAcceptanceChecks).Assembly.Location);
        start.ArgumentList.Add(command);
        foreach (var arg in args) start.ArgumentList.Add(arg);
        return start;
    }

    private static async Task Check(string stage, ReceiverConfig binding, string output)
    {
        var passed = new List<string>();
        string? failure = null;
        void Assert(bool ok, string label)
        {
            if (!ok) throw new Exception(label);
            passed.Add(label); Console.WriteLine("PASS " + label);
        }
        using var island = new ClassroomIslandService(_ => Task.CompletedTask, () => { });
        using var speech = new SpeechService();
        var receiver = new CloudReceiverService(speech) { NotificationPresenter = island };
        var window = Field<ClassroomIslandWindow>(island, "_window");
        IslandSyncService Sync() => Field<IslandSyncService>(island, "_islandSync");
        Window? anchor = null;
        Process? probe = null;
        var probePath = Path.Combine(output, "fullscreen-probe");
        var connected = false;
        try
        {
            island.SetBinding(binding);
            Assert(IslandLocalStore.RootFor(binding).StartsWith(AppContext.BaseDirectory, StringComparison.OrdinalIgnoreCase)
                && ClassroomIslandPreferencesStore.PathFor(binding).StartsWith(AppContext.BaseDirectory, StringComparison.OrdinalIgnoreCase),
                "acceptance state is isolated beside the test assembly, outside installed classroom data");
            if (stage == "write")
            {
                await Until(() => Sync().Snapshot.Online, "initial timetable sync");
                island.ShowControls();
                Invoke(island, "ShowSettings");
                var settings = Field<IslandSettingsWindow>(island, "_settingsWindow");
                settings.GetVisualDescendants().OfType<CheckBox>().Single(c => c.Content?.ToString() == "本机使用独立外观").IsChecked = true;
                NumericUpDown Number(string name) => settings.GetVisualDescendants().OfType<NumericUpDown>().Single(c => AutomationProperties.GetName(c) == name);
                Number("悬浮岛宽度").Value = 640;
                Number("悬浮岛不透明度").Value = 84;
                Number("悬浮岛水平偏移").Value = 12;
                Number("悬浮岛垂直偏移").Value = 16;
                settings.GetVisualDescendants().OfType<ComboBox>().Single(c => AutomationProperties.GetName(c) == "悬浮岛主题").SelectedIndex = 0;
                await Task.Delay(450); Capture(settings, Path.Combine(output, "saved-settings.png"));
                settings.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == "保存本机设置").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                var saved = Sync().Store.Read<IslandLocalSettings>("local-settings.json");
                Assert(saved?.Appearance is { Width: 640, Opacity: 84, OffsetX: 12, OffsetY: 16, Theme: "dark" },
                    "the production settings form persists all edited appearance fields");
                Invoke(island, "ToggleDim"); island.SetEnabled(false);
                Assert(new ClassroomIslandPreferencesStore(ClassroomIslandPreferencesStore.PathFor(binding)).Load() is { Enabled: false, Dimmed: true },
                    "hide and dim preferences are saved before the first process exits");
            }
            else if (stage == "read")
            {
                var local = Field<IslandLocalSettings>(island, "_local");
                Assert(!island.Enabled && Field<ClassroomIslandPreferences>(island, "_preferences").Dimmed && !window.IsVisible,
                    "a fresh offline process restores the hidden and dimmed preferences");
                Assert(local.Appearance is { Width: 640, Opacity: 84, OffsetX: 12, OffsetY: 16, Theme: "dark" },
                    "a fresh process restores the saved width, opacity, position and theme without network access");
                Assert(Sync().Snapshot is { Online: false, Revision: 1, Profile.Slots.Count: 2, Profile.Lessons.Count: 14 },
                    "offline startup recovers the last authenticated full-week timetable");
                island.ShowControls(); await Task.Delay(650);
                Assert(window.IsVisible && window.IsExpanded && window.Width == 640 && !window.Classes.Contains("island-light") && window.Opacity == 1,
                    "restoring the island after offline restart retains appearance and makes expanded text fully opaque");
                Capture(window, Path.Combine(output, "offline-restart.png"));
            }
            else
            {
                anchor = new Window { Title = "ICeClass 本地全屏验收", Width = 420, Height = 200,
                    Content = new TextBlock { Text = "正在检查全屏课件与悬浮岛恢复", Margin = new Thickness(24) } };
                anchor.Show(); anchor.Activate();
                receiver.ConnectionStateChanged += (_, state) => Dispatcher.UIThread.Post(() => { connected = state.Connected; island.SetConnection(state); });
                receiver.BindingChanged += (_, config) => Dispatcher.UIThread.Post(() => island.SetBinding(config));
                await receiver.StartAsync(binding);
                await Until(() => connected && Sync().Snapshot.Online && window.IsVisible, "real backend connection");
                Assert(Sync().Snapshot.Revision == 1, "the production receiver and profile sync connect to the real isolated backend");
                using var http = new HttpClient { BaseAddress = new Uri(binding.Endpoint), Timeout = TimeSpan.FromSeconds(10) };
                async Task<JsonObject> Control(string action, object? data = null)
                {
                    using var response = await http.PostAsJsonAsync("/__acceptance__/" + action, data ?? new { });
                    response.EnsureSuccessStatusCode();
                    return JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsObject();
                }
                await Control("offline");
                await Until(() => !connected && !Sync().Snapshot.Online, "offline connection status");
                Invoke(island, "Refresh");
                Assert(Sync().Snapshot is { Revision: 1, Revoked: false, Profile.Slots.Count: 2 } && window.IsVisible,
                    "losing HTTP and WebSocket connections preserves the visible cached timetable");
                Capture(window, Path.Combine(output, "disconnected.png"));
                await Control("online", new { update = true });
                await Until(() => connected && Sync().Snapshot is { Online: true, Revision: 2 }, "automatic reconnection and revision 2 sync", 40);
                Assert(Sync().Snapshot.Profile!.Lessons.Any(l => l.Subject == "班会"),
                    "network recovery automatically applies the timetable saved while the receiver was disconnected");
                await Until(() => File.Exists(Path.Combine(IslandLocalStore.RootFor(binding), "profile.json")), "durable cache");
                Assert(Sync().Store.Read<JsonObject>("profile.json")?["revision"]?.GetValue<int>() == 2,
                    "the recovered revision is durably cached before delivery is acknowledged");

                async Task Send(string level, string text) => _ = await Control("shout", new { level, text });
                string? Active() => Field<QueuedShout?>(island, "_activeShout")?.Data.Text;
                void Acknowledge() => Field<Button>(window, "_dismissShout").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Send("info", "验收普通一"); await Until(() => Active() == "验收普通一", "first shout");
                await Send("info", "验收普通二"); await Until(() => island.WaitingShouts == 1, "queued shout");
                await Send("urgent", "验收紧急"); await Until(() => Active() == "验收紧急", "urgent preemption");
                Assert(island.WaitingShouts == 2 && window.IsUrgent, "a real backend emergency preempts the active ordinary message and preserves both waiting messages");
                await Task.Delay(650); Capture(window, Path.Combine(output, "urgent-preemption.png"));
                window.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
                await Until(() => Active() == "验收普通一", "interrupted message restoration");
                Acknowledge(); await Until(() => Active() == "验收普通二", "second queued message");
                Acknowledge(); await Until(() => Active() is null, "queue completion");
                await Task.Delay(500);
                var state = await Control("state");
                Assert(state["statuses"]?["验收普通一"]?.GetValue<string>() == "acknowledged"
                    && state["statuses"]?["验收普通二"]?.GetValue<string>() == "acknowledged"
                    && state["statuses"]?["验收紧急"]?.GetValue<string>() != "acknowledged",
                    "real server history records explicit confirmations and never treats Escape as human acknowledgement");
                Assert(state["ackRevision"]?.GetValue<int>() == 2, "the backend records delivery of the recovered configuration revision");
                island.Clear();

                anchor.Activate();
                probe = Process.Start(Child("--island-fullscreen-probe", probePath))!;
                await Until(() => File.Exists(probePath + ".ready"), "external fullscreen window readiness");
                await Until(() => IslandPlatform.ForegroundFullscreen(window), "external foreground fullscreen detection", 30);
                Invoke(island, "Refresh");
                Assert(!window.IsVisible, "the island hides for a real fullscreen window in a separate process");
                File.WriteAllText(probePath + ".stop", "stop");
                await probe.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8));
                anchor.Activate(); Invoke(island, "Refresh");
                await Until(() => window.IsVisible, "island restoration after external fullscreen");
                Assert(window.IsVisible, "the island automatically returns after the external fullscreen window closes");

                await ReadingExperience.OpenAsync(binding);
                await Until(() => ReadingExperience.IsFullscreen, "reading fullscreen");
                Assert(!window.IsVisible, "the actual reading window hides the island when it enters fullscreen");
                var reading = (ReadingCompanionWindow)typeof(ReadingExperience).GetField("_window", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
                await Until(() => !Field<bool>(reading, "_loading"), "local reading browser readiness", 45);
                Assert(Field<bool>(reading, "_initialized") && !Field<bool>(reading, "_browserFailed") && !Field<Border>(reading, "_notice").IsVisible,
                    "the actual embedded reading browser loads successfully without starting a microphone session: " + Field<TextBlock>(reading, "_errorTitle").Text);
                reading.WindowState = WindowState.Normal;
                await Until(() => window.IsVisible, "island restoration on reading exit from fullscreen");
                Assert(ReadingExperience.IsOpen && window.IsVisible, "leaving reading fullscreen restores the island while keeping reading open");
                await CheckReadingNavigation(reading, Assert);
                reading.BringForward(); await Until(() => !window.IsVisible, "reading fullscreen re-entry");
                await ReadingExperience.StopAsync();
                anchor.Activate(); Invoke(island, "Refresh"); await Until(() => !ReadingExperience.IsOpen && window.IsVisible, "reading close restoration");
                Assert(window.IsVisible && !ReadingExperience.IsOpen, "returning from reading closes its browser and restores the island");
                Capture(window, Path.Combine(output, "restored.png"));
            }
        }
        catch (Exception error)
        {
            failure = error.ToString(); Console.Error.WriteLine(error);
            Console.Error.WriteLine($"Connection={connected}, sync={Sync().Snapshot.Online}, revision={Sync().Snapshot.Revision}, status={Sync().Snapshot.Status}, visible={window.IsVisible}, enabled={island.Enabled}, fullscreen={IslandPlatform.ForegroundFullscreen(window)}");
            Environment.ExitCode = 1;
        }
        finally
        {
            if (probe is { HasExited: false })
            {
                File.WriteAllText(probePath + ".stop", "stop");
                try { await probe.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)); } catch (TimeoutException) { probe.Kill(); }
            }
            await ReadingExperience.StopAsync();
            anchor?.Close(); await receiver.StopAsync(); island.Dispose(); ReadingOfflineService.Stop();
            File.WriteAllText(Path.Combine(output, stage + ".json"), JsonSerializer.Serialize(new { stage, processId = Environment.ProcessId,
                passed, failure, completedAt = DateTimeOffset.Now }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{passed.Count} {stage} checks passed.");
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private static async Task CheckReadingNavigation(ReadingCompanionWindow reading, Action<bool, string> assert)
    {
        var browser = Field<ReadingBrowser>(reading, "_browser");
        var core = browser.Core!;
        var home = Field<Button>(reading, "_home");
        var fullscreen = Field<Button>(reading, "_fullscreen");
        async Task UntilPage(string script)
        {
            var clock = Stopwatch.StartNew();
            while (await core.ExecuteScriptAsync(script) != "true")
            {
                if (clock.Elapsed.TotalSeconds > 20) throw new TimeoutException("Reading navigation: " + script);
                await Task.Delay(100);
            }
        }
        assert(home.Content?.ToString() == "返回" && fullscreen.IsVisible,
            "the native toolbar keeps the existing return and fullscreen actions");
        assert(await core.ExecuteScriptAsync("getComputedStyle(document.querySelector('.classic-toolbar')).display === 'none'") == "true",
            "the embedded reading page does not repeat the native navigation bar");
        foreach (var mode in new[] { "classic", "carving", "particle", "rocket" })
        {
            await core.ExecuteScriptAsync($"document.getElementById('open-{mode}').click();");
            await UntilPage("!document.getElementById('choose-mode').hidden && !document.getElementById('exit-classic').hidden");
            assert(await core.ExecuteScriptAsync("getComputedStyle(document.querySelector('.classic-toolbar')).display !== 'none'") == "true",
                mode + " keeps mode actions in their existing second toolbar row");
            var originalName = Field<TextBlock>(reading, "_classLabel").Text!;
            reading.SetClassName("高一（1）班 · 较长班级名称的本地验收");
            foreach (var width in new[] { 640d, 1200d })
            {
                reading.Width = width; reading.Height = 820;
                await Until(() => Math.Abs(reading.ClientSize.Width - width) < 1
                    && Math.Abs(browser.Bounds.Width - width) < 1, "reading browser resize");
                await UntilPage($"Math.abs(innerWidth - {JsonSerializer.Serialize(width)}) < 1");
                var measurement = JsonNode.Parse(await core.ExecuteScriptAsync("(() => {const r=document.getElementById('exit-classic').getBoundingClientRect(),s=getComputedStyle(document.querySelector('.classic-toolbar'));return {right:r.right,height:r.height,viewport:innerWidth,paddingRight:s.paddingRight,devicePixelRatio};})()"))!;
                var browserOrigin = browser.TranslatePoint(new Point(0, 0), reading)!.Value;
                var pageScale = browser.Bounds.Width / measurement["viewport"]!.GetValue<double>();
                var pageRight = browserOrigin.X + measurement["right"]!.GetValue<double>() * pageScale;
                var nativeRight = fullscreen.TranslatePoint(new Point(0, 0), reading)!.Value.X + fullscreen.Bounds.Width;
                Console.WriteLine($"Reading alignment {mode} {width}: page={measurement.ToJsonString()}, browser={browser.Bounds}, origin={browserOrigin}, nativeRight={nativeRight}, client={reading.ClientSize}");
                assert(Math.Abs(pageRight - nativeRight) <= 1
                    && measurement["height"]!.GetValue<double>() * pageScale >= 44 && fullscreen.Bounds.Height >= 44,
                    $"{mode} second-row right edge aligns with native fullscreen at {width} DIP (difference {Math.Abs(pageRight - nativeRight):F2} DIP)");
            }
            reading.SetClassName(originalName);
            if (mode is "classic" or "rocket")
            {
                await UntilPage("!!document.querySelector('iframe')?.contentDocument?.getElementById('dashboard')");
                assert(await core.ExecuteScriptAsync("(() => {const doc=document.querySelector('iframe').contentDocument;return doc.defaultView.getComputedStyle(doc.getElementById('fullscreen-btn')).display==='none';})()") == "true",
                    mode + " has only one visible fullscreen action outside fullscreen");
                await core.ExecuteScriptAsync("document.querySelector('iframe').dataset.navigationReview='previous';");
            }
            await core.ExecuteScriptAsync("document.getElementById('exit-classic').click();");
            if (mode is "classic" or "rocket")
                await UntilPage("!!document.querySelector('iframe')?.contentDocument?.getElementById('dashboard') && document.querySelector('iframe').dataset.navigationReview !== 'previous'");
            else
                await UntilPage($"!document.getElementById('{mode}-setup').hidden");
            assert(await core.ExecuteScriptAsync("document.getElementById('home-view').hidden && !document.getElementById('exit-classic').hidden") == "true",
                mode + " restart returns to its setup without leaving the selected activity");
            if (mode is "classic" or "rocket")
            {
                reading.WindowState = WindowState.FullScreen;
                await UntilPage("document.documentElement.dataset.desktopFullscreen === 'true'");
                // Let the activity's own control observer settle after the host event.
                await Task.Delay(250);
                assert(!Field<Border>(reading, "_chrome").IsVisible
                    && await core.ExecuteScriptAsync("(() => {const doc=document.querySelector('iframe').contentDocument;const button=doc.getElementById('fullscreen-btn');return doc.defaultView.getComputedStyle(button).display!=='none' && button.textContent==='退出全屏';})()") == "true",
                    mode + " fullscreen hides the native bar and exposes one exit-fullscreen action in the activity");
                await core.ExecuteScriptAsync("document.querySelector('iframe').contentDocument.getElementById('fullscreen-btn').click();");
                await UntilPage("document.documentElement.dataset.desktopFullscreen === 'false'");
                assert(Field<Border>(reading, "_chrome").IsVisible,
                    mode + " exit-fullscreen restores the native navigation bar");
            }
            await core.ExecuteScriptAsync("document.getElementById('choose-mode').click();");
            await UntilPage("!document.getElementById('home-view').hidden");
            assert(await core.ExecuteScriptAsync("!document.getElementById('home-view').hidden && !document.querySelector('iframe')") == "true",
                mode + " can return to mode selection and release its activity");
        }
    }

    public static void FullscreenProbe(string path)
    {
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont().AfterSetup(_ => Dispatcher.UIThread.Post(() =>
        {
            var window = new Window { Title = "ICeClass 全屏课件验收", WindowState = WindowState.FullScreen,
                Content = new TextBlock { Text = "本地全屏课件验收", FontSize = 32, Margin = new Thickness(48) } };
            window.Show(); window.Activate();
            var clock = Stopwatch.StartNew();
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
            timer.Tick += (_, _) =>
            {
                if (!File.Exists(path + ".ready") && window.WindowState == WindowState.FullScreen) File.WriteAllText(path + ".ready", Environment.ProcessId.ToString());
                if (File.Exists(path + ".stop") || clock.Elapsed.TotalSeconds > 30)
                { timer.Stop(); window.Close(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); }
            };
            timer.Start();
        })).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }
}

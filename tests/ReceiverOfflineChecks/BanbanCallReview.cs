using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class BanbanCallReview
{
    private const BindingFlags Instance = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Instance)!.GetValue(target)!;
    private static void Invoke(object target, string name, params object[] arguments) =>
        target.GetType().GetMethod(name, Instance)!.Invoke(target, arguments);

    internal static void Run(string bindingPath, string output)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("Calling Banban requires a loopback classroom binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(binding, Path.GetFullPath(output))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Until(Func<bool> condition, string message, int seconds = 35)
    {
        var clock = Stopwatch.StartNew();
        while (!condition())
        {
            if (clock.Elapsed.TotalSeconds > seconds) throw new TimeoutException(message);
            await Task.Delay(100);
        }
    }

    private static async Task Check(ReceiverConfig binding, string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var events = new ConcurrentQueue<BanbanVoiceEvent>();
        var bridge = new List<object>();
        var voicePreference = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ICeClass", "Receiver", "banban-voice.json");
        var originalPreference = File.Exists(voicePreference) ? File.ReadAllBytes(voicePreference) : null;
        BanbanVoiceWindow? assistant = null;
        StudentVoiceWindow? home = null;
        void Record(bool passed, string name)
        {
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) throw new InvalidOperationException(name);
            checks.Add(name);
        }
        try
        {
            var petPreference = Path.Combine(output, "pet-preferences.json");
            File.WriteAllText(petPreference, "{\"Visible\":false}");
            assistant = new BanbanVoiceWindow(binding, () => { }, enabled: true, petPreferencePath: petPreference);
            var voice = Field<BanbanVoiceService>(assistant, "_voice");
            voice.Changed += events.Enqueue;
            home = new StudentVoiceWindow(binding, _ => Task.CompletedTask,
                showIsland: () => { }, showBanban: () => Invoke(assistant, "StartConversation"));
            home.ShowActivated = false;
            home.Show();
            var call = home.GetVisualDescendants().OfType<Button>()
                .Single(button => button.Content is string text && (text == "班班" || text == "呼叫班班"));
            void ClickCall() => call.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            foreach (var (width, height) in new[] { (1000, 760), (720, 520) })
            {
                home.Width = width; home.Height = height;
                await Task.Delay(150); home.UpdateLayout();
                using var bitmap = new RenderTargetBitmap(new PixelSize(width, height));
                bitmap.Render(home);
                bitmap.Save(Path.Combine(output, $"home-{width}.png"));
            }

            assistant.SetInClass(true);
            ClickCall();
            Record(!assistant.IsVisible && assistant.CompanionVisible,
                "a first call before initialization reveals Banban without opening text chat");
            var pet = Field<BanbanPetWindow>(assistant, "_pet");
            Record(Field<Button>(pet, "_captionButton").IsVisible && !Field<bool>(pet, "_docked"),
                "calling during class keeps the companion expanded with visible preparation feedback");
            await assistant.StartAsync(background: true);
            Field<ReadingBrowser>(assistant, "_browser").Core!.WebMessageReceived += (_, message) =>
            {
                using var document = JsonDocument.Parse(message.WebMessageAsJson);
                var root = document.RootElement;
                bridge.Add(new {
                    kind = root.TryGetProperty("kind", out var kind) ? kind.GetString() : "",
                    authorized = root.TryGetProperty("value", out var value) && value.ValueKind == JsonValueKind.True,
                    pending = Field<bool>(assistant, "_pendingConversation")
                });
            };
            await Until(() => voice.Status == "您说，我在听" && !assistant.IsVisible,
                "the pending call did not reach listening after classroom authorization");
            Record(Field<bool>(assistant, "_authorized") && voice.Microphone.Length > 0,
                "the first call uses the real authorized classroom session and local microphone");
            Record(assistant.CompanionVisible && !assistant.ShowActivated,
                "the first call shows the companion without activating text chat");
            Record(!events.Any(value => value.State == "speaking"),
                "a button call listens immediately without playing a greeting");

            var generation = events.Last(value => value.Kind == "wake").Conversation;
            ClickCall();
            await Until(() => events.Any(value => value.Kind == "wake" && value.Conversation > generation),
                "a repeated call did not restart listening");
            Record(!assistant.IsVisible && assistant.CompanionVisible && voice.Status == "您说，我在听",
                "calling an already present companion keeps listening instead of toggling it off");

            generation = events.Last(value => value.Kind == "wake").Conversation;
            voice.Leave(generation);
            await Until(() => !assistant.CompanionVisible, "the companion did not finish its departure");
            ClickCall();
            await Until(() => events.Any(value => value.Kind == "wake" && value.Conversation > generation)
                && assistant.CompanionVisible, "calling after departure did not restore listening");
            Record(!assistant.IsVisible && voice.Status == "您说，我在听",
                "the home button recalls a departed companion directly into listening");

            Invoke(assistant, "SetVoiceEnabled", false);
            await Until(() => !voice.Enabled && voice.Status == "语音已关闭", "voice did not pause");
            ClickCall();
            await Until(() => voice.Enabled && voice.Status == "您说，我在听", "a call did not enable paused voice");
            Record(!assistant.IsVisible && assistant.CompanionVisible,
                "calling with voice paused enables listening without opening text chat");

            assistant.BringForward();
            Record(assistant.IsVisible, "the explicit text-dialogue entry remains available");
            generation = events.Last(value => value.Kind == "wake").Conversation;
            ClickCall();
            await Until(() => events.Any(value => value.Kind == "wake" && value.Conversation > generation),
                "switching from text chat did not start listening");
            Record(!assistant.IsVisible && assistant.CompanionVisible,
                "calling from an open dialogue returns to the classroom companion");

            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"logout\"}");
            ClickCall();
            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"identity-error\",\"text\":\"关联测试失败，请重新连接。\"}");
            Record(assistant.IsVisible && Field<Border>(assistant, "_notice").IsVisible,
                "a failed pending call exposes the existing actionable connection notice");
            assistant.Hide();
            ClickCall();
            Record(assistant.IsVisible && Field<Border>(assistant, "_notice").IsVisible,
                "calling after an earlier connection failure exposes recovery instead of waiting forever");
            var wakeCount = events.Count(value => value.Kind == "wake");
            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"ready\"}");
            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"authorized\",\"value\":true}");
            await Until(() => voice.Status.Contains("等候"), "voice did not return to standby after reconnecting");
            Record(events.Count(value => value.Kind == "wake") == wakeCount,
                "a failed call is consumed so a late authorization cannot start listening");

            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"logout\"}");
            ClickCall();
            Invoke(assistant, "SetVoiceEnabled", false);
            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"ready\"}");
            Invoke(assistant, "Receive", "{\"type\":\"banban-voice\",\"kind\":\"authorized\",\"value\":true}");
            await Until(() => !voice.Enabled && voice.Status == "语音已关闭", "a pending call ignored voice pause");
            Record(events.Count(value => value.Kind == "wake") == wakeCount,
                "pausing clears a pending call before an authorization reply arrives");

            // Reproduce a known microphone retry interval without changing hardware.
            typeof(BanbanVoiceService).GetField("_retryAfter", Instance)!.SetValue(voice, DateTime.UtcNow.AddSeconds(5));
            var errorsBeforeCall = events.Count(value => value.State == "error");
            ClickCall();
            await Until(() => events.Count(value => value.State == "error") > errorsBeforeCall,
                "calling while the microphone recovers did not report that listening could not start", seconds: 2);
            await Until(() => Field<Button>(pet, "_captionButton").IsVisible
                && !Field<BanbanListeningWaveform>(pet, "_waveform").IsVisible,
                "microphone recovery left the companion pretending to prepare or listen", seconds: 2);
            Record(true, "a call during microphone recovery shows an actionable error instead of preparing forever");
            await Until(() => voice.Status.Contains("等候"), "the real microphone did not recover after its retry interval");
            Record(events.Count(value => value.Kind == "wake") == wakeCount,
                "automatic microphone recovery cannot revive a rejected call");
            ClickCall();
            await Until(() => voice.Status == "您说，我在听", "calling after microphone recovery did not start listening");
            Record(!assistant.IsVisible && assistant.CompanionVisible,
                "a fresh call after microphone recovery resumes the normal classroom interaction");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            home?.Close(); assistant?.Shutdown();
            if (originalPreference is not null) File.WriteAllBytes(voicePreference, originalPreference);
            else if (File.Exists(voicePreference)) File.Delete(voicePreference);
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(new {
                passed = Environment.ExitCode == 0, checks
            }, new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllText(Path.Combine(output, "events.json"), JsonSerializer.Serialize(events.Where(value => value.Kind != "audio-level").ToArray()));
            File.WriteAllText(Path.Combine(output, "bridge.json"), JsonSerializer.Serialize(bridge, new JsonSerializerOptions { WriteIndented = true }));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

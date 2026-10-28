using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using NAudio.CoreAudioApi;

// A real native/WebView/agent integration check. Speech transcripts are injected
// at the recognizer callback boundary; acoustic recognition is checked separately.
internal static class NativeVoiceDialogueReview
{
    private static Action? _showManual;
    internal static void Run(string binding, string output, bool manual = false)
    {
        using var single = manual ? new Mutex(false, "Local\\ICeClass.BanbanVoiceManualReview", out _) : null;
        using var show = manual ? new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\ICeClass.BanbanVoiceManualReview.Show", out _) : null;
        if (manual && !single!.WaitOne(0)) { show!.Set(); return; }
        var activation = manual ? ThreadPool.RegisterWaitForSingleObject(show!, (_, _) => Dispatcher.UIThread.Post(() => _showManual?.Invoke()), null, Timeout.Infinite, false) : null;
        var ui = new Thread(() => AppBuilder.Configure<IslandCheckHost>()
            .UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(binding, Path.GetFullPath(output), manual)))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        ui.SetApartmentState(ApartmentState.STA); ui.Start(); ui.Join();
        activation?.Unregister(null);
        if (manual) single!.ReleaseMutex();
    }

    private static async Task Review(string bindingPath, string output, bool manual)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        var utterances = 0;
        BanbanVoiceWindow? assistant = null;
        CloudReceiverService? receiver = null;
        Window? editor = null;
        SpeechService? speech = null;
        TrayIcon? tray = null;
        IslandSyncService? petSchedule = null;
        DispatcherTimer? petScheduleTimer = null;
        var shuttingDown = false;
        async Task Shutdown()
        {
            if (shuttingDown) return;
            shuttingDown = true;
            petScheduleTimer?.Stop(); petSchedule?.Dispose();
            assistant?.Shutdown();
            if (receiver is not null) await receiver.StopAsync();
            tray?.Dispose(); speech?.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        }
        void Record(string name, bool passed)
        {
            checks.Add(new { name, passed });
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) throw new InvalidOperationException(name);
        }
        async Task Until(Func<Task<bool>> ready, string message, int seconds = 100)
        {
            var timer = Stopwatch.StartNew();
            while (timer.Elapsed.TotalSeconds < seconds) { if (await ready()) return; await Task.Delay(300); }
            throw new TimeoutException(message);
        }
        try
        {
            var config = JsonSerializer.Deserialize<ReceiverConfig>(File.ReadAllText(bindingPath))!;
            if (config.Endpoint is not ("http://127.0.0.1:8863" or "http://127.0.0.1:8864" or "http://127.0.0.1:8865" or "http://127.0.0.1:8866")) throw new InvalidOperationException("Voice review is restricted to the isolated localhost service.");
            using var process = Process.GetCurrentProcess();
            var reviewExecutable = process.MainModule!.FileName;
            var folder = Path.Combine(output, "课件"); Directory.CreateDirectory(folder);
            ClassroomAgentPolicy Policy()
            {
                // Manual acceptance uses the actual local permissions and can
                // observe changes made in settings without another restart.
                var policy = manual ? ClassroomAgentPolicy.Load() : new ClassroomAgentPolicy { AllowAllFolders = false };
                policy.Applications.Add(reviewExecutable);
                policy.Folders.Add(folder);
                return policy;
            }
            speech = new SpeechService();
            receiver = new CloudReceiverService(speech, new ClassroomAgentService(Policy));
            var initialText = "等待班班安排";
            if (manual && File.Exists(Path.Combine(output, "actual-state.json")))
            {
                try { initialText = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, "actual-state.json"))).RootElement.GetProperty("text").GetString() ?? initialText; }
                catch (JsonException) { }
            }
            var text = new TextBox { Text = initialText, MinHeight = 44 };
            AutomationProperties.SetName(text, "验收文字");
            var status = ClassroomStyle.Text("正在连接", 14, muted: true);
            var microphone = ClassroomStyle.Text("", 14, muted: true);
            editor = new Window { Title = "班班语音验收窗口", Width = 560, Height = manual ? 350 : 270,
                Content = new StackPanel { Margin = new Thickness(24), Spacing = 16, Children = {
                    ClassroomStyle.Text("班班语音任务验收", 22, bold:true), text, status, microphone } } };
            ClassroomStyle.Apply(editor);
            void Save() => File.WriteAllText(Path.Combine(output, "actual-state.json"), JsonSerializer.Serialize(new { text = text.Text, pid = Environment.ProcessId }));
            text.TextChanged += (_, _) => Save();
            receiver.ComputerAgent.StatusChanged += value => Dispatcher.UIThread.Post(() => {
                status.Text = value;
                File.AppendAllText(Path.Combine(output, "native-events.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), status = value }) + "\n");
            });
            editor.Show(); Save(); await receiver.StartAsync(config);
            var voiceBinding = new ReceiverConfig { Endpoint = config.Endpoint, DeviceId = config.DeviceId, ClassId = config.ClassId, ClassName = config.ClassName };
            assistant = new BanbanVoiceWindow(voiceBinding, () => receiver.ComputerAgent.Stop(), enabled:manual ? BanbanVoicePreferences.Load() : true,
                petPreferencePath: Path.Combine(output, "pet-preferences.json"));
            voiceBinding.ClassId = "changed-in-place";
            Record("mutable receiver configuration cannot silently retarget voice authorization", !assistant.Matches(voiceBinding));
            voiceBinding.ClassId = config.ClassId;
            assistant.VoiceStatusChanged += value => {
                if (value.Contains("正在说")) utterances++;
                File.AppendAllText(Path.Combine(output, "voice-events.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), status = value }) + "\n");
            };
            await assistant.StartAsync();
            var browser = (ReadingBrowser)typeof(BanbanVoiceWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant)!;
            var voice = (BanbanVoiceService)typeof(BanbanVoiceWindow).GetField("_voice", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant)!;
            if (!manual)
            {
                var diagnosticsGate = new object();
                voice.Changed += value => {
                    lock (diagnosticsGate) File.AppendAllText(Path.Combine(output, "voice-diagnostics.jsonl"),
                        JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, value }) + "\n");
                };
                voice.AudioObservation += observation => {
                    lock (diagnosticsGate) File.AppendAllText(Path.Combine(output, "audio-diagnostics.jsonl"),
                        JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, observation }) + "\n");
                };
            }
            async Task<bool> Is(string expression) => browser.Core is not null && await browser.Core.ExecuteScriptAsync(expression) == "true";
            async Task Hear(string sentence, bool keyword = false)
            {
                if (!keyword) await Until(() => Task.FromResult(!voice.Status.Contains("正在说")), "Speech did not settle", 50);
                await Task.Delay(keyword ? 100 : 550);
                var method = typeof(BanbanVoiceService).GetMethod("Heard", BindingFlags.Instance | BindingFlags.NonPublic)!;
                var post = typeof(BanbanVoiceService).GetMethod("Post", BindingFlags.Instance | BindingFlags.NonPublic)!;
                var heard = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                post.Invoke(voice, [new Action(() => {
                    try {
                        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
                        object? Field(string name) => typeof(BanbanVoiceService).GetField(name, flags)!.GetValue(voice);
                        File.AppendAllText(Path.Combine(output, "injected-transcripts.jsonl"), JsonSerializer.Serialize(new {
                            at = DateTime.UtcNow, sentence, enabled = Field("_enabled"), ready = Field("_ready"), active = Field("_active"),
                            speaking = Field("_speaking"), ignoreUntil = Field("_ignoreUntil"), lastText = Field("_lastText")
                        }) + "\n");
                        method.Invoke(voice, [sentence, keyword ? "keyword" : "injected-review"]);
                        heard.TrySetResult();
                    } catch (Exception error) { heard.TrySetException(error); }
                })]);
                await heard.Task.WaitAsync(TimeSpan.FromSeconds(20));
            }
            await Until(() => Is("document.readyState === 'complete'"), "Page did not load");
            if (!await Is("!!window.ICeClass?.state?.user"))
            {
                await browser.Core!.ExecuteScriptAsync("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'ICe',password:'LocalDemo2026'})}).then(r=>{if(r.ok)location.reload()})");
            }
            await Until(() => Is("!!document.querySelector('#bbInput') && !!window.ICeClass?.state?.user"), "Demo teacher login failed");
            if (manual)
            {
                // Observe the real class schedule without running lesson reminders or automation.
                petSchedule = new IslandSyncService(config, Path.Combine(output, "schedule-cache"));
                void RefreshPetSchedule()
                {
                    var snapshot = petSchedule.Snapshot;
                    var now = DateTimeOffset.UtcNow;
                    var today = DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).DateTime);
                    var lessons = snapshot.Revoked || snapshot.Profile is null ? [] : IslandSchedule.On(snapshot.Profile, today);
                    assistant.SetInClass(lessons.Any(lesson => lesson.At(lesson.Slot.Start) <= now && now < lesson.At(lesson.Slot.End)));
                }
                petScheduleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
                petScheduleTimer.Tick += (_, _) => RefreshPetSchedule();
                RefreshPetSchedule(); petScheduleTimer.Start();
                var level = 0; var peak = 0; var recognized = 0; var partials = 0; var wakes = 0;
                var interruptions = 0; var cancellations = 0; var leaves = 0;
                string recognizedText = "", partial = "", lastTranscript = "";
                string controlTranscript = ""; var controlPartials = 0; var controlFrames = 0;
                DateTimeOffset? lastSoundAt = null, lastRecognitionAt = null;
                string inputName = "Windows 默认麦克风"; bool? muted = null;
                try
                {
                    using var devices = new MMDeviceEnumerator();
                    using var device = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
                    inputName = device.FriendlyName; muted = device.AudioEndpointVolume.Mute;
                }
                catch (Exception error) { inputName = "无法读取默认麦克风：" + error.Message; }
                void SaveManual()
                {
                    File.WriteAllText(Path.Combine(output, "manual-state.json"), JsonSerializer.Serialize(new {
                        mode = "real microphone; local playback diagnostics are marked separately; no automatic tasks", pid = Environment.ProcessId,
                        at = DateTimeOffset.UtcNow, status = voice.Status, microphone = voice.Microphone, muted, echoCancellation = voice.EchoCancellation,
                        naturalInterruption = voice.NaturalInterruption, neuralVoiceReady = voice.NeuralVoiceReady,
                        workingSetMiB = Environment.WorkingSet / 1048576d,
                        assistantVisible = assistant.IsVisible, petVisible = assistant.CompanionVisible, editorVisible = editor.IsVisible, wakes, lastTranscript, interruptions, cancellations, leaves,
                        engine = BanbanSpeechRecognizer.EngineName, audioLevel = level, peakAudioLevel = peak, recognized, partials,
                        recognizedText, partial, controlTranscript, controlPartials, controlFrames,
                        lastSoundAt, lastRecognitionAt, text = text.Text
                    }));
                }
                voice.Recognition += result => Dispatcher.UIThread.Post(() => {
                    if (shuttingDown) return;
                    if (result.Final) { if (result.Text.Length > 0) { recognized++; recognizedText = result.Text; lastRecognitionAt = DateTimeOffset.UtcNow; } partial = ""; }
                    else { partials++; partial = result.Text; }
                    SaveManual();
                });
                voice.AudioObservation += observation => Dispatcher.UIThread.Post(() => {
                    if (shuttingDown) return;
                    File.AppendAllText(Path.Combine(output, "audio-diagnostics.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, observation }) + "\n");
                    if (observation.ControlsOnly && observation.Kind == "recognition") { controlTranscript = observation.Text; controlPartials++; }
                    if (observation.ControlsOnly && observation.Kind == "frames") controlFrames += observation.Frames;
                    SaveManual();
                });
                voice.Changed += e => Dispatcher.UIThread.Post(() =>
                {
                    if (shuttingDown) return;
                    if (e.Kind == "audio-level")
                    {
                        level = e.Level; peak = Math.Max(peak, level);
                        if (level > 0) lastSoundAt = DateTimeOffset.UtcNow;
                    }
                    if (e.Kind == "wake") wakes++;
                    if (e.Kind == "interrupt") interruptions++;
                    if (e.Kind == "cancel") cancellations++;
                    if (e.Kind == "leave") leaves++;
                    if (e.Kind is "interrupt" or "cancel" or "leave") File.AppendAllText(Path.Combine(output, "control-events.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, kind = e.Kind }) + "\n");
                    if (e.Kind == "transcript") lastTranscript = e.Text;
                    microphone.Text = $"{voice.Microphone} · 输入 {level}%";
                    SaveManual();
                });
                var menu = new NativeMenu();
                var showAssistant = new NativeMenuItem { Header = "打开班班语音助手" };
                showAssistant.Click += (_, _) => assistant.BringForward(); menu.Items.Add(showAssistant);
                var showPet = new NativeMenuItem { Header = "显示班班桌宠" };
                showPet.Click += (_, _) => assistant.ShowPet(); menu.Items.Add(showPet);
                var showEditor = new NativeMenuItem { Header = "打开验收文字窗口" };
                showEditor.Click += (_, _) => { editor.Show(); editor.Activate(); }; menu.Items.Add(showEditor);
                var exit = new NativeMenuItem { Header = "退出本地验收" };
                exit.Click += async (_, _) => await Shutdown(); menu.Items.Add(exit);
                tray = new TrayIcon { Icon = new WindowIcon(AppIconFactory.CreateStream()), Menu = menu,
                    ToolTipText = "班班语音 · 本地验收", IsVisible = true };
                tray.Clicked += (_, _) => assistant.BringForward();
                editor.Closing += (_, e) => { if (!shuttingDown && e.CloseReason is not (WindowCloseReason.OSShutdown or WindowCloseReason.ApplicationShutdown)) { e.Cancel = true; editor.Hide(); } };
                status.Text = "说“你好班班”或点击桌宠安排任务。双击桌宠打开对话。";
                microphone.Text = inputName; SaveManual();
                _showManual = () => assistant.ShowPet();
                // Local harness only: deterministic playback observation and graceful
                // restarts without creating chat tasks or pretending to hear a person.
                var commands = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
                var commandBusy = false;
                commands.Tick += async (_, _) => {
                    var commandPath = Path.Combine(output, "review-command.json");
                    if (commandBusy || shuttingDown || !File.Exists(commandPath)) return;
                    commandBusy = true;
                    try
                    {
                        using var command = JsonDocument.Parse(File.ReadAllText(commandPath)); File.Delete(commandPath);
                        var kind = command.RootElement.GetProperty("kind").GetString();
                        File.AppendAllText(Path.Combine(output, "audio-diagnostics.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, reviewCommand = kind }) + "\n");
                        if (kind == "shutdown") { commands.Stop(); await Shutdown(); }
                        else if (kind == "reload") browser.Core!.Reload();
                        else if (kind == "snapshot")
                        {
                            File.WriteAllText(Path.Combine(output, "live-ui.json"), await browser.Core!.ExecuteScriptAsync("JSON.stringify({url:location.href,native:window.ICeClassVoiceHost?.version,bridge:!!window.chrome?.webview,user:window.ICeClass?.state?.user?.role,classes:window.ICeClass?.state?.classes?.map(c=>c.id),caption:document.querySelector('.bb-privacy')?.textContent,voiceState:document.querySelector('.bb-voice-button')?.dataset.state})"));
                            File.WriteAllText(Path.Combine(output, "live-host.json"), JsonSerializer.Serialize(new {
                                pageReady = typeof(BanbanVoiceWindow).GetField("_pageReady", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant),
                                authorized = typeof(BanbanVoiceWindow).GetField("_authorized", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant),
                                suspended = typeof(BanbanVoiceWindow).GetField("_suspended", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant),
                                status = voice.Status
                            }));
                        }
                        else if (kind == "standby") voice.Standby();
                        else if (kind == "speak")
                        {
                            await Hear("你好班班");
                            await Until(() => Task.FromResult(voice.Status.Contains("我在听")), "Diagnostic wake did not settle", 15);
                            voice.Speak(command.RootElement.GetProperty("text").GetString() ?? "这是本机播报测试。");
                        }
                    }
                    catch (Exception error) { File.AppendAllText(Path.Combine(output, "diagnostic-errors.log"), error.ToString() + "\n"); }
                    finally { commandBusy = false; }
                };
                commands.Start();
                assistant.Hide(); assistant.ShowPet();
                await using (var image = File.Create(Path.Combine(output, "manual-view.png")))
                    await browser.Core!.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, image);
                Console.WriteLine("Manual voice review ready. Real microphone only; closing windows keeps the tray alive.");
                return;
            }
            await Until(() => Task.FromResult(voice.Status.Contains("等候")), "Native recognizer failed to enter standby", 30);
            Record("teacher authorization starts native standby", true);
            var companion = (BanbanPetWindow)typeof(BanbanVoiceWindow).GetField("_pet", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant)!;
            var talk = companion.GetVisualDescendants().OfType<Button>().Single(b => b.Name == "BanbanPetTalk");
            assistant.Hide(); assistant.ShowPet();
            talk.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            await Until(() => Task.FromResult(voice.Status.Contains("我在听")), "Pet click did not start the existing voice conversation", 20);
            Record("desktop pet starts the shared microphone session while chat stays hidden", assistant.CompanionVisible && !assistant.IsVisible);
            var petCancellations = 0;
            voice.Changed += e => { if (e.Kind == "cancel") Interlocked.Increment(ref petCancellations); };
            var petStop = talk.ContextMenu!.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "停止操作"));
            petStop.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
            await Until(() => Task.FromResult(Volatile.Read(ref petCancellations) == 1), "Pet stop did not reach the shared cancellation stream", 5);
            Record("desktop pet stop reaches real native and chat cancellation", true);
            voice.Standby();
            await Until(() => Task.FromResult(voice.Status.Contains("等候")), "Pet review did not return to standby", 5);
            await Until(() => Is("!document.querySelector('#bbNew')?.disabled"), "Conversation did not finish loading");
            await browser.Core!.ExecuteScriptAsync("document.querySelector('#bbNew').click()");
            await Until(() => Is("document.querySelectorAll('.bb-message-user').length === 0"), "New conversation did not open");
            await Hear("请翻到下一页"); await Task.Delay(500);
            Record("unwoken ordinary speech did not create a chat task", await Is("document.querySelectorAll('.bb-message-user').length === 0"));
            assistant.Hide();
            await Hear("你好班班");
            await Until(() => Task.FromResult(voice.Status.Contains("我在听")), "Wake feedback did not finish", 20);
            Record("wake works with assistant window hidden", !assistant.IsVisible);
            await Hear("你可以打开电脑上的<unk>");
            await Until(() => Task.FromResult(voice.Status.Contains("我在听")), "Unknown speech repeat feedback did not finish", 20);
            Record("unknown recognition is rejected before chat or task creation", await Is("document.querySelectorAll('.bb-message-user').length === 0") && text.Text == "等待班班安排");
            await Hear("把班班语音验收窗口里名为验收文字的文字框改成 Hello class。");
            await Until(() => Task.FromResult(text.Text == "Hello class"), "Direct bilingual voice operation did not reach the real editor", 130);
            await Until(() => Is("document.querySelector('#bbNew')?.disabled === false && !document.querySelector('.bb-error')"), "Final direct execution receipt did not arrive", 90);
            Record("the explicit voice task updates the actual editor without a confirmation card", await Is("!document.querySelector('.bb-operation[data-state=awaiting_confirmation]')"));
            await Hear("确认<unk>执行");
            await Until(() => Task.FromResult(voice.Status.Contains("我在听")), "Unknown speech feedback did not return to listening", 20);
            Record("incomplete recognition cannot start another task or change completed work", text.Text == "Hello class"
                && await Is("![...document.querySelectorAll('.bb-message-user')].some(e=>e.textContent.includes('<unk>'))"));
            // A decode begun during playback may finish after playback ends.
            // Its capture provenance must still prevent it from confirming.
            await Until(() => Task.FromResult(!voice.Status.Contains("正在说")), "Repeat feedback did not finish", 20);
            var recognize = typeof(BanbanVoiceService).GetMethod("Recognized", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var dispatch = typeof(BanbanVoiceService).GetMethod("Post", BindingFlags.Instance | BindingFlags.NonPublic)!;
            dispatch.Invoke(voice, [new Action(() => recognize.Invoke(voice, [new BanbanSpeechResult("确认执行", true, DuringPlayback: true)]))]);
            await Task.Delay(800);
            Record("a late playback confirmation cannot create another operation", text.Text == "Hello class"
                && await Is("!document.querySelector('.bb-operation[data-state=awaiting_confirmation]')"));
            await Until(() => Task.FromResult(utterances >= 2), "Final result was not spoken", 10);
            Record("wake and direct execution result are spoken", true);
            Record("voice changed the real native editor while hidden", !assistant.IsVisible);
            await Hear("把刚才验收文字改成连续任务已完成。");
            await Until(() => Task.FromResult(text.Text == "连续任务已完成"), "The next voice task did not execute directly", 100);
            await Until(() => Is("document.querySelector('#bbNew')?.disabled === false"), "The next voice task did not finish", 90);
            await Hear("班班取消操作", keyword: true);
            await Until(() => Is("!document.querySelector('.bb-operation[data-state=awaiting_confirmation]')"), "Cancellation was not acknowledged", 20);
            Record("spoken cancellation does not undo an already completed task", text.Text == "连续任务已完成");
            await Task.Delay(1000);
            await Hear("再见班班", keyword: true);
            await Until(() => Task.FromResult(voice.Status.Contains("等候")), "Leave did not return to standby", 20);
            Record("leave ends the active dialogue", true);
            // A loaded page alone must never restart the microphone after an
            // unauthorized session resumes from lock or sleep.
            typeof(BanbanVoiceWindow).GetMethod("Receive", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(assistant, ["{\"type\":\"banban-voice\",\"kind\":\"authorized\",\"value\":false}"]);
            var suspend = typeof(BanbanVoiceWindow).GetMethod("Suspend", BindingFlags.Instance | BindingFlags.NonPublic)!;
            suspend.Invoke(assistant, [true]); await Task.Delay(300); suspend.Invoke(assistant, [false]); await Task.Delay(500);
            Record("lock/resume does not authorize an unauthorized page", !((bool)typeof(BanbanVoiceService).GetField("_ready", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(voice)!));
            talk.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            await Task.Delay(250);
            Record("unauthorized pet click opens login without authorizing the microphone", assistant.IsVisible
                && !((bool)typeof(BanbanVoiceService).GetField("_ready", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(voice)!));
            await browser.Core!.ExecuteScriptAsync("window.chrome.webview.postMessage({type:'banban-voice',kind:'ready'})");
            assistant.BringForward();
            await Task.Delay(500);
            if (!File.Exists(Path.Combine(output, "native-dialogue.png")))
            {
                await using var screenshot = File.Create(Path.Combine(output, "native-dialogue.png"));
                await browser.Core.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, screenshot);
            }
            File.WriteAllText(Path.Combine(output, "dialogue-text.json"),
                await browser.Core!.ExecuteScriptAsync("JSON.stringify([...document.querySelectorAll('.bb-message')].map(e=>({role:e.classList.contains('bb-message-user')?'user':'assistant',text:e.querySelector('.bb-message-content')?.textContent})))"));
            File.WriteAllText(Path.Combine(output, "review-summary.json"), JsonSerializer.Serialize(new {
                source = "real authenticated WebView, model, server, WebSocket and Windows UI automation; recognizer callbacks injected, acoustic wake tested separately",
                completed = true, actualText = text.Text, checks
            }, new JsonSerializerOptions {WriteIndented=true}));
            Console.WriteLine("Voice integration review completed. Microphone and review windows are closing.");
            await Shutdown();
        }
        catch (Exception error)
        {
            petScheduleTimer?.Stop(); petSchedule?.Dispose();
            if (assistant is not null)
            {
                var browser = (ReadingBrowser)typeof(BanbanVoiceWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant)!;
                if (browser.Core is not null)
                {
                    File.WriteAllText(Path.Combine(output, "failure-host.json"), JsonSerializer.Serialize(new {
                        pageReady = typeof(BanbanVoiceWindow).GetField("_pageReady", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant),
                        authorized = typeof(BanbanVoiceWindow).GetField("_authorized", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant),
                        suspended = typeof(BanbanVoiceWindow).GetField("_suspended", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(assistant)
                    }));
                    File.WriteAllText(Path.Combine(output, "failure-ui.json"), await browser.Core.ExecuteScriptAsync("JSON.stringify({url:location.href,bridge:!!window.chrome?.webview,host:!!window.ICeClassVoiceHost,voice:!!window.ICeClassBanbanVoice,mic:!!document.querySelector('.bb-voice-button'),caption:document.querySelector('.bb-privacy')?.textContent,body:document.querySelector('#banbanRoot')?.innerText,scripts:[...document.scripts].map(s=>s.src)})"));
                    await using var failureImage = File.Create(Path.Combine(output,"failure-ui.png"));
                    await browser.Core.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png,failureImage);
                }
            }
            File.WriteAllText(Path.Combine(output, "review-summary.json"), JsonSerializer.Serialize(new {completed=false,error=error.ToString(),checks}, new JsonSerializerOptions {WriteIndented=true}));
            Console.Error.WriteLine(error);
            assistant?.Shutdown(); if (receiver is not null) await receiver.StopAsync(); tray?.Dispose(); speech?.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(1);
        }
    }
}

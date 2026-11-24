using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

/// <summary>Open the classroom pet with an isolated acceptance binding.</summary>
internal static class CardQuizReview
{
    internal static void Run(string bindingPath, bool openSetup = false)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var config) || !ReceiverConfig.IsPreview(config))
            throw new InvalidOperationException("Card quiz review requires an explicit loopback preview binding.");
        Open(config, bindingPath, openSetup);
    }

    internal static async Task RunSchoolTestAsync()
    {
        const string className = "纸卡测试班";
        var bindingPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ICeClass", "PaperCardAcceptance", "school-test-binding.json");
        if (!ReceiverConfig.TryRead(bindingPath, out var config) || config.Endpoint != ReceiverConfig.DefaultEndpoint ||
            config.ClassName != className || config.DeviceName != "纸卡验收白板")
            throw new InvalidOperationException("请先准备纸卡测试班的专用白板绑定。");

        // Verify the current school assignment before starting a service that can send classroom events.
        using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
            { Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        http.DefaultRequestHeaders.Add("X-ICeClass-Device-Id", config.DeviceId);
        http.DefaultRequestHeaders.Add("X-ICeClass-Class-Id", config.ClassId);
        var room = await http.GetFromJsonAsync<JsonObject>(config.Endpoint + "/api/card-quiz/device/bootstrap");
        if (room?["classId"]?.GetValue<string>() != config.ClassId || room?["className"]?.GetValue<string>() != className)
            throw new InvalidOperationException("学校返回的班级与纸卡测试班不一致。");
        Open(config, bindingPath, openSetup: true);
    }

    private static void Open(ReceiverConfig config, string bindingPath, bool openSetup)
    {
        var bindingKey = $"{ReceiverConfig.NormalizeEndpoint(config.Endpoint)}\n{config.DeviceId}\n{config.ClassId}";
        var scope = @"Local\ICeClass.CardQuizReview." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(bindingKey)))[..24];
        // An early second launch can signal the first even before Avalonia is ready.
        using var showSetup = new EventWaitHandle(false, EventResetMode.AutoReset, scope + ".Setup");
        using var showClassroom = new EventWaitHandle(false, EventResetMode.AutoReset, scope + ".Show", out var first);
        if (!first)
        {
            (openSetup ? showSetup : showClassroom).Set();
            return;
        }
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(bindingPath))!;
                var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
                var voice = new BanbanVoiceWindow(config, () => { }, enabled: false, petPreferencePath: Path.Combine(directory, "pet-preferences.json"));
                var pet = (BanbanPetWindow)typeof(BanbanVoiceWindow).GetField("_pet", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(voice)!;
                desktop.MainWindow = pet;
                pet.PetMenu.AddAction("结束本地试用", "退出", "square", async () =>
                {
                    if (voice.ClassroomHost is { } host && !await host.PrepareToCloseAsync()) return;
                    voice.Shutdown(); CardQuizService.Stop();
                }, visible: () => !pet.ClassroomExpanded);
                if (!voice.TryOpenClassroom()) throw new InvalidOperationException("班班课堂未能展开。");
                var wheel = pet.GetVisualDescendants().OfType<BanbanClassroomWheel>().Single();
                RegisteredWaitHandle Listen(WaitHandle signal, bool setup) =>
                    ThreadPool.RegisterWaitForSingleObject(signal, (_, _) => Dispatcher.UIThread.Post(() =>
                    {
                        if (!voice.TryOpenClassroom() || !setup) return;
                        openSetup = true;
                        wheel.OpenSetup();
                    }), null, Timeout.Infinite, false);
                var classroomListener = Listen(showClassroom, false);
                var setupListener = Listen(showSetup, true);
                pet.Closed += (_, _) => { classroomListener.Unregister(null); setupListener.Unregister(null); };
                var output = Path.Combine(directory, "demo-native-state.json");
                try
                {
                    var browser = pet.ClassroomHost!.Browser;
                    JsonObject snapshot = new();
                    for (var attempt = 0; attempt < 100; attempt++)
                    {
                        await Task.Delay(150);
                        if (browser.Core is not { } core) continue;
                        snapshot = JsonNode.Parse(await core.ExecuteScriptAsync("({title:document.title,className:document.getElementById('class-name')?.textContent,roster:document.getElementById('roster-status')?.textContent,feedback:document.getElementById('feedback')?.textContent,ready:document.getElementById('create-session')?.disabled===false})"))!.AsObject();
                        if (snapshot["ready"]?.GetValue<bool>() == true || snapshot["roster"]?.GetValue<string>().Contains("未结束") == true)
                        {
                            if (openSetup) wheel.OpenSetup();
                            if (!openSetup || wheel.SetupVisible) break;
                        }
                    }
                    snapshot["companionVisible"] = pet.IsVisible;
                    snapshot["expanded"] = pet.ClassroomExpanded;
                    snapshot["setupVisible"] = wheel.SetupVisible;
                    snapshot["originalMascotCount"] = pet.GetVisualDescendants().OfType<BanbanPetMascot>().Count();
                    snapshot["visibleWindows"] = desktop.Windows.Count(w => w.IsVisible);
                    snapshot["width"] = pet.Width;
                    snapshot["height"] = pet.Height;
                    await File.WriteAllTextAsync(output, snapshot.ToJsonString());
                    Console.WriteLine("Card quiz local review opened; page state: " + output);
                    Console.WriteLine($"Window position: {pet.Position}; size: {pet.Width} x {pet.Height}");
                }
                catch (Exception error)
                { await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = error.Message })); }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

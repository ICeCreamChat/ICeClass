using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

/// <summary>Review the real classroom module and original pet using an isolated loopback binding.</summary>
internal static class CardQuizReview
{
    internal static void Run(string bindingPath)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var config) || !ReceiverConfig.IsPreview(config))
            throw new InvalidOperationException("Card quiz review requires an explicit loopback preview binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(bindingPath))!;
                var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
                var voice = new BanbanVoiceWindow(config, () => { }, enabled: false, petPreferencePath: Path.Combine(directory, "pet-preferences.json"));
                var pet = (BanbanPetWindow)typeof(BanbanVoiceWindow).GetField("_pet", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(voice)!;
                desktop.MainWindow = pet;
                var exit = new MenuItem { Header = "结束本地试用" };
                exit.Click += async (_, _) =>
                {
                    if (voice.ClassroomHost is { } host && !await host.PrepareToCloseAsync()) return;
                    voice.Shutdown(); CardQuizService.Stop();
                };
                var talk = (Button)typeof(BanbanPetWindow).GetField("_talk", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(pet)!;
                talk.ContextMenu!.Items.Add(exit);
                voice.SetClassroomExpanded(true);
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
                        if (snapshot["ready"]?.GetValue<bool>() == true || snapshot["roster"]?.GetValue<string>().Contains("未结束") == true) break;
                    }
                    snapshot["companionVisible"] = pet.IsVisible;
                    snapshot["expanded"] = pet.ClassroomExpanded;
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

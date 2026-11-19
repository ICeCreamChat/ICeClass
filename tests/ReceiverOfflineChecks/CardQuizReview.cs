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
    internal static void Run(string bindingPath, bool companion = false)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var config) || !ReceiverConfig.IsPreview(config))
            throw new InvalidOperationException("Card quiz review requires an explicit loopback preview binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(bindingPath))!;
                var window = new CardQuizWindow(config) { Title = "纸卡答题 · 隔离本地验收" };
                var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
                desktop.MainWindow = window;
                BanbanVoiceWindow? voice = null;
                BanbanPetWindow? pet = null;
                if (companion)
                {
                    voice = new BanbanVoiceWindow(config, () => { }, enabled: false, petPreferencePath: Path.Combine(directory, "pet-preferences.json"));
                    pet = (BanbanPetWindow)typeof(BanbanVoiceWindow).GetField("_pet", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(voice)!;
                    voice.ClassroomRequested += async () => await window.StartInBackgroundAsync();
                    voice.ClassroomActionRequested += window.ActivateCompanionAction;
                    window.CompanionStateChanged += voice.SetClassroomState;
                    window.CompanionModeRequested += (enabled, expanded) => voice.SetClassroomExpanded(enabled && expanded);
                    var exit = new MenuItem { Header = "结束本地试用" };
                    exit.Click += (_, _) => window.Close();
                    var talk = (Button)typeof(BanbanPetWindow).GetField("_talk", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(pet)!;
                    talk.ContextMenu!.Items.Add(exit);
                    voice.SetClassroomExpanded(true);
                }
                else { window.Show(); window.Activate(); }
                window.Closed += (_, _) => { voice?.Shutdown(); CardQuizService.Stop(); };
                var output = Path.Combine(directory, "demo-native-state.json");
                try
                {
                    var browser = (ReadingBrowser)typeof(CardQuizWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
                    JsonObject snapshot = new();
                    for (var attempt = 0; attempt < 100; attempt++)
                    {
                        await Task.Delay(150);
                        if (browser.Core is not { } core) continue;
                        snapshot = JsonNode.Parse(await core.ExecuteScriptAsync("({title:document.title,className:document.getElementById('class-name')?.textContent,roster:document.getElementById('roster-status')?.textContent,feedback:document.getElementById('feedback')?.textContent,ready:document.getElementById('create-session')?.disabled===false})"))!.AsObject();
                        if (snapshot["ready"]?.GetValue<bool>() == true && (!companion || window.CompanionState is not null)) break;
                    }
                    snapshot["companionVisible"] = pet?.IsVisible == true;
                    snapshot["expanded"] = pet?.ClassroomExpanded == true;
                    snapshot["originalMascotCount"] = pet?.GetVisualDescendants().OfType<BanbanPetMascot>().Count() ?? 0;
                    snapshot["workbenchVisible"] = window.IsVisible;
                    snapshot["width"] = pet?.Width ?? window.Width;
                    snapshot["height"] = pet?.Height ?? window.Height;
                    await File.WriteAllTextAsync(output, snapshot.ToJsonString());
                    Console.WriteLine("Card quiz local review opened; page state: " + output);
                    Console.WriteLine($"Window position: {pet?.Position ?? window.Position}; size: {pet?.Width ?? window.Width} x {pet?.Height ?? window.Height}");
                }
                catch (Exception error)
                { await File.WriteAllTextAsync(output, JsonSerializer.Serialize(new { error = error.Message })); }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

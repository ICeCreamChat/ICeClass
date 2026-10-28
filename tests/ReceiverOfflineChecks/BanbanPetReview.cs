using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class BanbanPetReview
{
    internal static void Playground(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() =>
        {
            output = Path.GetFullPath(output); Directory.CreateDirectory(output);
            var talks = 0; var opens = 0; var stops = 0; var enabled = true;
            BanbanPetWindow? pet = null;
            void Save() => File.WriteAllText(Path.Combine(output, "interaction.json"), JsonSerializer.Serialize(new
                { talks, opens, stops, enabled, x = pet?.Position.X, y = pet?.Position.Y, visible = pet?.IsVisible }));
            pet = new BanbanPetWindow(() => { opens++; pet!.SetCaption("对话入口已触发", false); Save(); },
                () => { talks++; pet!.Present(new("state", State: "listening", Enabled: enabled)); Save(); },
                () => { stops++; pet!.Present(new("cancel")); Save(); },
                value => { enabled = value; pet!.Present(new("state", State: value ? "standby" : "off", Enabled: value)); Save(); },
                Path.Combine(output, "pet-preferences.json")) { Title = "班班 · 桌宠交互验收", ShowInTaskbar = true };
            // Only this fixture is discoverable in the taskbar; the production pet has no taskbar entry.
            pet.ShowPet(true); pet.Present(new("state", State: "standby", Enabled: true));
            pet.PositionChanged += (_, _) => Save();
            var button = pet.GetVisualDescendants().OfType<Button>().Single(b => b.Name == "BanbanPetTalk");
            var exit = new MenuItem { Header = "结束交互验收" };
            exit.Click += (_, _) => { pet.Shutdown(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); };
            button.ContextMenu!.Items.Add(exit); Save();
        }))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? pet = null;
        void Check(bool value, string name) { if (!value) throw new Exception(name); checks.Add(name); }
        try
        {
            var type = typeof(BanbanVoiceWindow).Assembly.GetType("ICeClass.Receiver.BanbanPetWindow");
            Check(type is not null, "a native desktop companion is provided by the existing receiver");
            var opens = 0; var talks = 0; var cancels = 0; bool? enabled = null;
            var preference = Path.Combine(output, "pet-preferences.json");
            pet = (Window)Activator.CreateInstance(type!, BindingFlags.Instance | BindingFlags.NonPublic, null,
                [new Action(() => opens++), new Action(() => talks++), new Action(() => cancels++),
                 new Action<bool>(value => enabled = value), preference], null)!;
            void Call(string method, params object[] args) => type!.GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, args);
            Call("ShowPet", true);
            await Task.Delay(150);
            Check(pet.IsVisible && !pet.ShowInTaskbar && pet.Topmost && !pet.ShowActivated, "pet stays visible without a taskbar entry or focus stealing");
            Check(pet.Width <= 72 && pet.Height <= 88, "standby is a small companion docked to a screen edge");
            Check(pet.SystemDecorations == SystemDecorations.None && pet.Background is ISolidColorBrush { Color.A: 0 }, "pet has transparent native chrome");
            var button = pet.GetVisualDescendants().OfType<Button>().Single(b => b.Name == "BanbanPetTalk");
            var mascot = pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single();
            Check(!mascot.AnimationRunning && !pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.IsEffectivelyVisible),
                "the docked companion has no persistent label or idle animation loop");
            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Check(talks == 1, "one click reaches the existing conversation callback once");
            Check(pet.Width > 72, "clicking the docked companion reveals its existing conversation state");
            button.Focus();
            var beforeMove = pet.Position;
            button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Up });
            Check(pet.Position.Y < beforeMove.Y && talks == 1, "keyboard movement does not trigger conversation");
            var menu = button.ContextMenu!;
            var open = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "打开对话"));
            open.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(opens == 1, "the companion can open the existing chat");
            Call("Present", new BanbanVoiceEvent("state", "您说，我在听", "listening", true));
            Check(pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "我在听"), "listening has a concise visible state");
            Call("Present", new BanbanVoiceEvent("state", "正在处理…", "thinking", true));
            var stop = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "停止操作"));
            stop.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(cancels == 1, "stop reaches the existing operation cancellation callback");
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            Call("SetCaption", "已完成任务。", false);
            await Task.Delay(80);
            Check(pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "已完成任务。"), "a committed answer can appear next to the companion");
            var bubble = pet.GetVisualDescendants().OfType<Button>().Single(b => b != button);
            pet.Width = 260; Call("ArrangeCompanion", true);
            await Task.Delay(80);
            Check(bubble.Bounds.Right <= button.Bounds.X && button.Bounds.Right <= pet.ClientSize.Width,
                "caption and character remain separate and visible in a narrow layout");
            pet.Width = 350; Call("ArrangeCompanion", true);
            Check(mascot.AssetsLoaded && mascot.AnimationRunning == mascot.Animate, "the existing artwork follows the system motion preference");
            mascot.Animate = false;
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            Check(!mascot.AnimationRunning, "reduced motion stops the animation timer");
            await Task.Delay(100);
            using (var bitmap = new RenderTargetBitmap(new PixelSize(700, 408), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "companion.png")); }
            var mute = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "暂停语音"));
            mute.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(enabled == false, "microphone pause reaches the shared voice setting");
            Call("HidePet");
            Check(!pet.IsVisible && !mascot.AnimationRunning && File.Exists(preference), "hiding persists the companion preference and stops drawing without closing voice");
            Call("ShowPet", false);
            Check(!pet.IsVisible, "background events respect a user's hidden companion");
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(!pet.IsVisible, "voice wake respects a companion explicitly hidden by its user");
            Call("ShowPet", true);
            Check(pet.IsVisible, "tray recovery can restore a hidden companion");
            Call("Suspend", true);
            Check(!pet.IsVisible, "lock and sleep hide the companion without changing its preference");
            Call("Suspend", false);
            Check(pet.IsVisible, "unlock restores a companion that was not hidden by its user");
            Call("Present", new BanbanVoiceEvent("state", "等候你好班班", "standby", true));
            Check(pet.Width <= 72 && !mascot.AnimationRunning, "returning to voice standby docks the character and stops drawing");
            Call("SetInClass", true);
            Check(!pet.IsVisible && !mascot.AnimationRunning, "class time hides the resting companion without changing microphone state");
            using (var saved = JsonDocument.Parse(File.ReadAllText(preference)))
                Check(saved.RootElement.GetProperty("Visible").GetBoolean(), "automatic classroom hiding does not overwrite the user's visibility preference");
            Call("Present", new BanbanVoiceEvent("partial", "旁边人的说话"));
            Check(!pet.IsVisible, "unaccepted background partial speech cannot reveal the hidden classroom companion");
            mascot.Animate = true;
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(pet.IsVisible && pet.Width > 72 && !pet.ShowActivated, "voice wake reveals the companion during class without stealing focus");
            await Task.Delay(70);
            using (var bitmap = new RenderTargetBitmap(new PixelSize(700, 408), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "wake-early.png")); }
            await Task.Delay(180);
            using (var bitmap = new RenderTargetBitmap(new PixelSize(700, 408), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "wake-hop.png")); }
            await Task.Delay(420);
            using (var bitmap = new RenderTargetBitmap(new PixelSize(700, 408), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "wake-settled.png")); }
            Call("Suspend", true);
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(!pet.IsVisible && !mascot.AnimationRunning, "voice events cannot reveal or animate a companion while Windows is locked");
            Call("Present", new BanbanVoiceEvent("state", "等候你好班班", "standby", true));
            Call("Suspend", false);
            Check(!pet.IsVisible, "unlock during class restores classroom hiding");
            Call("SetInClass", false);
            Check(pet.IsVisible && pet.Width <= 72 && !mascot.AnimationRunning, "the end of class restores the small docked companion");
            await Task.Delay(80);
            using (var bitmap = new RenderTargetBitmap(new PixelSize(144, 176), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "docked.png")); }
            Call("Present", new BanbanVoiceEvent("wake"));
            await Task.Delay(6500);
            Call("Present", new BanbanVoiceEvent("partial", "请打开课件"));
            await Task.Delay(6500);
            Check(pet.IsVisible && pet.Width > 72, "continued speech keeps the companion expanded past the original idle deadline");
            await Task.Delay(6500);
            Check(pet.IsVisible && pet.Width <= 72 && !mascot.AnimationRunning,
                "twelve seconds without further speech returns the companion to its small docked state");
            Check(BanbanPetWindow.Constrain(new PixelPoint(-5000, 5000), new PixelRect(-1920, -100, 1920, 1040), new Size(350, 204), 1.5)
                == new PixelPoint(-1920, 634), "position clamping respects negative monitor coordinates and display scaling");
            var moved = new PixelPoint(pet.Position.X - 10, pet.Position.Y - 10);
            pet.Position = moved;
            Call("HidePet");
            using (var saved = JsonDocument.Parse(File.ReadAllText(preference)))
                Check(saved.RootElement.GetProperty("X").GetInt32() == moved.X && !saved.RootElement.GetProperty("Visible").GetBoolean(), "position and hidden state are saved together");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} desktop pet checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            if (pet is not null) pet.GetType().GetMethod("Shutdown", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, null);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

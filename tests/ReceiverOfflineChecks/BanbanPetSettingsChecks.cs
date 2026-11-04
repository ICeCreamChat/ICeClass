using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using SkiaSharp;

internal static class BanbanPetSettingsChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var preference = Path.Combine(output, "preferences.json");
        BanbanPetWindow? pet = null;
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name); Console.WriteLine("PASS " + name);
        }
        async Task Open()
        {
            pet = new BanbanPetWindow(() => { }, () => { }, () => { }, _ => { }, preference) { Opacity = 0 };
            pet.ShowPet(true);
            await Task.Delay(80);
            Field<BanbanPetMascot>(pet, "_mascot").Animate = false;
        }
        SKBitmap Render(int dpi)
        {
            using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet!.Width * dpi / 96),
                (int)Math.Ceiling(pet.Height * dpi / 96)), new Vector(dpi, dpi));
            bitmap.Render((Visual)pet.Content!);
            using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
            return SKBitmap.Decode(stream);
        }
        void Capture(string name, int dpi)
        {
            using var source = Render(dpi);
            using var paper = new SKBitmap(source.Width, source.Height);
            using (var canvas = new SKCanvas(paper)) { canvas.Clear(SKColor.Parse("#075AC6")); canvas.DrawBitmap(source, 0, 0); }
            using var image = SKImage.FromBitmap(paper);
            using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
            using var file = File.Create(Path.Combine(output, name + ".png")); encoded.SaveTo(file);
        }
        try
        {
            await Open();
            var screen = pet!.Screens.Primary!;
            Check(pet.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right,
                "a fresh companion starts at the primary screen's right edge");
            pet.Present(new("wake")); pet.SetCaption("我在，请说。", false);
            await Task.Delay(80);
            foreach (var dpi in new[] { 96, 144, 192 }) Capture("default-" + dpi, dpi);
            var talk = Field<Button>(pet, "_talk");
            var sizeItem = talk.ContextMenu!.Items.OfType<MenuItem>().SingleOrDefault(i => Equals(i.Header, "大小"));
            Check(sizeItem is not null, "the pet context menu exposes a discoverable size control");
            sizeItem!.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            await Task.Delay(100);
            var slider = Field<Slider>(pet, "_sizeSlider");
            var flyout = Field<Flyout>(pet, "_sizeFlyout");
            Check(flyout.IsOpen && slider.Minimum == 25 && slider.Maximum == 150 && slider.Value == 80
                && !string.IsNullOrWhiteSpace(AutomationProperties.GetName(slider)),
                "the keyboard-accessible size slider opens at 80% with a 25% to 150% range");
            var mascot = Field<BanbanPetMascot>(pet, "_mascot");
            var bottom = pet.Position.Y + (int)Math.Ceiling(pet.Height * screen.Scaling);
            var panelPosition = slider.PointToScreen(default);
            foreach (var size in new[] { 25, 50, 100, 150 })
            {
                slider.Value = size; await Task.Delay(80);
                Check(Math.Abs(mascot.Bounds.Width - 116 * size / 100d) <= .5 / screen.Scaling + .01
                    && Math.Abs(mascot.Bounds.Height - 130 * size / 100d) <= .5 / screen.Scaling + .01,
                    $"{size}% updates the actual painted character layout immediately ({mascot.Bounds}, requested {mascot.Width}×{mascot.Height}, slider {slider.Value})");
                Check(Field<TextBlock>(pet, "_caption").FontSize == 14 && Field<TextBlock>(pet, "_label").FontSize == 13,
                    $"{size}% preserves readable caption and state text sizes");
                Check(pet.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right
                    && pet.Position.Y + (int)Math.Ceiling(pet.Height * screen.Scaling) == bottom,
                    $"{size}% keeps the companion's right and bottom anchors (position {pet.Position}, size {pet.Width}×{pet.Height}, scale {screen.Scaling}, work {screen.WorkingArea}, bottom {bottom})");
                Check(talk.Bounds.Width >= 44 && talk.Bounds.Height >= 44 && talk.Bounds.Right <= pet.Width + .1,
                    $"{size}% retains a usable click target inside the window");
                Check(slider.PointToScreen(default) == panelPosition,
                    $"{size}% keeps the size panel stationary during a continuous drag");
                foreach (var dpi in new[] { 96, 144, 192 }) Capture("size-" + size + "-" + dpi, dpi);
            }
            slider.Focus();
            slider.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Left });
            await Task.Delay(50);
            Check(slider.Value < 150 && Field<bool>(pet, "_right")
                && pet.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right
                && pet.Position.Y + (int)Math.Ceiling(pet.Height * screen.Scaling) == bottom,
                "slider arrow keys adjust size without moving the companion to another edge");
            void CheckPanelGap(string name)
            {
                var popup = TopLevel.GetTopLevel(slider)!;
                var gap = mascot.PointToScreen(default).X - popup.PointToScreen(new Point(popup.Bounds.Width, 0)).X;
                Check(gap >= 0 && gap <= 32 * screen.Scaling, $"{name} keeps the open size panel close to the character without covering it ({gap}px gap)");
            }
            CheckPanelGap("keyboard resizing");
            var reset = ((Control)flyout.Content!).GetVisualDescendants().OfType<Button>().Single(b => Equals(b.Content, "恢复默认"));
            reset.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(50);
            Check(slider.Value == 80 && Math.Abs(mascot.Width - 92.8) < .01, "restore default returns the live character and slider to 80%");
            CheckPanelGap("restoring the default size");
            slider.Value = 25; flyout.Hide(); await Task.Delay(30);
            var captionButton = Field<Button>(pet, "_captionButton");
            void InspectArtwork(string name, int dpi, bool right)
            {
                using var pixels = Render(dpi);
                var painted = 0; var unreachable = 0;
                for (var y = 0; y < pixels.Height; y++) for (var x = 0; x < pixels.Width; x++)
                {
                    if (pixels.GetPixel(x, y).Alpha <= 200) continue;
                    painted++;
                    if (!talk.Bounds.Contains(new Point((x + .5) * 96 / dpi, (y + .5) * 96 / dpi))) unreachable++;
                }
                Check(painted > 20 && unreachable == 0,
                    $"{name}/{dpi}dpi keeps the visible character and hands clickable ({unreachable} unreachable pixels)");
                Check(Enumerable.Range(0, pixels.Height).All(y => pixels.GetPixel(right ? 0 : pixels.Width - 1, y).Alpha < 10),
                    $"{name}/{dpi}dpi keeps breathing room at the inward canvas edge");
                Capture(name + "-" + dpi, dpi);
            }
            foreach (var side in new[] { Key.Left, Key.Right }) foreach (var size in new[] { 25, 150 })
            {
                slider.Value = size; talk.Focus();
                talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = side });
                pet.Present(new("wake"));
                pet.SetCaption("等差数列的前 n 项和，等于首项与末项的和乘以项数，再除以二。", false);
                await Task.Delay(60);
                var right = side == Key.Right;
                Check(captionButton.Bounds.Top >= 0 && captionButton.Bounds.Bottom <= pet.Height
                    && (right ? captionButton.Bounds.Right <= talk.Bounds.Left : captionButton.Bounds.Left >= talk.Bounds.Right),
                    $"{side}/{size}% keeps long readable captions inside the window and separate from the character");
                Capture($"long-{side}-{size}", 144);
                captionButton.IsVisible = false;
                foreach (var peek in new[] { .8, .5, .2, 0d })
                {
                    Field<IslandSpring>(pet, "_dock").Snap(peek);
                    typeof(BanbanPetWindow).GetMethod("ArrangeCompanion", Private)!.Invoke(pet, [right]); pet.UpdateLayout();
                    InspectArtwork($"wake-{side}-{size}-{peek:0.0}", 144, right);
                }
                pet.Present(new("state", State: "off", Enabled: false)); await Task.Delay(40);
                foreach (var dpi in new[] { 96, 144, 192 }) InspectArtwork($"docked-{side}-{size}", dpi, right);
            }
            slider.Value = 25; talk.Focus();
            talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Right });
            using (var saved = JsonDocument.Parse(File.ReadAllText(preference)))
                Check(saved.RootElement.GetProperty("SizePercent").GetInt32() == 25
                    && saved.RootElement.GetProperty("Right").GetBoolean(), "size and explicit docking side persist automatically");
            pet.Shutdown(); await Open();
            Check(Field<BanbanPetMascot>(pet!, "_mascot").Width == 29,
                "reopening restores the smallest size instead of reverting to the 80% default");
            talk = Field<Button>(pet!, "_talk"); talk.Focus();
            talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Left });
            Check(pet!.Position.X == screen.WorkingArea.X, "the user can still explicitly dock the companion on the left");
            pet.Shutdown(); await Open();
            Check(pet!.Position.X == screen.WorkingArea.X && !Field<bool>(pet, "_right"),
                "a user-selected left edge survives a restart");
            pet.Shutdown();
            File.WriteAllText(preference, JsonSerializer.Serialize(new { Visible = true, X = screen.WorkingArea.X + 20,
                Y = screen.WorkingArea.Y + 100, Right = true, Vertical = .4, SizePercent = 150 }));
            await Open();
            Check(pet!.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right,
                "saved right docking wins over a stale horizontal coordinate after a display change");
            Check(Math.Abs(pet.Position.Y - (screen.WorkingArea.Y + .4 * (screen.WorkingArea.Height - pet.Height * screen.Scaling))) <= 1,
                "saved vertical placement adapts to the current working-area size");
            pet.Shutdown();
            File.WriteAllText(preference, "{\"Visible\":true,\"X\":-999999,\"Y\":-999999,\"Right\":false,\"SizePercent\":-5}");
            await Open();
            Check(Field<BanbanPetMascot>(pet!, "_mascot").Width == 29 && Field<bool>(pet!, "_right"),
                "invalid size is clamped and an unavailable saved screen resets to the right edge");
            pet!.Shutdown();
            File.WriteAllText(preference, JsonSerializer.Serialize(new { Visible = true, X = screen.WorkingArea.X,
                Y = screen.WorkingArea.Y + 100, Bottom = screen.WorkingArea.Y + 361 }));
            await Open();
            Check(!Field<bool>(pet!, "_right") && Math.Abs(Field<BanbanPetMascot>(pet!, "_mascot").Width - 92.8) < .01,
                "legacy preferences preserve a valid left position and use the 80% default size");
            pet!.Shutdown();
            File.WriteAllText(preference, "{\"SizePercent\":9999}"); await Open();
            Check(Field<BanbanPetMascot>(pet!, "_mascot").Width == 174,
                "an excessive saved size is limited to 150%");
            talk = Field<Button>(pet!, "_talk"); talk.Focus();
            talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Left });
            talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Home });
            Check(Field<bool>(pet!, "_right") && Field<BanbanPetMascot>(pet!, "_mascot").Width == 174,
                "position reset returns to the right edge without changing the chosen size");
            talk.ContextMenu!.Items.OfType<MenuItem>().Single(i => Equals(i.Header, "大小"))
                .RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent)); await Task.Delay(50);
            pet!.Present(new("leave"));
            Check(!Field<Flyout>(pet, "_sizeFlyout").IsOpen && !pet.IsVisible,
                "departure also closes the size panel with reduced motion");
            pet.Shutdown();
            var blockedParent = Path.Combine(output, "blocked-preference-parent");
            File.WriteAllText(blockedParent, "This file intentionally prevents creating a preferences directory.");
            pet = new BanbanPetWindow(() => { }, () => { }, () => { }, _ => { }, Path.Combine(blockedParent, "pet.json")) { Opacity = 0 };
            pet.ShowPet(true); await Task.Delay(50);
            Field<Slider>(pet, "_sizeSlider").Value = 75; await Task.Delay(30);
            Check(Field<TextBlock>(pet, "_sizeError").IsVisible && Field<BanbanPetMascot>(pet, "_mascot").Width == 87,
                "a failed preference write keeps the live size usable and gives explicit failure feedback");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} pet size and placement checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally { pet?.Shutdown(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
    }
}

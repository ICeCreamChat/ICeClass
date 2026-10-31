using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class BanbanListeningWaveformReview
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;

    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        BanbanPetWindow? pet = null;
        void Check(bool passed, string name)
        {
            if (!passed) throw new InvalidOperationException(name);
            checks.Add(name); Console.WriteLine("PASS " + name);
        }
        try
        {
            var talks = 0;
            pet = new BanbanPetWindow(() => { }, () => talks++, () => { }, _ => { },
                Path.Combine(output, "pet-preferences.json")) { Opacity = 0 };
            pet.ShowPet(true);
            pet.Present(new("state", State: "listening", Enabled: true));
            var button = pet.GetVisualDescendants().OfType<Button>().Single(control => control.Name == "BanbanPetTalk");
            var mascot = Field<BanbanPetMascot>(pet, "_mascot");
            var wave = Field<BanbanListeningWaveform>(pet, "_waveform");
            var label = Field<TextBlock>(pet, "_label");
            var pill = Field<Border>(pet, "_pill");
            var timer = Field<DispatcherTimer>(wave, "_frames");
            double[] Samples() => Field<double[]>(wave, "_samples");
            bool Silent() => Samples().All(level => level == 0) && !timer.IsEnabled;
            void Level(int level) => pet.Present(new("audio-level", Enabled: true, Level: level));
            void State(string state) => pet.Present(new("state", State: state, Enabled: state != "off"));
            void Call(string method, params object[] values) => typeof(BanbanPetWindow).GetMethod(method, Private)!.Invoke(pet, values);
            bool Fits(Control child, Control parent)
            {
                var point = child.TranslatePoint(default, parent);
                return point is { } p && p.X >= -.5 && p.Y >= -.5
                    && p.X + child.Bounds.Width <= parent.Bounds.Width + .5
                    && p.Y + child.Bounds.Height <= parent.Bounds.Height + .5;
            }
            void Capture(string name, int dpi = 192)
            {
                using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet.Width * dpi / 96d),
                    (int)Math.Ceiling(pet.Height * dpi / 96d)), new Vector(dpi, dpi));
                bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, name + ".png"));
            }

            // These are explicit fixture inputs, not a microphone recording or a voice-service simulation.
            mascot.Animate = true; State("listening");
            await Task.Delay(650);
            Check(wave.IsEffectivelyVisible && !label.IsVisible && !Field<Border>(pet, "_dot").IsVisible && Silent(),
                "listening starts with stationary dots and no waveform timer");
            Check(AutomationProperties.GetName(button) == "与班班说话" && AutomationProperties.GetItemStatus(button) == "我在听",
                "the button keeps its accessible action and listening state");
            Check(button.Width == 124 && pet.Height == BanbanPetWindow.SurfaceHeight
                && mascot.Width == 116 && mascot.Height == 130 && Fits(wave, pill) && Fits(pill, button),
                "the waveform fits the existing capsule, button and character footprint");
            Capture("listening-silent-96", 96); Capture("listening-silent-144", 144);

            Level(20); await Task.Delay(80);
            Check(Samples().Max() is >= .19 and <= .21, "a low input produces short bars");
            Level(90); await Task.Delay(120);
            Check(Samples().Max() > .8 && Samples().Max() <= 1, "a louder input produces taller bounded bars");
            foreach (var level in new[] { 80, 20, 45, 100, 30, 60 }) { Level(level); await Task.Delay(150); }
            Check(Samples().Max() - Samples().Min() > .2, "the displayed history follows changes in supplied input");
            Capture("listening-input-history");
            await Task.Delay(450);
            Check(Silent(), "missing input returns every bar to a dot and stops the timer");
            for (var i = 0; i < 4; i++) { Level(0); await Task.Delay(70); }
            Check(Silent(), "ongoing silence does not schedule animation frames");

            Level(80); State("thinking"); Level(100);
            Check(Silent() && !wave.IsVisible && label.IsVisible && label.Text == "处理中",
                "other states retain their text and ignore microphone levels");
            State("listening"); Level(200);
            Check(Samples().Max() == 1, "out-of-range high input is clamped");
            Level(-20); await Task.Delay(450);
            Check(Silent(), "out-of-range low input settles to silence");

            mascot.Animate = false;
            Level(80); var snapshot = Samples().ToArray();
            await Task.Delay(100);
            Check(Samples().SequenceEqual(snapshot) && timer.Interval == TimeSpan.FromMilliseconds(300),
                "reduced motion keeps an input snapshot without continuous interpolation");
            Capture("listening-reduced-motion");
            Level(0);
            Check(Silent(), "reduced motion clears an explicit silence input immediately");
            Level(80); await Task.Delay(450);
            Check(Silent(), "reduced motion also expires a missing input and stops its timeout");

            foreach (var state in new[] { "error", "confirming", "off" })
            {
                State(state); Call("Reveal", false);
                pet.Width = 300; Call("ArrangeCompanion", true);
                await Task.Delay(80);
                Check(label.IsEffectivelyVisible && label.TextLayout.TextLines.Count == 1 && Fits(label, pill)
                    && Fits(pill, button) && Fits(button, pet) && Silent(),
                    $"the {state} label stays on one line within the narrow existing layout");
                Capture("narrow-" + state);
            }

            State("listening"); await Task.Delay(80);
            button.Focus(); var beforeTalks = talks;
            foreach (var key in new[] { Key.Enter, Key.Space })
            {
                button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = key });
                button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyUpEvent, Key = key });
            }
            Check(talks == beforeTalks + 2 && !wave.Focusable && !wave.IsHitTestVisible,
                "Enter and Space retain button activation without adding a waveform focus target");
            var beforeMove = pet.Position; beforeTalks = talks;
            button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Up });
            Check(pet.Position.Y < beforeMove.Y && talks == beforeTalks, "keyboard movement still moves the pet without starting talk");

            Level(80); pet.Hide();
            Check(Silent(), "directly hiding the native window stops the waveform immediately");
            pet.ShowPet(true);
            Check(Silent(), "showing the window never replays old levels");
            Level(80); pet.Suspend(true); Level(100);
            Check(!pet.IsVisible && Silent(), "suspension discards levels and stops the waveform");
            pet.Suspend(false); Level(80); pet.HidePet(); Level(100);
            Check(!pet.IsVisible && Silent(), "an explicitly hidden pet ignores later microphone events");
            pet.ShowPet(true); Level(100);
            Check(!pill.IsVisible && Silent(), "a docked pet never starts a waveform timer");
            State("listening"); Level(80); pet.Shutdown(); Level(100);
            Check(Silent(), "shutdown stops the waveform and rejects subsequent levels");

            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks },
                new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"PASS {checks.Count} listening waveform checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() },
                new JsonSerializerOptions { WriteIndented = true }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            pet?.Shutdown();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

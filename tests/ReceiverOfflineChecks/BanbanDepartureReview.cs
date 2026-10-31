using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class BanbanDepartureReview
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
            var preference = Path.Combine(output, "pet-preferences.json");
            pet = new BanbanPetWindow(() => { }, () => { }, () => { }, _ => { }, preference)
                { Title = "班班 · 退场自动验收" };
            pet.ShowPet(true); pet.Present(new("state", State: "listening", Enabled: true));
            var mascot = Field<BanbanPetMascot>(pet, "_mascot");
            var talk = Field<Button>(pet, "_talk");
            var pill = Field<Border>(pet, "_pill");
            var caption = Field<Button>(pet, "_captionButton");
            var wave = Field<BanbanListeningWaveform>(pet, "_waveform");
            void Wake() => pet.Present(new("wake", Enabled: true));
            void Leave() => pet.Present(new("leave", Enabled: true));
            void Capture(string name)
            {
                using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet.Width * 2),
                    (int)Math.Ceiling(pet.Height * 2)), new Vector(192, 192));
                bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, name + ".png"));
            }
            foreach (var right in new[] { true, false })
            {
                mascot.Animate = true; Wake(); await Task.Delay(700);
                var screen = pet.Screens.ScreenFromWindow(pet) ?? pet.Screens.Primary!;
                pet.Position = new PixelPoint(right ? screen.WorkingArea.Right - (int)(pet.Width * screen.Scaling)
                    : screen.WorkingArea.X, screen.WorkingArea.Y + (int)(100 * screen.Scaling));
                typeof(BanbanPetWindow).GetMethod("Fit", Private)!.Invoke(pet, [true]);
                pet.SetCaption("我在，请说。", false); pet.Present(new("audio-level", Enabled: true, Level: 80));
                var saved = File.ReadAllText(preference);
                Leave();
                Check(pet.IsVisible && mascot.Gesture == "wave" && !caption.IsVisible && !pill.IsVisible,
                    $"{(right ? "right" : "left")}: dismissal starts with a wave and clears bubble and status");
                Check(!Field<DispatcherTimer>(wave, "_frames").IsEnabled, "dismissal stops microphone visualization");
                await Task.Delay(700); Capture(right ? "right-wave" : "left-wave");
                await Task.Delay(800);
                var offset = talk.RenderTransform as TranslateTransform;
                Check(offset is not null && (right ? offset.X > 10 : offset.X < -10) && talk.Opacity is > 0 and < 1,
                    "retreat moves toward the current edge and fades");
                Capture(right ? "right-retreat" : "left-retreat");
                Leave(); // A repeated command must not restart the departure deadline.
                pet.Present(new("state", State: "speaking", Enabled: true));
                pet.Present(new("caption", "旧任务的回答", Enabled: true));
                pet.Present(new("task-result", State: "succeeded", Enabled: true));
                await Task.Delay(850);
                Check(!pet.IsVisible && !mascot.AnimationRunning && !mascot.IdleScheduled,
                    "departure really hides the window and stops character timers");
                Check(File.ReadAllText(preference) == saved, "voice departure preserves the user's pet preference");
                pet.Present(new("state", State: "listening", Enabled: true));
                Check(!pet.IsVisible, "late work state cannot revive a dismissed pet");
                Wake(); await Task.Delay(100);
                Check(pet.IsVisible && pill.IsVisible && talk.Opacity == 1
                    && (talk.RenderTransform is not TranslateTransform t || t.X == 0), "a fresh wake restores the pet");
            }
            Leave(); await Task.Delay(1300); Wake(); await Task.Delay(1100);
            Check(pet.IsVisible && talk.Opacity == 1 && pill.IsVisible,
                "wake during retreat cancels the old hide deadline");
            mascot.Animate = false; Leave();
            Check(!pet.IsVisible && !mascot.AnimationRunning && !mascot.IdleScheduled,
                "reduced motion dismisses immediately without a hidden animation loop");
            Wake(); Check(pet.IsVisible, "reduced motion also allows the next wake");
            mascot.Animate = true; Leave(); pet.Suspend(true); await Task.Delay(2200);
            pet.Suspend(false); Check(!pet.IsVisible, "resume cannot revive a dismissed pet");
            Wake(); Check(pet.IsVisible, "wake still restores the pet after suspend");
            Leave(); pet.Hide();
            Check(!mascot.AnimationRunning && !mascot.IdleScheduled,
                "direct native hide stops all departure animation resources");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks },
                new JsonSerializerOptions { WriteIndented = true }));
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

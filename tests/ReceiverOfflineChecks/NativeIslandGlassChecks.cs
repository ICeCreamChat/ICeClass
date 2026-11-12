using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;

// Exercise the real island, its lightweight panes and the split-capsule gap.
// Render only the island control; no desktop pixels are captured.
internal static class NativeIslandGlassChecks
{
    internal static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static T Field<T>(object target, string name) => (T)target.GetType()
        .GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(target)!;

    private static async Task Check()
    {
        var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        ClassroomIslandWindow? island = null;
        var checks = 0;
        void Assert(bool value, string description)
        {
            if (!value) throw new InvalidOperationException(description);
            checks++; Console.WriteLine("PASS " + description);
        }
        try
        {
            var appearance = new IslandAppearance { Width = 640, OffsetY = 120, HideFullscreen = false };
            var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
            island = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => { });
            var ribbon = Field<ClassroomIslandRibbon>(island, "_ribbon"); ribbon.Animate = false;
            var lesson = new IslandProfile {
                Slots = [new() { Id = "study", Start = 1200, End = 1290 }],
                Lessons = [new() { SlotId = "study", Weekday = 1, Subject = "自主学习" }],
                Reminders = new() { Enabled = false }
            };
            var lessonRibbon = new ClassroomIslandRibbon { Light = true, Glass = true, Animate = false };
            try
            {
                var feedback = new SelfStudyFeedback("listening", "真实声音的本地显示", true);
                lessonRibbon.SetSelfStudyFeedback(feedback);
                lessonRibbon.Present(IslandRibbonPresentation.Build(lesson,
                    new DateTimeOffset(2026, 11, 9, 20, 5, 0, TimeSpan.FromHours(8)), IslandRibbonChecks.View(), selfStudy: feedback));
                lessonRibbon.SetSelfStudyLevel(.5);
                foreach (var width in new[] { 380, 760, 1000 })
                {
                    lessonRibbon.Measure(new Size(width, 48)); lessonRibbon.Arrange(new Rect(0, 0, width, 48));
                    using var renderedLesson = new RenderTargetBitmap(new PixelSize(width, 48), new Vector(96, 96));
                    renderedLesson.Render(lessonRibbon);
                    using var data = new MemoryStream(); renderedLesson.Save(data); data.Position = 0;
                    using var pixels = SKBitmap.Decode(data);
                    var paleOverlay = 0;
                    for (var y = 8; y < 38; y++)
                    for (var x = 0; x < width; x++)
                    {
                        var pixel = pixels.GetPixel(x, y);
                        if (pixel.Alpha > 64 && pixel.Red > 180 && pixel.Green > 180 && pixel.Blue > 180) paleOverlay++;
                    }
                    Assert(paleOverlay == 0, width + ": active glass lesson has no opaque pale plate behind its text");
                }
            }
            finally { lessonRibbon.Dispose(); }
            var companion = Field<IslandShoutCompanion>(island, "_companion"); companion.ReviewSeconds = 2.5;
            Field<IslandBanbanMascot>(island, "_mascot").Animate = false;
            var sequence = 0L;
            foreach (var state in new[] { "timetable", "warning", "urgent", "full", "details", "solid", "restored" })
            {
                var shout = state is "warning" or "urgent" or "full";
                appearance.Material = state == "solid" ? "solid" : "glass";
                appearance.Width = state is "warning" or "full" ? 380 : state is "urgent" or "details" ? 1000 : 640;
                appearance.Theme = state is "urgent" or "restored" ? "dark" : "light";
                appearance.OffsetX = state == "details" ? 40 : 0;
                var notice = shout ? new ClassroomIslandNotice("本机预览", "第三节是实验课，请带好课本和练习册，提前到实验室集合，按学号就座。",
                    state == "urgent" ? "urgent" : "warning", Sequence: ++sequence, AgeSeconds: 5) : null;
                island.Update(IslandRibbonChecks.View(notice), false);
                companion.SetActive(shout, false);
                island.ApplyProfile(appearance, profile, IslandRibbonChecks.At(10, 40), "", "本机验收", false);
                island.SetExpanded(state == "details");
                island.SetShoutExpanded(state == "full");
                island.Show(); island.UpdateLayout(); await Task.Delay(350); island.UpdateLayout();

                Assert(!desktop.Windows.Any(w => w.ActualTransparencyLevel == WindowTransparencyLevel.AcrylicBlur
                    || w.ActualTransparencyLevel == WindowTransparencyLevel.Blur), state + ": no system blur window is allocated");
                Assert(desktop.Windows.Count == 1, state + ": the island owns only one native window");
                var glass = Field<IslandGlassBackdrop>(island, "_glass");
                if (state == "solid")
                {
                    Assert(!glass.IsVisible, "original white material hides the tinted panes");
                    continue;
                }
                Assert(glass.IsVisible, state + ": lightweight glass stays visible");
                using var rendered = new RenderTargetBitmap(new PixelSize((int)glass.Bounds.Width, (int)glass.Bounds.Height), new Vector(96, 96));
                rendered.Render(glass);
                using var image = new MemoryStream(); rendered.Save(image); image.Position = 0;
                using var pixels = SKBitmap.Decode(image);
                var panes = glass.Children.OfType<Border>().Where(p => p.IsVisible).Select(p => p.Bounds).ToArray();
                Assert(panes.Length == (shout || state == "details" ? 1 : 2), state + ": capsules retain their original geometry");
                foreach (var pane in panes)
                {
                    var center = pixels.GetPixel((int)pane.Center.X, (int)pane.Center.Y);
                    Assert(center.Alpha is >= 180 and < 255, state + ": translucent tint keeps the text area legible");
                    if (appearance.Theme == "light") Assert(center.Blue >= center.Red && center.Red > 180, state + ": light material keeps its blue-white palette");
                    else Assert(center.Blue > center.Red && center.Red < 70, state + ": dark material keeps its readable dark-blue tint");
                    Assert(pixels.GetPixel((int)pane.X + 1, (int)pane.Y + 1).Alpha < 80,
                        state + ": rounded corners remain transparent");
                }
                if (panes.Length == 2)
                {
                    var gap = pixels.GetPixel((int)((panes[0].Right + panes[1].Left) / 2), (int)panes[0].Center.Y);
                    Assert(gap.Alpha < 80, state + ": daily capsule gap has no rectangular tint");
                }
                Assert(island.ActualTransparencyLevel == WindowTransparencyLevel.Transparent,
                    state + ": text and Banban remain on a transparent window");
                island.Hide(); await Task.Delay(30);
                Assert(!desktop.Windows.Any(w => w.IsVisible), state + ": hiding leaves no companion backdrop window");
            }
            Assert(typeof(ClassroomIslandWindow).Assembly.GetType("ICeClass.Receiver.IslandGlassLens") is null,
                "the production client no longer ships a continuously sampling lens");
            island.DisposeWindow(); island = null;
            Assert(desktop.Windows.Count == 0, "closing island releases its only native window");
            Console.WriteLine($"{checks} native glass boundary checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { island?.DisposeWindow(); desktop.Shutdown(Environment.ExitCode); }
    }

}

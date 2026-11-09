using System.Reflection;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;

// Read the real Windows blur region: an offscreen bitmap cannot reveal a
// system backdrop leaking into transparent space around the island.
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

                var blurWindows = desktop.Windows.Where(w => w.IsVisible && (w.ActualTransparencyLevel == WindowTransparencyLevel.AcrylicBlur
                    || w.ActualTransparencyLevel == WindowTransparencyLevel.Blur)).ToArray();
                if (state == "solid")
                {
                    Assert(blurWindows.Length == 0, "original material leaves no native blur surface visible");
                    continue;
                }
                Assert(blurWindows.Length > 0, state + ": desktop blur remains enabled inside glass");
                Assert(blurWindows.All(w => w.Opacity <= .25), state + ": clear glass does not replace the backdrop with a full-opacity acrylic veil");
                if (appearance.Theme == "light")
                {
                    var glass = Field<IslandGlassBackdrop>(island, "_glass");
                    // Inspect the real interim material before a captured frame arrives.
                    // The painted tint must stay below 25% opacity in pane interiors.
                    Field<IslandGlassLens>(glass, "_lens").Stop();
                    using var rendered = new RenderTargetBitmap(new PixelSize((int)glass.Bounds.Width, (int)glass.Bounds.Height), new Vector(96, 96));
                    rendered.Render(glass);
                    using var image = new MemoryStream(); rendered.Save(image); image.Position = 0;
                    using var pixels = SKBitmap.Decode(image);
                    var center = pixels.GetPixel((int)(pixels.Width * .8), pixels.Height / 2);
                    Assert(center.Alpha is > 10 and <= 64,
                        state + $": interim light tint stays below 25% opacity (alpha {center.Alpha})");
                    var pane = Field<IslandGlassBackdrop>(island, "_glass").Children.OfType<Border>().Last(p => p.IsVisible);
                    var edge = pixels.GetPixel((int)(pane.Bounds.X + pane.Bounds.Width * .8), (int)pane.Bounds.Y);
                    Assert(edge.Alpha <= 128, state + $": upper glass rim stays translucent instead of a white outline (alpha {edge.Alpha})");
                }
                var panes = Field<IslandGlassBackdrop>(island, "_glass").Children.OfType<Border>()
                    .Where(p => p.IsVisible).Select(p => new Rect(p.TranslatePoint(default, island)!.Value, p.Bounds.Size)).ToArray();
                foreach (var blur in blurWindows)
                {
                    Assert(blur.Position == island.Position && blur.Bounds.Size == island.Bounds.Size,
                        state + ": native blur follows island position and size");
                    Assert(GetWindow(blur.TryGetPlatformHandle()!.Handle, 3) == island.TryGetPlatformHandle()!.Handle,
                        state + ": native blur stays behind text and controls");
                    var region = CreateRectRgn(0, 0, 0, 0);
                    try
                    {
                        Assert(GetWindowRgn(blur.TryGetPlatformHandle()!.Handle, region) > 0,
                            state + ": native blur has a shape instead of covering its rectangular window");
                        bool Blurred(Point point)
                        {
                            var screen = island.PointToScreen(point);
                            return PtInRegion(region, screen.X - blur.Position.X, screen.Y - blur.Position.Y);
                        }
                        foreach (var pane in panes)
                        {
                            Assert(Blurred(pane.Center), state + ": capsule center keeps desktop blur");
                            Assert(!Blurred(pane.TopLeft + new Vector(1, 1)), state + ": rounded corner stays transparent");
                        }
                        Assert(!Blurred(new Point(2, island.Bounds.Height - 2)), state + ": outer padding has no tinted rectangle");
                        if (shout) Assert(!Blurred(new Point(28, island.Bounds.Height - 10)), state + ": space below Banban has no blur");
                        if (panes.Length == 2) Assert(!Blurred(new Point((panes[0].Right + panes[1].Left) / 2, panes[0].Center.Y)),
                            state + ": gap between daily capsules stays transparent");
                    }
                    finally { DeleteObject(region); }
                }
                Assert(island.ActualTransparencyLevel == WindowTransparencyLevel.Transparent,
                    state + ": text and Banban remain on a fully transparent window");
                island.Hide(); await Task.Delay(30);
                Assert(!desktop.Windows.Any(w => w.IsVisible && (w.ActualTransparencyLevel == WindowTransparencyLevel.AcrylicBlur
                    || w.ActualTransparencyLevel == WindowTransparencyLevel.Blur)), state + ": hiding island also hides blur");
            }
            island.DisposeWindow(); island = null;
            Assert(desktop.Windows.Count == 0, "closing island releases its native backdrop window");
            Console.WriteLine($"{checks} native glass boundary checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { island?.DisposeWindow(); desktop.Shutdown(Environment.ExitCode); }
    }

    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("gdi32.dll")] private static extern bool PtInRegion(IntPtr region, int x, int y);
}

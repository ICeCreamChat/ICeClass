using System.Reflection;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;

internal static class NativeIslandRefractionChecks
{
    internal static void Run(string output, bool performance = false) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(output, performance)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static T Field<T>(object target, string name) => (T)target.GetType()
        .GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(target)!;
    private static bool Active(IslandGlassLens lens) => (bool?)lens.GetType()
        .GetProperty("IsActive", BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(lens) == true;

    private static async Task Check(string output, bool performance)
    {
        var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        ClassroomIslandWindow? island = null; Window? source = null, obstruction = null;
        var checks = 0;
        void Assert(bool value, string description)
        { if (!value) throw new InvalidOperationException(description); checks++; Console.WriteLine("PASS " + description); }
        async Task WaitFor(Func<bool> predicate)
        { for (var i = 0; i < 60 && !predicate(); i++) await Task.Delay(50); Assert(predicate(), "capture reaches the expected active state"); }
        try
        {
            Directory.CreateDirectory(output);
            island = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => { });
            var work = island.Screens.Primary!.WorkingArea; var scale = island.Screens.Primary.Scaling;
            source = new Window { Title = "液态玻璃背景验收", Width = work.Width / scale, Height = work.Height / scale,
                Position = work.Position, WindowStartupLocation = WindowStartupLocation.Manual,
                SystemDecorations = SystemDecorations.None, ShowInTaskbar = false, ShowActivated = false, Topmost = true,
                Background = Brush.Parse("#216CA4") };
            source.Show();
            var appearance = new IslandAppearance { Width = 640, OffsetY = 160, HideFullscreen = false, Theme = "light" };
            var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
            Field<ClassroomIslandRibbon>(island, "_ribbon").Animate = false;
            Field<IslandBanbanMascot>(island, "_mascot").Animate = false;
            island.Update(IslandRibbonChecks.View(), false);
            island.ApplyProfile(appearance, profile, IslandRibbonChecks.At(10, 40), "", "本机验收", false);
            island.Show(); island.UpdateLayout();
            var glass = Field<IslandGlassBackdrop>(island, "_glass");
            await Task.Delay(150);
            SetWindowPos(source.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            source.Activate();
            SetWindowPos(island.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            glass.RefreshBlur();
            var member = glass.GetType().GetField("_lens", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert(member is not null, "real island contains the refraction renderer");
            var lens = (IslandGlassLens)member!.GetValue(glass)!;
            var startup = Stopwatch.StartNew();
            await WaitFor(() => Active(lens) && Field<IslandGlassCapture.Source>(lens, "_candidate").Window == source.TryGetPlatformHandle()!.Handle);
            Console.WriteLine($"Initial settled-source first frame: {startup.Elapsed.TotalMilliseconds:F1}ms");
            var selected = Field<IslandGlassCapture.Source>(lens, "_candidate");
            Assert(selected.Window == source.TryGetPlatformHandle()!.Handle, "capture selects the synthetic background window");
            SKColor GlassCenter(string name)
            {
                using var render = new RenderTargetBitmap(new PixelSize((int)glass.Bounds.Width, (int)glass.Bounds.Height), new Vector(96, 96));
                render.Render(glass); render.Save(Path.Combine(output, name + ".png"));
                using var memory = new MemoryStream(); render.Save(memory); memory.Position = 0;
                using var bitmap = SKBitmap.Decode(memory);
                return bitmap.GetPixel(bitmap.Width * 3 / 4, bitmap.Height / 2);
            }
            var blue = GlassCenter("blue");
            Assert(blue.Blue > blue.Red + 40, "sampled background is blue rather than the island's own content");
            Assert(GetWindowDisplayAffinity(island.TryGetPlatformHandle()!.Handle, out var affinity) && affinity == 0,
                "island remains available to screen recording and screen sharing");
            source.Background = Brush.Parse("#E52858");
            await Task.Delay(800);
            var pink = GlassCenter("pink");
            Assert(pink.Red > pink.Blue + 35, "live background changes reach the glass without retaining old pixels");
            var capture = Field<IslandGlassCapture>(lens, "_capture");
            var movedAt = Stopwatch.StartNew();
            source.Background = Brush.Parse("#26944F");
            appearance.OffsetX = 70; appearance.Width = 790;
            island.ApplyProfile(appearance, profile, IslandRibbonChecks.At(10, 40), "", "本机验收", false);
            await WaitFor(() => Active(lens)
                && Field<IslandGlassCapture.Source>(lens, "_candidate").Area.Width > selected.Area.Width + 50
                && Field<SKBitmap>(lens, "_pixels").Width == Field<IslandGlassCapture.Source>(lens, "_candidate").Area.Width);
            var moved = GlassCenter("moved");
            Assert(moved.Green > moved.Red + 25, "moving and resizing samples the new geometry and live green background instead of stale pink pixels");
            Console.WriteLine($"Moved/resized first frame: {movedAt.Elapsed.TotalMilliseconds:F1}ms");
            Assert(ReferenceEquals(capture, Field<IslandGlassCapture>(lens, "_capture")),
                "moving and resizing reuses the capture worker instead of restarting its graphics device");
            obstruction = new Window { Title = "液态玻璃切换背景验收", Width = source.Width, Height = source.Height,
                Position = source.Position, WindowStartupLocation = WindowStartupLocation.Manual,
                SystemDecorations = SystemDecorations.None, ShowInTaskbar = false, ShowActivated = false, Topmost = true,
                Background = Brush.Parse("#D9AF15") };
            obstruction.Show();
            SetWindowPos(island.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            Field<IslandGlassBlurWindow>(glass, "_blur").PlaceBelow(island);
            await WaitFor(() => Active(lens) && Field<IslandGlassCapture.Source>(lens, "_candidate").Window == obstruction.TryGetPlatformHandle()!.Handle);
            var yellow = GlassCenter("replacement");
            Assert(yellow.Red > 180 && yellow.Green > 150 && yellow.Blue < 150, "switching the background window replaces old pixels with the new source");
            Assert(ReferenceEquals(capture, Field<IslandGlassCapture>(lens, "_capture")), "switching a fully covering background also reuses the capture worker");
            obstruction.Close(); obstruction = null;
            await WaitFor(() => Active(lens) && Field<IslandGlassCapture.Source>(lens, "_candidate").Window == source.TryGetPlatformHandle()!.Handle);
            appearance.Material = "solid";
            island.ApplyProfile(appearance, profile, IslandRibbonChecks.At(10, 40), "", "本机验收", false);
            await WaitFor(() => !Active(lens));
            Assert(Field<object?>(lens, "_capture") is null, "original white material releases background capture resources");
            appearance.Material = "glass";
            island.ApplyProfile(appearance, profile, IslandRibbonChecks.At(10, 40), "", "本机验收", false);
            await WaitFor(() => Active(lens));
            island.Hide(); await Task.Delay(100);
            Assert(!Active(lens) && Field<object?>(lens, "_capture") is null, "hidden island stops sampling and releases its capture session");
            island.Show(); await WaitFor(() => Active(lens));
            var area = Field<IslandGlassCapture.Source>(lens, "_candidate").Area;
            obstruction = new Window { Width = area.Width / scale / 3, Height = area.Height / scale + 30,
                Position = area.Position, WindowStartupLocation = WindowStartupLocation.Manual, SystemDecorations = SystemDecorations.None,
                Topmost = true, ShowInTaskbar = false, ShowActivated = false, Background = Brushes.LimeGreen };
            obstruction.Show();
            await Task.Delay(350);
            Assert(SetWindowPos(obstruction.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010), "partial-window fixture is visible above its background");
            SetWindowPos(island.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            Field<IslandGlassBlurWindow>(glass, "_blur").PlaceBelow(island);
            await Task.Delay(200);
            await WaitFor(() => !Active(lens));
            Assert(Field<object?>(lens, "_capture") is null, "partially overlapping backgrounds keep lightweight glass instead of a false desktop image");
            obstruction.Close(); obstruction = null;
            await WaitFor(() => Active(lens));
            if (performance)
            {
                var begin = new TaskCompletionSource();
                var button = new Button { Content = "开始液态玻璃性能验收", HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center,
                    VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center, FontSize = 24, Padding = new Thickness(24) };
                button.Click += (_, _) => begin.TrySetResult();
                source.Content = button; source.ShowInTaskbar = true; source.Activate();
                Console.WriteLine("Ready: activate the synthetic background and click its performance button.");
                await begin.Task;
                await IslandRefractionPerformance.Measure(source, glass, lens, output);
            }
            Console.WriteLine($"{checks} native refraction checks passed. {output}");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { obstruction?.Close(); island?.DisposeWindow(); source?.Close(); desktop.Shutdown(Environment.ExitCode); }
    }

    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}

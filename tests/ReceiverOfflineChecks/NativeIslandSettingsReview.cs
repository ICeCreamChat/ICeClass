using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeIslandSettingsReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Capture(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Capture(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? window = null;
        void Check(bool value, string label)
        {
            if (!value) throw new Exception(label);
            checks.Add(label);
        }
        void Save(Window target, string name)
        {
            foreach (var scale in new[] { 1d, 1.25, 1.5, 2 })
            {
                using var image = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(target.Bounds.Width * scale), (int)Math.Ceiling(target.Bounds.Height * scale)), new Vector(96 * scale, 96 * scale));
                image.Render(target); image.Save(Path.Combine(output, $"{name}-{scale * 100:0}.png"));
            }
        }
        Button FindButton(Window target, string text) => target.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == text);
        async Task Show(Window target)
        {
            window = target; target.Show(); await Task.Delay(80); target.UpdateLayout();
        }
        var school = new IslandAppearance { Width = 640, Theme = "light" };
        var saved = new IslandLocalSettings { Appearance = new() { Width = 560, Theme = "light" },
            AllowedApplications = [@"C:\Classroom Apps\教学工具与课程演示\TeachingTools.exe"],
            RecentActions = ["10月22日 08:00 · 课前提醒 · 已完成", "10月22日 08:40 · 教学工具与课程演示应用 · 已打开"] };
        try
        {
            await Show(new EnrollmentWindow(new ReceiverConfig { Endpoint = "http://127.0.0.1:8838", DeviceId = "local-design-review", ClassName = "高一（1）班", DeviceName = "本机设计预览" }));
            Save(window!, "system-settings-reference"); window!.Close(); window = null;
            foreach (var size in new[] { (440d, 600d), (640d, 700d), (760d, 780d) })
            {
                var settings = new IslandSettingsWindow(saved, school, _ => { }, () => { }, () => { }, () => { }) { Width = size.Item1, Height = size.Item2 };
                await Show(settings);
                Save(settings, $"settings-{size.Item1:0}-top");
                var scroll = settings.GetVisualDescendants().OfType<ScrollViewer>().First(s => s.Content is StackPanel || s.Content is Border);
                scroll.Offset = new Vector(0, scroll.Extent.Height); settings.UpdateLayout();
                Save(settings, $"settings-{size.Item1:0}-bottom");
                var save = FindButton(settings, "保存本机设置"); var point = save.TranslatePoint(default, settings)!.Value;
                Check(point.X >= 0 && point.Y >= 0 && point.X + save.Bounds.Width <= settings.Bounds.Width + .5 && point.Y + save.Bounds.Height <= settings.Bounds.Height + .5,
                    $"{size.Item1:0}: save stays visible while settings scroll");
                Check(settings.GetVisualDescendants().OfType<NumericUpDown>().All(c => { var p = c.TranslatePoint(default, settings)!.Value; return p.X >= 0 && p.X + c.Bounds.Width <= settings.Bounds.Width + .5; }),
                    $"{size.Item1:0}: all appearance inputs fit horizontally");
                settings.Close(); window = null;
            }
            IslandLocalSettings? applied = null;
            var editable = new IslandSettingsWindow(saved, school, value => applied = value, () => { });
            await Show(editable);
            editable.GetVisualDescendants().OfType<NumericUpDown>().First().Value = 420;
            FindButton(editable, "移除").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            FindButton(editable, "取消").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); window = null;
            Check(applied is null && saved.Appearance!.Width == 560 && saved.AllowedApplications.Count == 1, "cancel preserves saved appearance and allowed applications");
            editable = new IslandSettingsWindow(saved, school, value => applied = value, () => { });
            await Show(editable);
            editable.GetVisualDescendants().OfType<NumericUpDown>().First().Value = 420;
            FindButton(editable, "保存本机设置").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); window = null;
            Check(applied?.Appearance?.Width == 420 && saved.Appearance!.Width == 560, "save applies edited values without mutating the original preferences");
            applied = null;
            editable = new IslandSettingsWindow(saved, school, value => applied = value, () => { });
            await Show(editable);
            editable.GetVisualDescendants().OfType<CheckBox>().Single(c => c.Content?.ToString() == "本机使用独立外观").IsChecked = false;
            Check(editable.GetVisualDescendants().OfType<NumericUpDown>().All(c => !c.IsEffectivelyEnabled), "school appearance mode disables local overrides");
            Save(editable, "settings-school-appearance");
            FindButton(editable, "保存本机设置").RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); window = null;
            Check(applied is { Appearance: null } && school.Width == 640, "following school appearance removes the override without changing school settings");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(checks, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} native settings checks passed. {output}");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            window?.Close();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

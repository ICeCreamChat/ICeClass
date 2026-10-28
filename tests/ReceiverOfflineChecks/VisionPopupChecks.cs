using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class VisionPopupChecks
{
    // Read-only metadata for correlating a native popup with the product's
    // observed windows. No pixels, microphone data or input are collected.
    internal static void Diagnose(string output)
    {
        Directory.CreateDirectory(output);
        var allowed = ClassroomAgentPolicy.Load().Available().Where(a => a.Kind.StartsWith("wps-")).ToArray();
        var windows = new List<object>();
        EnumWindows((handle, _) =>
        {
            if (!IsWindowVisible(handle)) return true;
            try
            {
                GetWindowThreadProcessId(handle, out var pid);
                using var process = Process.GetProcessById((int)pid);
                if (!allowed.Any(a => a.MatchesPath(process.MainModule!.FileName))) return true;
                var title = new StringBuilder(240); GetWindowText(handle, title, title.Capacity);
                var type = new StringBuilder(240); GetClassName(handle, type, type.Capacity);
                windows.Add(new { pid, handle = (long)handle, owner = (long)GetWindow(handle, 4),
                    root = (long)GetAncestor(handle, 2), rootOwner = (long)GetAncestor(handle, 3),
                    title = title.ToString(), type = type.ToString(), foreground = GetForegroundWindow() == handle });
            }
            catch (Exception error) when (error is InvalidOperationException or ArgumentException or System.ComponentModel.Win32Exception) { }
            return true;
        }, 0);
        File.WriteAllText(Path.Combine(output, "popup-metadata.json"), JsonSerializer.Serialize(windows, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(windows));
    }

    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var worker = new ClassroomAgentWorker();
        Window? main = null, popup = null;
        void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks.Add(name); }
        try
        {
            using var process = Process.GetCurrentProcess();
            AgentApplication[] apps = [new("popup-fixture", "浮层验收", "application", process.MainModule!.FileName)];
            var openDocument = new Button { Content = "新建文档", HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center };
            main = new Window { Title = "班班浮层测试主窗口", Width = 700, Height = 500, Content = openDocument };
            openDocument.Click += (_, _) => main.Title = "班班浮层测试新文档";
            ClassroomStyle.Apply(main); main.Show();
            var accepted = 0;
            var button = new Button { Content = "新建文字文稿", HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center,
                VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center };
            button.Click += (_, _) => accepted++;
            popup = new Window { Title = "", Width = 320, Height = 200, ShowInTaskbar = false, SystemDecorations = SystemDecorations.None,
                Content = button, WindowStartupLocation = WindowStartupLocation.CenterOwner };
            ClassroomStyle.Apply(popup); popup.Show(main);
            await Task.Delay(200);
            var observed = await worker.InspectAsync(apps, CancellationToken.None);
            var mainId = observed["windows"]!.AsArray().Single(w => w!["title"]!.GetValue<string>() == main.Title)!["id"]!.GetValue<string>();
            var owned = observed["windows"]!.AsArray().Where(w => w?["ownerId"]?.GetValue<string>() == mainId).ToArray();
            Check(owned.Length == 1, "untitled owned popup is observable and associated with its owner");
            var popupId = owned[0]!["id"]!.GetValue<string>();
            var frame = await worker.OperateAsync("capture_window", JsonSerializer.SerializeToElement(new { targetId = popupId }), apps, CancellationToken.None);
            Check(frame["screenshot"]?["targetId"]?.GetValue<string>() == popupId, "popup screenshot is scoped to the actual popup");
            var controls = await worker.OperateAsync("inspect_controls", JsonSerializer.SerializeToElement(new { targetId = popupId }), apps, CancellationToken.None);
            var control = controls["controls"]!.AsArray().Single(c => c?["name"]?.GetValue<string>() == "新建文字文稿");
            await worker.OperateAsync("invoke_control", JsonSerializer.SerializeToElement(new { targetId = popupId, controlId = control!["id"]!.GetValue<string>() }), apps, CancellationToken.None);
            Check(accepted == 1, "popup's actual create button executes exactly once");
            popup.Close();
            // WPS's Qt new-document popup is a foreground top-level window
            // with neither a title nor a Win32 owner.
            popup = new Window { Title = "", Width = 320, Height = 200, ShowInTaskbar = false,
                SystemDecorations = SystemDecorations.None, Content = new TextBlock { Text = "文字 / 演示 / 表格" } };
            ClassroomStyle.Apply(popup); popup.Show(); popup.Activate(); await Task.Delay(150);
            observed = await worker.InspectAsync(apps, CancellationToken.None);
            var activePopup = observed["windows"]!.AsArray().SingleOrDefault(w => w?["foreground"]?.GetValue<bool>() == true);
            Check(activePopup?["isPopup"]?.GetValue<bool>() == true && !string.IsNullOrWhiteSpace(activePopup["title"]?.GetValue<string>()),
                "foreground untitled WPS-style popup is an explicit selectable target");
            var selected = await worker.OperateAsync("capture_window", JsonSerializer.SerializeToElement(new { targetId = mainId }), apps, CancellationToken.None);
            Check(selected["activePopupId"]?.GetValue<string>() == activePopup!["id"]!.GetValue<string>(),
                "main-window capture points to its separately visible application popup");
            popup.Close(); main.Activate(); await Task.Delay(150);
            frame = await worker.OperateAsync("capture_window", JsonSerializer.SerializeToElement(new { targetId = mainId }), apps, CancellationToken.None);
            var buttonCenter = openDocument.PointToScreen(new Point(openDocument.Bounds.Width / 2, openDocument.Bounds.Height / 2));
            var changed = await worker.OperateAsync("click_window", JsonSerializer.SerializeToElement(new { targetId = mainId,
                screenshotId = frame["screenshot"]!["id"]!.GetValue<string>(),
                x = frame["screenshot"]!["width"]!.GetValue<int>() / 2, y = frame["screenshot"]!["height"]!.GetValue<int>() / 2 + 10 }), apps, CancellationToken.None);
            var diagnostic = changed.DeepClone().AsObject();
            diagnostic.Remove("screenshot");
            File.WriteAllText(Path.Combine(output, "click-diagnostic.json"), JsonSerializer.Serialize(new {
                title = main.Title, main.Position, main.ClientSize, main.DesktopScaling,
                buttonCenter, buttonBounds = openDocument.Bounds, result = diagnostic }));
            Check(main.Title == "班班浮层测试新文档" && changed["inputSent"]?.GetValue<bool>() == true,
                "visual action opens the fixture document without repeating the click");
            Check(changed["screenshot"] is null && changed["windows"]!.AsArray().Any(w => w?["title"]?.GetValue<string>() == main.Title),
                "document title change returns the new target rather than an unusable old-target screenshot");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} popup checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.Message }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            worker.Reset(); popup?.Close(); main?.Close();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private delegate bool EnumWindowProc(nint handle, nint state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, nint state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint handle);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint handle, uint command);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint handle, uint flags);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint handle, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint handle, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint handle, StringBuilder text, int count);
}

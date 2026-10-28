using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeComputerControlReview
{
    internal static async Task Seewo(string output)
    {
        Directory.CreateDirectory(output);
        var policy = ClassroomAgentPolicy.Load();
        var app = policy.Available().First(a => a.Kind == "seewo");
        var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:8863", DeviceId = "local-seewo-review", ClassId = "local-seewo-review" };
        using var agent = new ClassroomAgentService(() => policy);
        async Task<JsonObject> Send(object parameters)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return await agent.ExecuteAsync(JsonSerializer.SerializeToElement(new {
                commandId = Guid.NewGuid().ToString(), deviceId = config.DeviceId, classId = config.ClassId,
                issuedAt = now, expiresAt = now + 25000, parameters }), config, CancellationToken.None);
        }
        var opened = await Send(new { action = "open_app", appId = app.Id });
        File.WriteAllText(Path.Combine(output, "seewo-open.json"), opened.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        if (opened["success"]?.GetValue<bool>() != true || opened["result"]?["verified"]?.GetValue<bool>() != true)
            throw new Exception("Seewo's real application window was not observed after launch: " + opened["error"]);
        var state = await Send(new { action = "inspect" });
        var windows = state["result"]!["windows"]!.AsArray().Where(w => w?["appId"]?.GetValue<string>() == app.Id).ToArray();
        if (windows.Length == 0) throw new Exception("The launched Seewo window was lost on fresh inspection.");
        // This review may close a login window, never an open lesson.
        var login = windows.SingleOrDefault(w => w?["title"]?.GetValue<string>() == "希沃白板");
        if (login is null) { Console.WriteLine("Seewo launch and fresh inspection passed; existing lesson left open."); return; }
        var controls = await Send(new { action = "inspect_controls", targetId = login["id"]!.GetValue<string>() });
        File.WriteAllText(Path.Combine(output, "seewo-controls.json"), controls.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var closed = await Send(new { action = "close_window", targetId = login["id"]!.GetValue<string>() });
        File.WriteAllText(Path.Combine(output, "seewo-close.json"), closed.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        if (closed["success"]?.GetValue<bool>() != true || closed["result"]?["verified"]?.GetValue<bool>() != true)
            throw new Exception("Seewo login window did not close: " + closed["error"]);
        Console.WriteLine("Seewo: real launch, fresh window inspection and close passed. Published controls: " + controls["result"]?["controls"]?.AsArray().Count);
    }

    internal static async Task Snapshot(string output)
    {
        Directory.CreateDirectory(output);
        var apps = ClassroomAgentPolicy.Load().Available();
        var worker = new ClassroomAgentWorker();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var state = await worker.InspectAsync(apps, timeout.Token);
            state["applications"] = JsonSerializer.SerializeToNode(apps);
            File.WriteAllText(Path.Combine(output, "snapshot.json"), state.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Snapshot: {state["windows"]!.AsArray().Count} allowed windows, {apps.Count} installed applications.");
        }
        finally { worker.Reset(); }
    }

    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Capture(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Capture(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? window = null;
        var worker = new ClassroomAgentWorker();
        void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        JsonElement Args(object value) => JsonSerializer.SerializeToElement(value);
        try
        {
            using var process = Process.GetCurrentProcess();
            var executable = process.MainModule!.FileName;
            var shortPath = new StringBuilder(1024);
            GetShortPathName(executable, shortPath, shortPath.Capacity);
            IReadOnlyList<AgentApplication> apps = [new("fixture", "本地验收窗口", "application", shortPath.Length > 0 ? shortPath.ToString() : executable)];
            foreach (var (width, height) in new[] { (700d, 760d), (440d, 600d) })
            {
                var policy = new ClassroomAgentPolicy { AllowAllFolders = false, Folders = [@"C:\教学课件\高一数学与跨学科主题学习\2026年秋季课程示例文件夹"] };
                using var agent = new ClassroomAgentService();
                window = new ComputerControlSettingsWindow(agent, null, policy) { Width = width, Height = height };
                window.Show(); await Task.Delay(150); window.UpdateLayout();
                var fileAccess = window.GetVisualDescendants().OfType<CheckBox>().Single(c => c.Name == "AllowAllFolders");
                var selectedFolder = window.GetVisualDescendants().OfType<TextBlock>().Single(t => t.Text == policy.Folders[0]);
                fileAccess.IsChecked = true;
                Check(!selectedFolder.IsEffectivelyVisible, $"{width}: global file access hides the selected-folder controls");
                fileAccess.BringIntoView();
                await Task.Delay(100); window.UpdateLayout();
                using (var accessImage = new RenderTargetBitmap(new PixelSize((int)width, (int)height), new Vector(96, 96)))
                { accessImage.Render(window); accessImage.Save(Path.Combine(output, $"file-access-{width:0}.png")); }
                fileAccess.IsChecked = false;
                Check(selectedFolder.IsEffectivelyVisible, $"{width}: selected-folder access restores its previous folder list");
                var dialog = new Window { Title = "班班临时所属窗口", Width = 320, Height = 180 };
                dialog.Show(window);
                using (var image = new RenderTargetBitmap(new PixelSize((int)width, (int)height), new Vector(96, 96)))
                { image.Render(window); image.Save(Path.Combine(output, $"computer-settings-{width:0}.png")); }
                var save = window.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == "保存本机设置");
                var position = save.TranslatePoint(default, window)!.Value;
                Check(position.X >= 0 && position.X + save.Bounds.Width <= width && position.Y + save.Bounds.Height <= height,
                    $"{width}: save stays visible and fits the window");
                Check(window.GetVisualDescendants().OfType<ScrollViewer>().First().Extent.Width <= width,
                    $"{width}: settings have no horizontal scrolling");
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var state = await worker.InspectAsync(apps, timeout.Token);
                Check(state["windows"]!.AsArray().Any(w => w!["title"]!.GetValue<string>() == dialog.Title),
                    $"{width}: visible owned application windows are included");
                var dialogId = state["windows"]!.AsArray().Single(w => w!["title"]!.GetValue<string>() == dialog.Title)!["id"]!.GetValue<string>();
                var closed = await worker.OperateAsync("close_window", Args(new { targetId = dialogId }), apps, timeout.Token);
                Check(closed["verified"]!.GetValue<bool>() && !dialog.IsVisible,
                    $"{width}: close waits for the selected owned window to disappear");
                var unsaved = new Window { Title = "班班临时未保存窗口", Width = 320, Height = 180 };
                var preserve = true;
                unsaved.Closing += (_, e) => { if (preserve) e.Cancel = true; };
                unsaved.Show(window);
                state = await worker.InspectAsync(apps, timeout.Token);
                var unsavedId = state["windows"]!.AsArray().Single(w => w!["title"]!.GetValue<string>() == unsaved.Title)!["id"]!.GetValue<string>();
                var blocked = await worker.OperateAsync("close_window", Args(new { targetId = unsavedId }), apps, timeout.Token);
                Check(!blocked["verified"]!.GetValue<bool>() && unsaved.IsVisible,
                    $"{width}: a cancelled close preserves the window and cannot report success");
                preserve = false; unsaved.Close();
                Console.WriteLine($"{width}: window enumeration returned.");
                var selected = state["windows"]!.AsArray().Single(w => w!["title"]!.GetValue<string>() == window.Title)!;
                var id = selected["id"]!.GetValue<string>();
                Check(!string.IsNullOrEmpty(id), $"{width}: isolated adapter identifies the exact fixture window");
                var controls = await worker.OperateAsync("inspect_controls", Args(new { targetId = id }), apps, timeout.Token);
                Console.WriteLine($"{width}: selected-window controls returned.");
                var toggle = controls["controls"]!.AsArray().Single(c => c!["name"]!.GetValue<string>().StartsWith("允许有本班操作权限"))!;
                var checkBox = window.GetVisualDescendants().OfType<CheckBox>().First();
                var before = checkBox.IsChecked;
                var result = await worker.OperateAsync("invoke_control", Args(new { targetId = id, controlId = toggle["id"]!.GetValue<string>() }), apps, timeout.Token);
                Check(checkBox.IsChecked != before, $"{width}: UI Automation changes only the selected local checkbox");
                Check(result["verified"]!.GetValue<bool>() == false, $"{width}: invoking a control does not invent a business success receipt");
                foreach (var action in new[] { "maximize_window", "minimize_window", "restore_window", "focus_window" })
                {
                    var changed = await worker.OperateAsync(action, Args(new { targetId = id }), apps, timeout.Token);
                    Check(changed["verified"]!.GetValue<bool>(), $"{width}: {action} verifies the actual window state");
                }
                var launchPolicy = new ClassroomAgentPolicy { AllowAllFolders = false, Applications = [executable] };
                using var launcher = new ClassroomAgentService(() => launchPolicy);
                var launchApp = launchPolicy.Available().Single(a => a.MatchesPath(ClassroomAgentPolicy.ApplicationPath(executable)));
                for (var repetition = 0; repetition < 2; repetition++)
                {
                    window.WindowState = repetition == 0 ? WindowState.Normal : WindowState.Minimized;
                    await Task.Delay(100);
                    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var opened = await launcher.ExecuteAsync(Args(new {
                        commandId = Guid.NewGuid().ToString(), deviceId = "local-window-review", classId = "local-window-review",
                        issuedAt = now, expiresAt = now + 25000,
                        parameters = new { action = "open_app", appId = launchApp.Id } }),
                        new ReceiverConfig { DeviceId = "local-window-review", ClassId = "local-window-review" }, CancellationToken.None);
                    var actual = opened["result"]?["windows"]?.AsArray().Single(w => w?["title"]?.GetValue<string>() == window.Title);
                    File.WriteAllText(Path.Combine(output, $"open-{width:0}-{repetition}.json"), opened.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                    Console.WriteLine($"{width}: open {repetition}, native maximized={actual?["maximized"]}, foreground={actual?["foreground"]}, Avalonia={window.WindowState}, error={opened["error"]}");
                    Check(opened["success"]?.GetValue<bool>() == true && actual?["maximized"]?.GetValue<bool>() == true
                        && actual?["foreground"]?.GetValue<bool>() == true && window.WindowState == WindowState.Maximized,
                        $"{width}: opening an existing {(repetition == 0 ? "normal" : "minimized")} application brings it forward maximized");
                }
                window.Close(); window = null; worker.Reset();
            }
            var inventory = ClassroomAgentPolicy.Load().Available().Select(a => new { a.Name, a.Kind, Version = FileVersionInfo.GetVersionInfo(a.Path).ProductVersion }).ToList();
            File.WriteAllText(Path.Combine(output, "installed-applications.json"), JsonSerializer.Serialize(inventory, new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllText(Path.Combine(output, "native-checks.json"), JsonSerializer.Serialize(checks, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} native computer-control checks passed; installed application inventory: {inventory.Count}.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            window?.Close(); worker.Reset();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetShortPathName(string path, StringBuilder buffer, int size);
}

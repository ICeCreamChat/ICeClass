using System.Diagnostics;
using System.IO.Compression;
using System.IO.Pipes;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

// A real child process and current-user pipe; no camera, WPS, saved binding or network.
internal static class WorkshopLifecycleChecks
{
    private const string Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=";
    internal static void Run(string? package = null) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = package is null ? CheckAsync() : CheckPackageAsync(package)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task CheckAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ICeClass-workshop-lifecycle-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ClassroomWorkshopService? service = null;
        var checks = 0;
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks++; Console.WriteLine("PASS " + label); }
        static async Task Wait(Func<bool> predicate, int seconds = 5)
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
            while (!predicate()) await Task.Delay(30, limit.Token);
        }
        var installed = Path.Combine(root, "Plugins", ClassroomPluginPackage.PluginId);
        var scenarioPath = Path.Combine(installed, "scenario.txt");
        try
        {
            var archivePath = Path.Combine(root, "fixture.zip");
            using (var zip = ZipFile.Open(archivePath, ZipArchiveMode.Create))
            {
                using (var writer = new StreamWriter(zip.CreateEntry("plugin.json").Open()))
                    writer.Write(JsonSerializer.Serialize(new { schemaVersion = 1, id = ClassroomPluginPackage.PluginId, name = "视频展台", version = "1.0.0", hostApiVersion = 1, runtime = "win-x64", entryPoint = "ICeClass.VideoBooth.exe" }));
                foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories))
                {
                    var relative = Path.GetRelativePath(AppContext.BaseDirectory, file);
                    if (relative.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || relative.EndsWith(".deps.json", StringComparison.OrdinalIgnoreCase) || relative.EndsWith(".runtimeconfig.json", StringComparison.OrdinalIgnoreCase))
                        zip.CreateEntryFromFile(file, relative.Replace('\\', '/'), CompressionLevel.Fastest);
                }
                zip.CreateEntryFromFile(Path.Combine(AppContext.BaseDirectory, "ICeClass.ReceiverOfflineChecks.exe"), "ICeClass.VideoBooth.exe", CompressionLevel.Fastest);
            }
            var package = new ClassroomPluginPackage(Path.Combine(root, "Plugins"), "win-x64");
            using (var candidate = ClassroomPluginPackage.Open(archivePath)) await package.InstallAsync(candidate, CancellationToken.None);
            package.SetEnabled(true);
            service = new ClassroomWorkshopService(Path.Combine(root, "Plugins"), Path.Combine(root, "BoothData"));
            var binding = new ReceiverConfig { Endpoint = "http://127.0.0.1:1", DeviceId = "synthetic-device", ClassId = "synthetic-class", DeviceToken = "synthetic-token" };
            service.SetBinding(binding);
            var owner = new Window();
            bool Ready() => JsonSerializer.SerializeToElement(service.Snapshot()).GetProperty("ready").GetBoolean();
            Task<object> Operation(string operation) => service.HandleAsync(operation, owner, binding, CancellationToken.None);

            File.WriteAllText(scenarioPath, "normal");
            await Operation("open"); await Wait(Ready);
            Assert(service.IsRunning, "hello authenticates the launched child process");
            var frame = await service.CommandAsync("freeze_frame", new { }, CancellationToken.None);
            Assert(ClassroomMathImage.FromPayload(frame.Payload).Width == 1, "freeze command returns a bounded PNG over the real pipe");
            var invalidations = 0; service.ReviewInvalidated += () => invalidations++;
            await service.StopDisplayAsync();
            Assert(service.IsRunning && invalidations > 0, "stop display cancels review while retaining the controlled process");
            await Operation("stop");
            Assert(!service.IsRunning && !Ready(), "stop waits for real child exit");

            File.WriteAllText(scenarioPath, "late-frame");
            await Operation("open"); await Wait(Ready);
            using (var cancelled = new CancellationTokenSource(50))
            {
                try { await service.CommandAsync("freeze_frame", new { }, cancelled.Token); throw new Exception("accepted cancelled frame"); }
                catch (OperationCanceledException) { checks++; Console.WriteLine("PASS cancellation rejects the pending frame"); }
            }
            var activated = await service.CommandAsync("activate", new { }, CancellationToken.None);
            Assert(activated.Type == "ack", "late cancelled frame cannot satisfy the next command");
            await Operation("stop");

            File.WriteAllText(scenarioPath, "slow-ready");
            var opening = Stopwatch.StartNew(); await Operation("open");
            Assert(opening.Elapsed.TotalSeconds < 8 && service.IsRunning && !Ready(), "early hello succeeds before browser preparation");
            await Wait(Ready, 19);
            Assert(Ready(), "ready may arrive after the 15 second handshake deadline");
            await Operation("disable");
            Assert(!service.IsRunning && package.Read() is { Enabled: false }, "disable persists and closes the process");
            await Operation("enable");

            File.WriteAllText(scenarioPath, "wrong-hello");
            try { await Operation("open"); throw new Exception("accepted mismatched hello PID"); }
            catch (InvalidOperationException) { checks++; Console.WriteLine("PASS mismatched hello PID is rejected"); }
            await Wait(() => !service.IsRunning);

            File.WriteAllText(scenarioPath, "disconnect");
            await Operation("open"); await Wait(Ready);
            try { await service.CommandAsync("activate", new { }, CancellationToken.None); throw new Exception("accepted disconnected command"); }
            catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException) { checks++; }
            await Wait(() => !Ready() && !service.IsRunning);
            Assert(!Ready(), "pipe loss invalidates ready state");

            File.WriteAllText(scenarioPath, "stubborn-exit");
            await Operation("open"); await Wait(Ready);
            try { await Operation("uninstall"); throw new Exception("uninstalled a running plugin"); }
            catch (InvalidOperationException error) { Assert(error.Message.Contains("文件已保留"), "uninstall reports a process that failed to exit"); }
            Assert(service.IsRunning && Directory.Exists(installed), "failed stop preserves installed files");
            File.WriteAllText(Path.Combine(installed, "allow-exit"), "synthetic fixture may exit");
            await Wait(() => !service.IsRunning);
            await Operation("uninstall");
            Assert(!Directory.Exists(installed) && package.Read() is null, "uninstall succeeds after the owned process exits");
            Console.WriteLine($"PASS {checks} real-process workshop lifecycle checks; fixture root: {root}");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            if (Directory.Exists(installed)) File.WriteAllText(Path.Combine(installed, "allow-exit"), "fixture cleanup");
            if (service is not null) try { await service.DisposeAsync(); } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    private static async Task CheckPackageAsync(string archivePath)
    {
        var root = Path.Combine(Path.GetTempPath(), "ICeClass-workshop-package-" + Guid.NewGuid().ToString("N"));
        ClassroomWorkshopService? service = null;
        try
        {
            var package = new ClassroomPluginPackage(Path.Combine(root, "Plugins"), "win-x64");
            using (var candidate = ClassroomPluginPackage.Open(archivePath)) await package.InstallAsync(candidate, CancellationToken.None);
            if (package.Read() is not { Enabled: false }) throw new Exception("fresh package was enabled");
            Console.WriteLine("PASS real package validates and starts disabled");
            package.SetEnabled(true);
            service = new ClassroomWorkshopService(Path.Combine(root, "Plugins"), Path.Combine(root, "BoothData"));
            var binding = new ReceiverConfig { Endpoint = "http://127.0.0.1:1", DeviceId = "synthetic-device", ClassId = "synthetic-class", DeviceToken = "synthetic-token" };
            service.SetBinding(binding);
            await service.HandleAsync("open", new Window(), binding, CancellationToken.None);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            while (!JsonSerializer.SerializeToElement(service.Snapshot()).GetProperty("ready").GetBoolean())
            {
                if (!service.IsRunning) throw new Exception("real plugin exited before ready");
                await Task.Delay(50, deadline.Token);
            }
            Console.WriteLine("PASS real plugin hello and WebView2 ready authenticate over the host pipe");
            await service.CommandAsync("activate", new { }, CancellationToken.None);
            try { await service.CommandAsync("freeze_frame", new { }, CancellationToken.None); throw new Exception("unexpected camera frame without user capture"); }
            catch (InvalidOperationException) { Console.WriteLine("PASS freeze without a current review is rejected"); }
            await service.StopDisplayAsync();
            await service.StopAsync();
            if (service.IsRunning) throw new Exception("real plugin is still running");
            Console.WriteLine("PASS real plugin stops and exits before host reports completion");
            Console.WriteLine("PASS real plugin package lifecycle; isolated fixture: " + root);
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            if (service is not null) try { await service.DisposeAsync(); } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    internal static async Task FakePluginAsync(string pipeName)
    {
        // The host deliberately passes its normal --data argument. Never read or write it here.
        var scenario = File.ReadAllText(Path.Combine(Environment.CurrentDirectory, "scenario.txt"));
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(50));
        try
        {
            await pipe.ConnectAsync(lifetime.Token);
            Task Send(string type, string id, object payload) => ClassroomPluginProtocol.WriteAsync(pipe, type, id, payload, lifetime.Token);
            await Send("hello", Guid.NewGuid().ToString("N"), new { pluginId = ClassroomPluginPackage.PluginId, processId = Environment.ProcessId + (scenario == "wrong-hello" ? 1 : 0) });
            if (scenario == "slow-ready") await Task.Delay(16000, lifetime.Token);
            await Send("ready", Guid.NewGuid().ToString("N"), new { });
            while (true)
            {
                var command = await ClassroomPluginProtocol.ReadAsync(pipe, lifetime.Token);
                if (scenario == "disconnect") return;
                if (command.Type == "freeze_frame")
                {
                    if (scenario == "late-frame") await Task.Delay(300, lifetime.Token);
                    await Send("frame", command.RequestId, new { dataUrl = Png, width = 1, height = 1, capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                }
                else
                {
                    await Send("ack", command.RequestId, new { });
                    if (command.Type != "exit") continue;
                    if (scenario == "stubborn-exit")
                        while (!File.Exists(Path.Combine(Environment.CurrentDirectory, "allow-exit"))) await Task.Delay(40, lifetime.Token);
                    return;
                }
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException) { }
    }
}

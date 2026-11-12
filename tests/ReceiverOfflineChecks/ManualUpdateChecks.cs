using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;
using ICeClass.Updates;

internal static class ManualUpdateChecks
{
    private const BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;

    internal static void Probe(string mode, string endpoint)
    {
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
        {
            var lifetime = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
            try
            {
                var app = (App)RuntimeHelpers.GetUninitializedObject(typeof(App));
                void Field(string name, object value) => typeof(App).GetField(name, Hidden)!.SetValue(app, value);
                Field("_updates", new ReceiverUpdateService()); Field("_desktop", lifetime);
                if (mode == "ready") Field("_readyUpdateVersion", "99.1.0");
                var config = new ReceiverConfig { Endpoint = endpoint, DeviceId = "fixture", DeviceToken = "fixture" };
                await (Task)typeof(App).GetMethod("CheckForUpdateAsync", Hidden)!.Invoke(app, [true, config, CancellationToken.None])!;
                if (!(bool)typeof(App).GetField("_exitRequested", Hidden)!.GetValue(app)!)
                    throw new Exception("Manual installation did not request shutdown: " + typeof(App).GetField("_updateStateText", Hidden)!.GetValue(app));
            }
            catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; lifetime.Shutdown(1); }
        })).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }

    internal static async Task<int> Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "ICeClass-ManualUpdate-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        // Only this copied harness and harmless fixture are shut down or replaced.
        foreach (var source in Directory.EnumerateFiles(AppContext.BaseDirectory, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(AppContext.BaseDirectory, source);
            if (relative.Split(Path.DirectorySeparatorChar)[0].StartsWith('.')) continue;
            var target = Path.Combine(root, relative); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(source, target);
        }
        var fixtureSource = Path.Combine(root, "Fixture.cs");
        await File.WriteAllTextAsync(fixtureSource, Fixture, new UTF8Encoding(true));
        var fixtureExe = Path.Combine(root, "NewVersion.exe");
        var compiler = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
        await RunProcess(compiler, ["/nologo", "/target:winexe", "/out:" + fixtureExe, fixtureSource]);
        var bytes = await File.ReadAllBytesAsync(fixtureExe);
        var digest = Convert.ToHexString(SHA256.HashData(bytes));
        var portProbe = new TcpListener(IPAddress.Loopback, 0); portProbe.Start();
        var port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
        var endpoint = $"http://127.0.0.1:{port}";
        using var server = new HttpListener(); server.Prefixes.Add(endpoint + "/"); server.Start();
        using var stop = new CancellationTokenSource();
        var downloads = 0;
        var serving = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                HttpListenerContext context;
                try { context = await server.GetContextAsync().WaitAsync(stop.Token); } catch (Exception) when (stop.IsCancellationRequested) { break; }
                using var response = context.Response;
                if (context.Request.Headers["Authorization"] != "Bearer fixture") { response.StatusCode = 401; continue; }
                byte[] content;
                switch (context.Request.Url!.AbsolutePath)
                {
                    case "/api/receiver/update/plan": response.StatusCode = 404; continue;
                    case "/api/receiver/update":
                        content = JsonSerializer.SerializeToUtf8Bytes(new { available = true, version = "99.1.0", size = bytes.Length, sha256 = digest, downloadUrl = "/file" });
                        break;
                    case "/file": content = bytes; Interlocked.Increment(ref downloads); break;
                    default: response.StatusCode = 404; continue;
                }
                response.ContentLength64 = content.Length; await response.OutputStream.WriteAsync(content);
            }
        });
        var checks = 0;
        void Check(bool ok, string text) { if (!ok) throw new Exception(text); checks++; Console.WriteLine("PASS " + text); }
        try
        {
            foreach (var mode in new[] { "ready", "download" })
            {
                await File.WriteAllTextAsync(Path.Combine(root, "ICeClass.exe"), "old fixture version");
                await File.WriteAllTextAsync(Path.Combine(root, "config.json"), "existing classroom binding");
                await File.WriteAllTextAsync(Path.Combine(root, "island-settings.json"), "existing local preferences");
                Directory.CreateDirectory(Path.Combine(root, "VoiceResources"));
                await File.WriteAllTextAsync(Path.Combine(root, "VoiceResources/unchanged.model"), "existing offline model");
                if (mode == "ready")
                {
                    var staged = Path.Combine(root, ".updates/fixture/ICeClass.exe");
                    Directory.CreateDirectory(Path.GetDirectoryName(staged)!); File.Copy(fixtureExe, staged);
                    UpdateInstaller.SavePending(root, new("99.1.0", "ICeClass.exe", [new("ICeClass.exe", staged, bytes.Length, digest)]));
                }
                var host = Environment.ProcessPath!;
                if (!Path.GetFileNameWithoutExtension(host).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                    host = Path.GetFullPath(Path.Combine(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "../../..", "dotnet.exe"));
                await RunProcess(host, [Path.Combine(root, Path.GetFileName(typeof(ManualUpdateChecks).Assembly.Location)),
                    "--manual-update-probe", mode, endpoint, "--incremental-update-started"]);
                var deadline = Stopwatch.StartNew();
                var receipt = Path.Combine(root, "new-version.txt");
                while ((!File.Exists(receipt) || File.Exists(Path.Combine(root, ".updates/pending.json")) || File.Exists(Path.Combine(root, ".updates/applying.json"))) && deadline.Elapsed < TimeSpan.FromSeconds(10))
                    await Task.Delay(50);
                Check(File.Exists(receipt) && File.ReadAllText(receipt) == "99.1.0" &&
                    !File.Exists(Path.Combine(root, ".updates/applying.json")) && !File.Exists(Path.Combine(root, ".updates/last-error.txt")),
                    $"manual {mode} installs and automatically opens the new version from an updater-launched session");
                // The startup receipt is written before the fixture exits. Wait for
                // that process before reopening or replacing its executable.
                try
                {
                    using var updated = Process.GetProcessById(int.Parse(await File.ReadAllTextAsync(Path.Combine(root, "new-version.pid"))));
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                    await updated.WaitForExitAsync(timeout.Token);
                }
                catch (ArgumentException) { /* The fixture already exited. */ }
                Check(File.ReadAllText(Path.Combine(root, "config.json")) == "existing classroom binding" &&
                    File.ReadAllText(Path.Combine(root, "island-settings.json")) == "existing local preferences" &&
                    File.ReadAllText(Path.Combine(root, "VoiceResources/unchanged.model")) == "existing offline model",
                    $"manual {mode} preserves the classroom binding, preferences and offline resources");
                File.Delete(receipt);
                await RunProcess(Path.Combine(root, "ICeClass.exe"), []);
                Check(File.ReadAllText(receipt) == "99.1.0", $"reopening after manual {mode} runs the installed new version");
                File.Delete(receipt);
            }
            Check(downloads == 1, "a ready update installs without another download; a manual check downloads and installs in one request");
            return checks;
        }
        finally { stop.Cancel(); server.Stop(); await serving; }
    }

    private static async Task RunProcess(string file, string[] arguments)
    {
        var start = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw; }
        if (process.ExitCode != 0) throw new Exception($"Manual update fixture exited {process.ExitCode}: {await output}{await error}");
    }

    private const string Fixture = """
        using System;
        using System.Diagnostics;
        using System.IO;
        using System.Linq;
        internal static class Fixture {
            private static void Main(string[] args) {
                var root = AppDomain.CurrentDomain.BaseDirectory;
                File.WriteAllText(Path.Combine(root, "new-version.pid"), Process.GetCurrentProcess().Id.ToString());
                File.WriteAllText(Path.Combine(root, "new-version.txt"), "99.1.0");
                if (args.Contains("--incremental-update-started"))
                    File.WriteAllText(Path.Combine(root, ".updates/incremental-started.ok"), "started");
            }
        }
        """;
}

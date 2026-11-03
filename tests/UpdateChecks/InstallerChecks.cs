using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ICeClass.Updates;

internal static class InstallerChecks
{
    private const string PendingProbeArgument = "--installer-pending-probe";
    private const string ExecutableName = "ICeClass.exe";
    private const string RestartArguments = "--mode \"safe mode\" --message \"你好，班伴\" --literal \"$env:TEMP; & keep\" --empty \"\" --quoted \"a\\\"b\" --path \"C:\\folder with space\\\\\"";
    private static readonly string[] ExpectedArguments =
        ["--mode", "safe mode", "--message", "你好，班伴", "--literal", "$env:TEMP; & keep", "--empty", "", "--quoted", "a\"b", "--path", "C:\\folder with space\\"];

    internal static bool TryRunPendingProbe(string[] arguments)
    {
        if (arguments.Length == 0 || arguments[0] != PendingProbeArgument) return false;
        if (arguments.Length is < 4 or > 5) throw new ArgumentException("Invalid installer pending probe arguments.");
        var launched = UpdateInstaller.TryLaunchPending(arguments[1], arguments[2], arguments[3]);
        Console.WriteLine("INSTALLER_PENDING_LAUNCHED=" + launched);
        return true;
    }

    internal static async Task RunAsync(string parent, Action<bool, string> check)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Installer subprocess checks require Windows PowerShell 5.1.");
        var root = Path.Combine(parent, "installer subprocess checks");
        Directory.CreateDirectory(root);
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var host = await RunProcessAsync(powershell, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
        Assert(host.ExitCode == 0 && host.Output.Trim().StartsWith("5.1.", StringComparison.Ordinal), "The installer must be tested in Windows PowerShell 5.1: " + host.Output + host.Error);
        Console.WriteLine("INFO installer host: Windows PowerShell " + host.Output.Trim());
        var fixtures = await CompileFixturesAsync(root);
        // This is a real, completed fixture process, never the current test runner or a real client.
        var exited = await RunProcessAsync(fixtures.Old, []);
        Assert(exited.ExitCode == 0, "The old fixture must exit immediately.");
        var failures = new List<Exception>();
        var scenarios = new (string Name, Func<Task> Run)[]
        {
            ("confirmed application and voice replacement preserve config and settings", SuccessfulInstallAsync),
            ("a session opened by the updater can immediately install its next prepared update", UpdatedSessionInstallAsync),
            ("failed new application restores every old file and launches the old application", FailedLaunchAsync),
            ("exit code zero and a stale marker do not count as new launch confirmation", UnconfirmedLaunchAsync),
            ("interrupted applying journal restores files and discards a newer pending update", InterruptedInstallAsync),
            ("interruption before the first journal entry restarts the unchanged application", InterruptedBeforeReplacementAsync),
            ("quoted and Unicode restart arguments survive a successful update", RestartArgumentsAsync),
            ("forbidden destination cannot replace the application or settings", InvalidDestinationAsync),
            ("traversal destination cannot replace the application or settings", TraversalDestinationAsync),
            ("tampered later staged resource prevents every replacement", StagedTamperAsync),
            ("external staging path prevents every replacement", ExternalStageAsync),
            ("duplicate prepared destinations cannot replace any old file", DuplicateDestinationAsync),
            ("invalid staged pending does not repeatedly launch helpers on subsequent startup", InvalidPendingRetryAsync),
            ("malformed pending metadata does not block normal startup", MalformedPendingStartupAsync),
            ("applying recovery precedes malformed pending and allows the next startup", MalformedPendingRecoveryAsync),
        };
        foreach (var scenario in scenarios)
        {
            try
            {
                await scenario.Run();
                check(true, "installer: " + scenario.Name);
            }
            catch (Exception error)
            {
                Console.WriteLine("FAIL installer: " + scenario.Name + "\n" + error.Message);
                failures.Add(new InvalidOperationException(scenario.Name, error));
            }
        }
        if (failures.Count > 0) throw new AggregateException("Installer subprocess checks failed", failures);

        async Task SuccessfulInstallAsync()
        {
            var install = new Installation(root, "successful install 中 文", fixtures, fixtures.Confirmed);
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertSuccessful(result);
            var launch = await install.LaunchAsync("confirmed");
            Assert(launch.Arguments.SequenceEqual(["--incremental-update-started"]), "The replacement process must receive the confirmation flag.");
            Assert(File.ReadAllText(install.PathFor(".fixture/confirmed.ready")) == launch.ProcessId.ToString(), "Readiness must have been written by the launched fixture process.");
            Assert(!File.Exists(install.PathFor(".fixture/old.log")), "A confirmed application must not roll back or restart the old executable.");
        }

        async Task FailedLaunchAsync()
        {
            var install = new Installation(root, "failed launch", fixtures, fixtures.Failed);
            var result = await install.ApplyAsync(powershell, exited.ProcessId, RestartArguments);
            install.AssertRestored(result, expectAttemptedLaunch: "failed");
            var oldLaunch = await install.LaunchAsync("old");
            Assert(oldLaunch.Arguments.SequenceEqual(ExpectedArguments), "Rollback must preserve the original restart arguments without the update confirmation flag.");
        }

        async Task UpdatedSessionInstallAsync()
        {
            var install = new Installation(root, "manual update from updated session", fixtures, fixtures.Confirmed);
            Assert(await ProbePendingAsync(install.Root, updatedSession: true),
                "The update-launch confirmation flag must not disable a later manual installation.");
            await install.LaunchAsync("confirmed");
            install.AssertSuccessful(new(0, 0, "", ""));
        }

        async Task UnconfirmedLaunchAsync()
        {
            var install = new Installation(root, "no startup confirmation", fixtures, fixtures.Unconfirmed);
            File.WriteAllText(install.PathFor(".updates/incremental-started.ok"), "stale confirmation from another run");
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertRestored(result, expectAttemptedLaunch: "unconfirmed");
            await install.LaunchAsync("old");
            Assert(!File.Exists(install.PathFor(".fixture/unconfirmed.ready")), "The unconfirmed fixture must not emit readiness.");
        }

        async Task InterruptedInstallAsync()
        {
            var install = new Installation(root, "interrupted journal", fixtures, fixtures.Confirmed);
            install.InterruptAfterReplacements();
            // Leave a newer pending plan in place: recovery must discard it after restoring old files.
            var result = await install.ApplyAsync(powershell, exited.ProcessId, RestartArguments);
            install.AssertOriginalFiles();
            Assert(result.ExitCode == 0 && !File.Exists(install.PathFor(".updates/last-error.txt")), "Recovery should complete without another installation failure: " + result.Error);
            Assert(!File.Exists(install.PathFor(".updates/applying.json")) && !File.Exists(install.PathFor(".updates/install-journal.json")), "A recovered installation must clear the applying journal.");
            Assert(!File.Exists(install.PathFor(".updates/pending.json")), "Recovery must discard the newer pending update so the next startup does not install it again.");
            Assert(!File.Exists(install.PathFor(".fixture/confirmed.log")), "Recovery must not launch the interrupted replacement.");
            var launch = await install.LaunchAsync("old");
            Assert(launch.Arguments.SequenceEqual(ExpectedArguments), "Interrupted recovery must preserve restart arguments.");
        }

        async Task InterruptedBeforeReplacementAsync()
        {
            var install = new Installation(root, "interrupted before journal", fixtures, fixtures.Confirmed);
            File.Move(install.PathFor(".updates/pending.json"), install.PathFor(".updates/applying.json"));
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertOriginalFiles();
            Assert(result.ExitCode == 0 && !File.Exists(install.PathFor(".updates/applying.json")), "An interruption before replacement must simply recover the original program.");
            await install.LaunchAsync("old");
        }

        async Task RestartArgumentsAsync()
        {
            var install = new Installation(root, "restart arguments", fixtures, fixtures.Confirmed);
            var result = await install.ApplyAsync(powershell, exited.ProcessId, UpdateInstaller.QuoteArguments(ExpectedArguments));
            install.AssertSuccessful(result);
            var launch = await install.LaunchAsync("confirmed");
            Assert(launch.Arguments.SequenceEqual(ExpectedArguments.Append("--incremental-update-started")), "Arguments changed: " + JsonSerializer.Serialize(launch.Arguments));
        }

        async Task InvalidDestinationAsync() => await InvalidPlanAsync("invalid destination", update => update with
        {
            Files = [.. update.Files, update.Files[1] with { Path = "config.json" }]
        });

        async Task TraversalDestinationAsync() => await InvalidPlanAsync("traversal destination", update => update with
        {
            Files = [.. update.Files, update.Files[1] with { Path = "VoiceResources/../config.json" }]
        });

        async Task DuplicateDestinationAsync() => await InvalidPlanAsync("duplicate destination", update => update with
        {
            Files = [.. update.Files, update.Files[0]]
        });

        async Task StagedTamperAsync()
        {
            var install = new Installation(root, "tampered staged resource", fixtures, fixtures.Confirmed);
            // Same length, wrong SHA: a later resource must fail before even the valid EXE is replaced.
            var staged = install.Update.Files[1].StagedPath;
            var bytes = File.ReadAllBytes(staged); bytes[0] ^= 0xff; File.WriteAllBytes(staged, bytes);
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertRejected(result);
            await install.LaunchAsync("old");
        }

        async Task ExternalStageAsync()
        {
            var install = new Installation(root, "external staged resource", fixtures, fixtures.Confirmed);
            var external = Path.Combine(root, "external resource.bin");
            File.Copy(install.Update.Files[1].StagedPath, external);
            var before = File.ReadAllBytes(external);
            UpdateInstaller.SavePending(install.Root, install.Update with
            {
                Files = [install.Update.Files[0], install.Update.Files[1] with { StagedPath = external }, install.Update.Files[2]]
            });
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertRejected(result);
            Assert(File.ReadAllBytes(external).SequenceEqual(before), "External staging files must remain untouched.");
            await install.LaunchAsync("old");
        }

        async Task InvalidPlanAsync(string name, Func<PreparedUpdate, PreparedUpdate> change)
        {
            var install = new Installation(root, name, fixtures, fixtures.Confirmed);
            UpdateInstaller.SavePending(install.Root, change(install.Update));
            var result = await install.ApplyAsync(powershell, exited.ProcessId);
            install.AssertRejected(result);
            await install.LaunchAsync("old");
        }

        async Task InvalidPendingRetryAsync()
        {
            var install = new Installation(root, "invalid pending next startup", fixtures, fixtures.Confirmed);
            File.WriteAllText(install.Update.Files[1].StagedPath, "corrupted after preparation");
            Assert(await ProbePendingAsync(install.Root), "The first startup should hand a prepared update to the helper.");
            await install.LaunchAsync("old");
            install.AssertOriginalFiles();
            File.Delete(install.PathFor(".fixture/old.log"));
            var retried = await ProbePendingAsync(install.Root);
            if (retried) await install.LaunchAsync("old");
            Assert(!retried, "Invalid pending was retained: the next startup launches another helper and restarts the old application again.");
            Assert(!File.Exists(install.PathFor(".updates/pending.json")), "Rejected pending metadata must be removed or quarantined.");
        }

        async Task MalformedPendingStartupAsync()
        {
            var install = new Installation(root, "malformed pending normal startup", fixtures, fixtures.Confirmed);
            File.WriteAllText(install.PathFor(".updates/pending.json"), "{invalid pending metadata");
            var launched = await ProbePendingAsync(install.Root);
            if (launched) await install.LaunchAsync("old");
            Assert(!launched, "Malformed pending metadata must allow normal startup instead of launching an update helper.");
            install.AssertOriginalFiles();
            Assert(!File.Exists(install.PathFor(".updates/pending.json")), "Malformed pending metadata must not crash every later startup.");
        }

        async Task MalformedPendingRecoveryAsync()
        {
            var install = new Installation(root, "recover before malformed pending", fixtures, fixtures.Confirmed);
            install.InterruptAfterReplacements();
            File.WriteAllText(install.PathFor(".updates/pending.json"), "{invalid newer pending metadata");
            Assert(await ProbePendingAsync(install.Root), "An applying journal must be recovered even when the newer pending metadata is malformed.");
            await install.LaunchAsync("old");
            install.AssertOriginalFiles();
            Assert(!File.Exists(install.PathFor(".updates/applying.json")), "Interrupted installation was not recovered.");
            File.Delete(install.PathFor(".fixture/old.log"));
            var retried = await ProbePendingAsync(install.Root);
            if (retried) await install.LaunchAsync("old");
            Assert(!retried, "After recovery, malformed newer metadata must not reenter the update installer.");
        }
    }

    private sealed record Fixtures(string Old, string Confirmed, string Failed, string Unconfirmed);
    private sealed record ProcessResult(int ProcessId, int ExitCode, string Output, string Error);
    private sealed record Launch(int ProcessId, string[] Arguments);

    private sealed class Installation
    {
        internal readonly string Root;
        internal readonly PreparedUpdate Update;
        private readonly Dictionary<string, byte[]> original;
        private readonly Dictionary<string, byte[]> expected;

        internal Installation(string parent, string name, Fixtures fixtures, string newExecutable)
        {
            Root = Path.Combine(parent, name); Directory.CreateDirectory(Root);
            original = new()
            {
                [ExecutableName] = File.ReadAllBytes(fixtures.Old),
                ["VoiceResources/Asr/model.int8.onnx"] = Encoding.UTF8.GetBytes("old offline voice model"),
                ["VoiceResources/Tts/unchanged.pack"] = Encoding.UTF8.GetBytes("unchanged voice pack"),
                ["config.json"] = Encoding.UTF8.GetBytes("private classroom binding"),
                ["banban-settings.json"] = Encoding.UTF8.GetBytes("existing microphone settings"),
                ["settings/preferences.json"] = Encoding.UTF8.GetBytes("existing local preferences")
            };
            foreach (var entry in original) Write(entry.Key, entry.Value);
            expected = new()
            {
                [ExecutableName] = File.ReadAllBytes(newExecutable),
                ["VoiceResources/Asr/model.int8.onnx"] = Encoding.UTF8.GetBytes("new offline voice model"),
                ["VoiceResources/Tts/added.pack"] = Encoding.UTF8.GetBytes("new voice pack")
            };
            var files = new List<PreparedFile>();
            foreach (var entry in expected)
            {
                var staged = ".updates/9.0.0-0123456789abcdef/files/" + entry.Key;
                Write(staged, entry.Value);
                files.Add(new(entry.Key, PathFor(staged), entry.Value.Length, Convert.ToHexString(SHA256.HashData(entry.Value)).ToLowerInvariant()));
            }
            Update = new("9.0.0", ExecutableName, files);
            UpdateInstaller.SavePending(Root, Update);
        }

        internal string PathFor(string relative) => Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));

        private void Write(string relative, byte[] bytes)
        {
            var path = PathFor(relative); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllBytes(path, bytes);
        }

        internal async Task<ProcessResult> ApplyAsync(string powershell, int exitedProcessId, string restart = "")
        {
            var script = PathFor(".updates/apply-incremental-update.ps1");
            File.WriteAllText(script, UpdateInstaller.ApplyScript, new UTF8Encoding(true));
            return await RunProcessAsync(powershell,
                ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, exitedProcessId.ToString(), Root, ExecutableName, Convert.ToBase64String(Encoding.UTF8.GetBytes(restart))]);
        }

        internal void InterruptAfterReplacements()
        {
            var journal = new List<object>();
            foreach (var file in Update.Files)
            {
                var target = PathFor(file.Path);
                var existed = File.Exists(target);
                var backup = ".updates/previous/" + file.Path;
                if (existed)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(PathFor(backup))!);
                    File.Copy(target, PathFor(backup));
                }
                journal.Add(new { path = file.Path, backup, existed });
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.Copy(file.StagedPath, target, true);
            }
            File.WriteAllText(PathFor(".updates/applying.json"), JsonSerializer.Serialize(Update, IncrementalUpdates.Json));
            File.WriteAllText(PathFor(".updates/install-journal.json"), JsonSerializer.Serialize(journal));
        }

        internal void AssertOriginalFiles()
        {
            foreach (var entry in original)
                Assert(File.Exists(PathFor(entry.Key)) && File.ReadAllBytes(PathFor(entry.Key)).SequenceEqual(entry.Value), "Original file was not preserved/restored: " + entry.Key + ErrorDetails());
            Assert(!File.Exists(PathFor("VoiceResources/Tts/added.pack")), "Rollback/rejection must remove a newly created voice resource." + ErrorDetails());
        }

        internal void AssertSuccessful(ProcessResult result)
        {
            Assert(result.ExitCode == 0 && !File.Exists(PathFor(".updates/last-error.txt")), "The update did not confirm a successful installation: " + result.Output + result.Error + ErrorDetails());
            foreach (var entry in expected)
                Assert(File.ReadAllBytes(PathFor(entry.Key)).SequenceEqual(entry.Value), "New file was not installed: " + entry.Key);
            foreach (var entry in original.Where(entry => !expected.ContainsKey(entry.Key)))
                Assert(File.ReadAllBytes(PathFor(entry.Key)).SequenceEqual(entry.Value), "Configuration, settings or an unchanged resource was modified: " + entry.Key);
            foreach (var relative in new[] { ".updates/pending.json", ".updates/applying.json", ".updates/install-journal.json", ".updates/incremental-started.ok" })
                Assert(!File.Exists(PathFor(relative)), "Successful installation did not clear " + relative);
            foreach (var entry in expected)
                Assert(!File.Exists(PathFor(".updates/previous/" + entry.Key)), "Successful installation left a backup: " + entry.Key);
        }

        internal void AssertRestored(ProcessResult result, string expectAttemptedLaunch)
        {
            Assert(result.ExitCode == 0, "Rollback helper failed: " + result.Error + ErrorDetails());
            AssertOriginalFiles();
            Assert(File.Exists(PathFor(".updates/last-error.txt")), "A failed or unconfirmed launch must produce failure feedback.");
            Assert(File.Exists(PathFor(".fixture/" + expectAttemptedLaunch + ".log")), "The replacement fixture was never launched.");
            Assert(!File.Exists(PathFor(".updates/applying.json")) && !File.Exists(PathFor(".updates/install-journal.json")), "A completed rollback must clear its applying journal.");
        }

        internal void AssertRejected(ProcessResult result)
        {
            AssertOriginalFiles();
            Assert(File.Exists(PathFor(".updates/last-error.txt")), "Rejected staged data needs explicit failure feedback: " + result.Error);
            Assert(!File.Exists(PathFor(".updates/pending.json")), "Invalid staged data must be removed or quarantined so the next startup cannot retry it.");
            Assert(!File.Exists(PathFor(".fixture/confirmed.log")), "Invalid staged data must never launch the replacement executable.");
        }

        private string ErrorDetails() => File.Exists(PathFor(".updates/last-error.txt")) ? "\nHelper error: " + File.ReadAllText(PathFor(".updates/last-error.txt")) : "";

        internal async Task<Launch> LaunchAsync(string identity)
        {
            var log = PathFor(".fixture/" + identity + ".log");
            var deadline = Stopwatch.StartNew();
            while (!File.Exists(log) && deadline.Elapsed < TimeSpan.FromSeconds(4)) await Task.Delay(25);
            Assert(File.Exists(log), "Expected fixture application did not launch: " + identity + ErrorDetails());
            var lines = File.ReadAllLines(log);
            var pid = int.Parse(lines[0]);
            // Wait only for this fixture PID after its log proves it was launched by this scenario.
            try
            {
                using var process = Process.GetProcessById(pid);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (ArgumentException) { }
            return new(pid, lines.Skip(1).Select(line => Encoding.UTF8.GetString(Convert.FromBase64String(line))).ToArray());
        }
    }

    private static async Task<Fixtures> CompileFixturesAsync(string root)
    {
        var directory = Path.Combine(root, "compiled fixtures"); Directory.CreateDirectory(directory);
        var source = Path.Combine(directory, "Fixture.cs");
        File.WriteAllText(source, FixtureSource, new UTF8Encoding(true));
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var compiler = Path.Combine(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        if (!File.Exists(compiler)) compiler = Path.Combine(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
        foreach (var identity in new[] { "OLD", "CONFIRMED", "FAILED", "UNCONFIRMED" })
        {
            var result = await RunProcessAsync(compiler,
                ["/nologo", "/target:winexe", "/optimize+", "/define:" + identity, "/out:" + Path.Combine(directory, identity + ".exe"), source]);
            Assert(result.ExitCode == 0, "Cannot compile the harmless .NET Framework fixture: " + result.Output + result.Error);
        }
        return new(Path.Combine(directory, "OLD.exe"), Path.Combine(directory, "CONFIRMED.exe"), Path.Combine(directory, "FAILED.exe"), Path.Combine(directory, "UNCONFIRMED.exe"));
    }

    private static async Task<bool> ProbePendingAsync(string installDirectory, bool updatedSession = false)
    {
        var dotnet = Path.GetFullPath(Path.Combine(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..", "dotnet.exe"));
        var arguments = new List<string> { typeof(InstallerChecks).Assembly.Location, PendingProbeArgument, installDirectory, ExecutableName, "" };
        if (updatedSession) arguments.Add("--incremental-update-started");
        var result = await RunProcessAsync(dotnet, arguments.ToArray());
        Assert(result.ExitCode == 0, "Pending update prevented normal startup: " + result.Output + result.Error);
        if (result.Output.Contains("INSTALLER_PENDING_LAUNCHED=True", StringComparison.Ordinal)) return true;
        Assert(result.Output.Contains("INSTALLER_PENDING_LAUNCHED=False", StringComparison.Ordinal), "Pending probe did not report startup behavior: " + result.Output + result.Error);
        return false;
    }

    private static async Task<ProcessResult> RunProcessAsync(string executable, string[] arguments)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        // A PowerShell 7 host can otherwise inject incompatible modules into Windows PowerShell.
        foreach (var name in start.Environment.Keys.Where(name => name.Equals("PSModulePath", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(name);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Cannot start " + executable);
        var pid = process.Id;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            // This process tree belongs to a temporary fixture; real clients are never inspected or stopped.
            process.Kill(entireProcessTree: true); await process.WaitForExitAsync();
            throw new TimeoutException("Fixture subprocess exceeded 12 seconds: " + executable + "\n" + await output + await error);
        }
        return new(pid, process.ExitCode, await output, await error);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private const string FixtureSource = """
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

internal static class Fixture
{
    private static int Main(string[] args)
    {
#if OLD
        const string identity = "old";
#elif CONFIRMED
        const string identity = "confirmed";
#elif FAILED
        const string identity = "failed";
#else
        const string identity = "unconfirmed";
#endif
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var directory = Path.Combine(root, ".fixture");
        Directory.CreateDirectory(directory);
        var pid = Process.GetCurrentProcess().Id.ToString();
        var lines = new[] { pid }.Concat(args.Select(value => Convert.ToBase64String(Encoding.UTF8.GetBytes(value))));
        var log = Path.Combine(directory, identity + ".log");
        File.WriteAllLines(log + ".next", lines, Encoding.UTF8);
        if (File.Exists(log)) File.Delete(log);
        File.Move(log + ".next", log);
#if CONFIRMED
        if (args.Contains("--incremental-update-started"))
        {
            File.WriteAllText(Path.Combine(directory, identity + ".ready"), pid);
            Directory.CreateDirectory(Path.Combine(root, ".updates"));
            File.WriteAllText(Path.Combine(root, ".updates", "incremental-started.ok"), "started");
        }
#endif
#if FAILED
        return 17;
#else
        return 0;
#endif
    }
}
""";
}

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Encodings.Web;
using System.Text.Unicode;
using System.Runtime.InteropServices;

namespace ICeClass.Receiver;

/// <summary>Isolate potentially hung COM/UI Automation calls from the receiver.
/// Stopping an operation terminates only this adapter, never the teaching app.</summary>
internal sealed class ClassroomAgentWorker
{
    private static readonly JsonSerializerOptions ProtocolJson = new(JsonSerializerOptions.Default) { Encoder = JavaScriptEncoder.Create(UnicodeRanges.All) };
    private Process? _process;
    private readonly object _gate = new();

    internal Task<JsonObject> InspectAsync(IReadOnlyList<AgentApplication> apps, CancellationToken token) => Exchange("inspect", null, apps, token);
    internal Task<JsonObject> OperateAsync(string action, JsonElement args, IReadOnlyList<AgentApplication> apps, CancellationToken token) => Exchange(action, args, apps, token);

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage("SingleFile", "IL3000",
        Justification = "An empty assembly location intentionally selects the current executable in a single-file build.")]
    private async Task<JsonObject> Exchange(string action, JsonElement? args, IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        Process worker;
        lock (_gate)
        {
            if (_process is null || _process.HasExited)
            {
                _process?.Dispose();
                var assembly = typeof(Program).Assembly.Location;
                var executable = string.IsNullOrEmpty(assembly) ? Environment.ProcessPath! : Path.ChangeExtension(assembly, ".exe");
                var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, WorkingDirectory = AppContext.BaseDirectory };
                if (!File.Exists(executable))
                {
                    start.FileName = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? Environment.ProcessPath!;
                    start.ArgumentList.Add(assembly);
                }
                start.ArgumentList.Add("--banban-computer-worker");
                var runtimeRoot = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));
                if (File.Exists(Path.Combine(runtimeRoot, "dotnet.exe")))
                {
                    start.Environment["DOTNET_ROOT"] = runtimeRoot;
                    start.Environment["DOTNET_ROOT_X64"] = runtimeRoot;
                }
                _process = Process.Start(start) ?? throw new InvalidOperationException("应用适配器未能启动。");
                _ = _process.StandardError.ReadToEndAsync();
            }
            worker = _process;
        }
        using var cancelled = token.Register(() => Terminate(worker));
        try
        {
            token.ThrowIfCancellationRequested();
            var payload = JsonSerializer.Serialize(new { action, args, applications = apps }, ProtocolJson);
            await worker.StandardInput.WriteLineAsync(payload.AsMemory(), token);
            await worker.StandardInput.FlushAsync(token);
            var line = await worker.StandardOutput.ReadLineAsync(token);
            if (line is null || line.Length > 768 * 1024) throw new InvalidOperationException("应用适配器连接中断，请重新查看窗口。");
            var reply = JsonNode.Parse(line)?.AsObject() ?? throw new InvalidOperationException("应用适配器结果无效。");
            if (reply["error"] is JsonValue error) throw new InvalidOperationException(error.GetValue<string>());
            return reply["result"]?.DeepClone().AsObject() ?? throw new InvalidOperationException("应用适配器没有返回结果。");
        }
        catch (Exception) when (token.IsCancellationRequested) { throw new OperationCanceledException(token); }
    }

    private void Terminate(Process process)
    {
        lock (_gate)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: false); }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            if (ReferenceEquals(_process, process)) { _process = null; }
        }
    }
    internal void Reset()
    {
        Process? process; lock (_gate) process = _process;
        if (process is not null) Terminate(process);
    }

    internal static void Run()
    {
        // This is a hidden WinExe with redirected pipes, not an attached console.
        // Setting Console.InputEncoding calls SetConsoleCP and fails without one.
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var adapter = new ClassroomAgentWindows();
        string? line;
        while ((line = input.ReadLine()) is not null)
        {
            JsonObject reply;
            try
            {
                if (line.Length > 60000) throw new InvalidOperationException("操作参数过长。");
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var action = ClassroomAgentService.Text(root, "action", 80);
                var apps = root.GetProperty("applications").Deserialize<List<AgentApplication>>() ?? [];
                using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(19));
                var result = action == "recycle_file" ? ClassroomAgentFiles.Recycle(root.GetProperty("args"), apps, limit.Token) :
                    action == "inspect" ? adapter.InspectAsync(apps, limit.Token).GetAwaiter().GetResult() :
                    adapter.OperateAsync(action, root.GetProperty("args"), apps, limit.Token).GetAwaiter().GetResult();
                reply = new() { ["result"] = result };
            }
            catch (Exception error) { reply = new() { ["error"] = error.Message }; }
            output.WriteLine(reply.ToJsonString(ProtocolJson));
        }
    }
}

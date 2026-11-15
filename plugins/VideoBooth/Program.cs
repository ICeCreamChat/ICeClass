using ICeClass.VideoBooth.Transport;

namespace ICeClass.VideoBooth;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        BoothServer? server = null;
        IceClassPipeClient? client = null;
        DataDirectoryLease? lease = null;
        string? data = null;
        var managed = args.Contains("--iceclass-pipe", StringComparer.Ordinal);
        try
        {
            var options = StartupOptions.Parse(args);
            data = options.DataDirectory;
            if (options.PipeName is { } pipe)
            {
                client = IceClassPipeClient.Connect(pipe).GetAwaiter().GetResult();
                client.Send("state", new { message = "正在打开展台…" }).GetAwaiter().GetResult();
            }
            lease = DataDirectoryLease.Acquire(data);
            Directory.CreateDirectory(data);
            server = Task.Run(() => BoothServer.Start(data)).GetAwaiter().GetResult();
            if (client?.Disconnected.IsCancellationRequested == true) return;
            Application.Run(new WorkbenchForm(server, client));
        }
        catch (Exception error)
        {
            if (client?.Disconnected.IsCancellationRequested == true) return;
            Environment.ExitCode = 1;
            if (lease is not null && data is not null)
                try { File.WriteAllText(Path.Combine(data, "last-error.txt"), error.ToString()); } catch (IOException) { }
            if (client is not null)
                try { client.Send("state", new { message = "展台启动失败：" + error.Message }).GetAwaiter().GetResult(); } catch (Exception) { }
            if (!managed) MessageBox.Show(error.Message, "视频展台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            if (server is not null) Task.Run(async () => await server.DisposeAsync()).GetAwaiter().GetResult();
            client?.Dispose();
            lease?.Dispose();
        }
    }
}

internal sealed record StartupOptions(string DataDirectory, string? PipeName)
{
    internal static StartupOptions Parse(string[] args)
    {
        string? directory = null, pipe = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var preview = false;
        for (var i = 0; i < args.Length; i++)
        {
            var name = args[i];
            if (name == "--preview" && seen.Add(name)) { preview = true; continue; }
            if (name is not ("--data" or "--iceclass-pipe") || !seen.Add(name) || i + 1 == args.Length || string.IsNullOrWhiteSpace(args[i + 1]) || args[i + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException("展台启动参数无效。");
            var value = args[++i];
            if (name == "--data") directory = value;
            else pipe = value;
        }
        if (preview && pipe is not null) throw new ArgumentException("独立预览不能同时连接宿主。");
        directory ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "VideoBooth", "data");
        return new(Path.GetFullPath(directory), pipe);
    }
}

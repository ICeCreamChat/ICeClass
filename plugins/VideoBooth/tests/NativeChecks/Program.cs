using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using ICeClass.VideoBooth;
using ICeClass.VideoBooth.Transport;

internal static class Program
{
    private static int checks;
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var fix1 = args.Contains("--fix1");
            var cameraPermission = args.Contains("--camera-permission");
            if (!fix1 && !cameraPermission) ProtocolChecks();
            if (args.Contains("--ui") || fix1 || cameraPermission)
            {
                Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
                Application.EnableVisualStyles();
                using var owner = new Form { Text = "视频展台原生检查", Size = new Size(400, 160) };
                owner.Shown += async (_, _) =>
                {
                    try
                    {
                        if (cameraPermission) await CameraPermissionChecks.Run(owner);
                        else if (fix1) await PhoneRecoveryChecks.Run(owner);
                        else await NativeUiChecks.Run(owner);
                    }
                    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
                    finally { owner.Close(); }
                };
                Application.Run(owner);
            }
            Console.WriteLine($"{(cameraPermission ? "Camera permission checks" : fix1 ? "Fix round1 focused checks" : "Protocol/startup checks")}: {checks} passed.");
            return Environment.ExitCode;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void ProtocolChecks()
    {
        var id = Guid.NewGuid().ToString("N");
        var packet = IceClassProtocol.Encode("activate", new { }, id);
        Expect(BinaryPrimitives.ReadInt32LittleEndian(packet) == packet.Length - 4, "little endian length prefix");
        var decoded = IceClassProtocol.Decode(packet[4..]);
        Expect(decoded.GetProperty("requestId").GetString() == id, "request ID preserved");
        Reject(() => IceClassProtocol.Decode(Encoding.UTF8.GetBytes("{\"protocolVersion\":1,\"protocolVersion\":1,\"requestId\":\"" + id + "\",\"type\":\"activate\",\"payload\":{}}")), "duplicate envelope fields rejected");
        Reject(() => IceClassProtocol.Decode(new byte[IceClassProtocol.MaximumMessageBytes + 1]), "3 MiB bound");
        Reject(() => IceClassProtocol.Decode(Encoding.UTF8.GetBytes("{}")), "missing envelope fields");
        Reject(() => IceClassProtocol.ReadAsync(new MemoryStream([0xff,0xff,0xff,0x7f]), default).GetAwaiter().GetResult(), "length rejected before allocation");
        foreach (var value in new[] { "0", "1720000000000", "1.72e12", "9007199254740991" })
            Expect(ProtocolValidation.Integer(JsonSerializer.Deserialize<JsonElement>(value)) >= 0, "safe integer " + value);
        foreach (var value in new[] { "-1", "0.1", "9007199254740991.1", "9007199254740992", "\"1\"", "null", "1e100" })
            Reject(() => ProtocolValidation.Integer(JsonSerializer.Deserialize<JsonElement>(value)), "unsafe integer " + value);
        var normalized = ProtocolValidation.EventPayload("review_requested", JsonSerializer.Deserialize<JsonElement>("{\"generation\":4e0,\"capturedAt\":1.72e12}"));
        Expect(normalized["generation"] is long && normalized["capturedAt"] is long, "event numeric fields normalized to long");
        Reject(() => ProtocolValidation.EventPayload("review_requested", JsonSerializer.Deserialize<JsonElement>("{}")), "review generation required");
        Reject(() => ProtocolValidation.EventPayload("review_requested", JsonSerializer.Deserialize<JsonElement>("{\"generation\":1,\"generation\":2}")), "duplicate event fields rejected");
        var options = StartupOptions.Parse([]);
        Expect(options.DataDirectory.EndsWith(Path.Combine("ICeClass", "Receiver", "VideoBooth", "data"), StringComparison.Ordinal), "new independent default data directory");
        Expect(StartupOptions.Parse(["--data", ".", "--iceclass-pipe", "test"]).DataDirectory == Path.GetFullPath("."), "explicit data directory");
        Expect(StartupOptions.Parse(["--preview", "--data", "."]).PipeName is null, "preview opens independent interface without managed AI");
        Reject(() => StartupOptions.Parse(["--preview", "--iceclass-pipe", "test"]), "preview cannot imply a managed host");
        foreach (var invalid in new[] { new[] { "--data" }, new[] { "--headless" }, new[] { "--data", "a", "--data", "b" }, new[] { "--data", "--iceclass-pipe" } })
            Reject(() => StartupOptions.Parse(invalid), "invalid/legacy startup options rejected");
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass.VideoBooth.Checks", Guid.NewGuid().ToString("N"));
        using var lease = DataDirectoryLease.Acquire(directory);
        Reject(() => DataDirectoryLease.Acquire(directory + Path.DirectorySeparatorChar), "normalized data mutex rejects second instance");
        Expect(SiteAssets.Read("../Program.cs") is null && SiteAssets.Read("feedback-view.html") is null, "asset whitelist excludes paths and legacy feedback");
    }

    internal static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
        checks++;
        Console.WriteLine("PASS " + message);
    }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (Exception error) when (error is InvalidDataException or ArgumentException or JsonException or IOException or InvalidOperationException) { Expect(true,message); return; }
        throw new InvalidOperationException("Expected rejection: " + message);
    }
}

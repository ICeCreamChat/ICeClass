using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class TaskStopChecks
{
    internal static async Task Run(string output)
    {
        var checks = new List<string>();
        void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        var binding = new ReceiverConfig { Endpoint = "https://stop-check.invalid", DeviceId = Guid.NewGuid().ToString(), ClassId = "fixture" };
        var receiptRoot = Path.GetFullPath(Path.Combine(ClassroomAgentPolicy.Root, "receipts"));
        var receipts = Path.GetFullPath(Path.Combine(receiptRoot, ClassroomAgentPolicy.Identity(binding.Endpoint + "|" + binding.DeviceId + "|" + binding.ClassId)));
        using var agent = new ClassroomAgentService(() => new());
        var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        JsonElement Command(long issued) => JsonSerializer.SerializeToElement(new {
            commandId = Guid.NewGuid().ToString(), deviceId = binding.DeviceId, classId = binding.ClassId,
            issuedAt = issued, expiresAt = issued + 25000, parameters = new { action = "fixture_unsupported_action" } });
        bool Cancelled(JsonObject value) => value["cancelled"]?.GetValue<bool>() == true;
        try
        {
            agent.Stop();
            Check(agent.Status.Contains("没有"), "idle stop reports that no computer step is active");
            agent.BeginTaskStop();
            Check(Cancelled(await agent.ExecuteAsync(Command(time), binding, default)), "arriving commands are blocked while the whole turn is stopping");
            agent.CompleteTaskStop(time, true);
            Check(Cancelled(await agent.ExecuteAsync(Command(time), binding, default)), "a late command sent before the stop acknowledgement cannot run");
            var fresh = await agent.ExecuteAsync(Command(time + 1), binding, default);
            Check(!Cancelled(fresh) && fresh["success"]!.GetValue<bool>() == false, "a new command reaches action validation after the previous round stopped");
            var stopOnStart = true;
            void OnStatus(string status) { if (stopOnStart && status.StartsWith("正在执行：")) { stopOnStart = false; agent.Stop(); } }
            agent.StatusChanged += OnStatus;
            var active = await agent.ExecuteAsync(Command(time + 2), binding, default);
            agent.StatusChanged -= OnStatus;
            Check(Cancelled(active), "stopping an active step cancels it before any application input");
            agent.BeginTaskStop(); agent.TaskStopFailed();
            Check(Cancelled(await agent.ExecuteAsync(Command(time + 3), binding, default)), "a failed platform stop keeps local input paused");
            Check(agent.Status.Contains("请检查连接后重试"), "blocked arrivals do not erase the retry feedback after a failed platform stop");
            var expired = await agent.ExecuteAsync(Command(time - 31000), binding, default);
            Check(expired["success"]!.GetValue<bool>() == false && agent.Status.Contains("请检查连接后重试"), "expired arrivals preserve the retry feedback while local input remains paused");
            agent.CompleteTaskStop(time + 3, false);
            Check(agent.Status.Contains("没有待停止"), "an acknowledged idle stop clears the paused state and gives accurate feedback");
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "stop-checks.json"), JsonSerializer.Serialize(new { passed = checks.Count, checks }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} task stop checks passed.");
        }
        finally
        {
            if (!receipts.StartsWith(receiptRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Invalid fixture receipt directory.");
            if (Directory.Exists(receipts)) Directory.Delete(receipts, true);
        }
    }
}

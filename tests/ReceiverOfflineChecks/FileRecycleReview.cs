using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class FileRecycleReview
{
    internal static async Task Run(string output)
    {
        output = Path.GetFullPath(output);
        Directory.CreateDirectory(output);
        var folder = Path.Combine(output, "allowed"); Directory.CreateDirectory(folder);
        var name = "班班回收验收-" + Guid.NewGuid().ToString("N") + ".txt";
        var file = Path.Combine(folder, name);
        File.WriteAllText(file, "仅供班班回收功能验收，不是用户文稿。");
        File.WriteAllText(Path.Combine(folder, "not-a-document.ps1"), "fixture");
        var policy = new ClassroomAgentPolicy { AllowAllFolders = false, Folders = [folder] };
        var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:8866", DeviceId = Guid.NewGuid().ToString(), ClassId = Guid.NewGuid().ToString() };
        using var service = new ClassroomAgentService(() => policy);
        var checks = new List<string>();
        void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        JsonElement Command(object parameters, string? id = null) => JsonSerializer.SerializeToElement(new {
            commandId = id ?? Guid.NewGuid().ToString(), deviceId = config.DeviceId, classId = config.ClassId,
            issuedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), expiresAt = DateTimeOffset.UtcNow.AddSeconds(25).ToUnixTimeMilliseconds(), parameters });
        Task<JsonObject> RunAction(object parameters) => service.ExecuteAsync(Command(parameters), config, CancellationToken.None);
        async Task<string> Find()
        {
            var result = await RunAction(new { action = "list_files", query = name });
            var files = result["result"]!["files"]!.AsArray();
            Check(files.Count == 1 && files[0]!["name"]!.GetValue<string>() == name, "the exact fixture is found in its allowed folder");
            Check(files[0]!["canRecycle"]?.GetValue<bool>() == true, "a local document advertises recyclable capability");
            return files[0]!["id"]!.GetValue<string>();
        }
        try
        {
            var fileId = await Find();
            var unknown = await RunAction(new { action = "recycle_file", fileId = "not-observed" });
            Check(unknown["success"]!.GetValue<bool>() == false && File.Exists(file), "unobserved file identities cannot delete a document");
            policy.AllowInteraction = false;
            var readOnly = await RunAction(new { action = "recycle_file", fileId });
            Check(readOnly["success"]!.GetValue<bool>() == false && File.Exists(file), "view-only permission cannot recycle a file");
            policy.AllowInteraction = true;
            policy.Folders.Clear();
            var removed = await RunAction(new { action = "recycle_file", fileId });
            Check(removed["success"]!.GetValue<bool>() == false && File.Exists(file), "folder permission is rechecked before recycling");
            policy.Folders.Add(folder);
            File.AppendAllText(file, "文件已被修改，旧编号不再有效。");
            var changed = await RunAction(new { action = "recycle_file", fileId });
            Check(changed["success"]!.GetValue<bool>() == false && File.Exists(file), "a modified file cannot be recycled using an earlier observation");
            fileId = await Find();
            using (var locked = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None))
            {
                var busy = await RunAction(new { action = "recycle_file", fileId });
                Check(busy["success"]!.GetValue<bool>() == false && File.Exists(file), "an in-use document is not force-closed or forcibly deleted");
            }
            fileId = await Find();
            var command = Command(new { action = "recycle_file", fileId });
            var recycled = await service.ExecuteAsync(command, config, CancellationToken.None);
            Check(recycled["success"]!.GetValue<bool>() && recycled["result"]!["verified"]!.GetValue<bool>() &&
                recycled["result"]!["recycled"]!.GetValue<bool>() && !File.Exists(file), "the Windows recycle operation reports success and removes the exact source");
            File.WriteAllText(file, "不能因重复消息删除后来新建的同名文件。");
            await service.ExecuteAsync(command, config, CancellationToken.None);
            Check(File.Exists(file), "replaying a completed command cannot delete a replacement file");
            var stale = await RunAction(new { action = "recycle_file", fileId });
            Check(stale["success"]!.GetValue<bool>() == false && File.Exists(file), "a consumed file identity cannot select a replacement");
            var scripts = await RunAction(new { action = "list_files", query = "not-a-document" });
            Check(scripts["result"]!["files"]!.AsArray().Count == 0, "scripts and unsupported files never become recycle targets");
            Console.WriteLine($"{checks.Count} file recycle checks passed.");
        }
        finally
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { checks, source = file }, new JsonSerializerOptions { WriteIndented = true }));
        }
    }
}

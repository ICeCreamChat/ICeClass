using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class FileAccessReview
{
    internal static async Task Run(string output)
    {
        output = Path.GetFullPath(output);
        var allowed = Path.Combine(output, "selected");
        var outside = Path.Combine(output, "other-folder");
        var nested = Path.Combine(outside, "子文件夹");
        Directory.CreateDirectory(allowed);
        Directory.CreateDirectory(nested);
        File.WriteAllText(Path.Combine(allowed, "selected.txt"), "fixture");
        File.WriteAllText(Path.Combine(outside, "outside.txt"), "fixture");
        File.WriteAllText(Path.Combine(outside, "说明.md"), "fixture");
        File.WriteAllText(Path.Combine(outside, "do-not-run.ps1"), "fixture");
        File.WriteAllText(Path.Combine(nested, "nested.txt"), "fixture");
        var policy = new ClassroomAgentPolicy { Folders = [allowed] };
        var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:8866", DeviceId = Guid.NewGuid().ToString(), ClassId = Guid.NewGuid().ToString() };
        using var service = new ClassroomAgentService(() => policy);
        var checks = new List<string>();
        void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        Task<JsonObject> RunAction(object parameters) => service.ExecuteAsync(JsonSerializer.SerializeToElement(new {
            commandId = Guid.NewGuid().ToString(), deviceId = config.DeviceId, classId = config.ClassId,
            issuedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), expiresAt = DateTimeOffset.UtcNow.AddSeconds(25).ToUnixTimeMilliseconds(), parameters }), config, CancellationToken.None);
        try
        {
            var found = await RunAction(new { action = "list_files", folderPath = outside, query = "outside.txt" });
            Check(found["result"]?["files"]?.AsArray().Any(f => f?["name"]?.GetValue<string>() == "outside.txt") == true,
                "a new classroom installation finds a file outside individually selected folders by default");
            policy = JsonSerializer.Deserialize<ClassroomAgentPolicy>(JsonSerializer.Serialize(new {
                Enabled = true, AllowInteraction = true, Folders = new[] { allowed } }))!;
            var upgraded = await RunAction(new { action = "list_files", folderPath = outside, query = "outside.txt" });
            Check(upgraded["result"]?["files"]?.AsArray().Any(f => f?["name"]?.GetValue<string>() == "outside.txt") == true,
                "old classroom settings without the new option receive global file access on upgrade");
            var listed = await RunAction(new { action = "list_files", folderPath = outside, query = "*" });
            var result = listed["result"]!;
            Check(result["files"]!.AsArray().Count == 3, "wildcard browsing lists every ordinary file without searching for a literal star");
            Check(result["directories"]!.AsArray().Single()!["path"]!.GetValue<string>() == nested,
                "browsing returns actual child folder paths");
            Check(!result["files"]!.AsArray().Any(f => f?["name"]?.GetValue<string>() == "nested.txt"),
                "folder browsing does not mix in files from nested folders");
            var script = result["files"]!.AsArray().Single(f => f?["name"]?.GetValue<string>() == "do-not-run.ps1")!;
            Check(script["canOpen"]?.GetValue<bool>() == false, "full folder access does not turn file opening into script execution");
            var opening = await RunAction(new { action = "open_file", fileId = script["id"]!.GetValue<string>() });
            Check(opening["success"]?.GetValue<bool>() == false, "an observed script cannot be launched as a document");
            var recursive = await RunAction(new { action = "list_files", folderPath = outside, query = "nested", recursive = true });
            Check(recursive["result"]!["files"]!.AsArray().Single()!["name"]!.GetValue<string>() == "nested.txt",
                "an explicit recursive search can find files below the chosen folder");
            var relative = await RunAction(new { action = "list_files", folderPath = "../other-folder" });
            Check(relative["success"]?.GetValue<bool>() == false, "relative folder paths are rejected");
            var desktop = await RunAction(new { action = "list_files", folderPath = "桌面" });
            Check(desktop["result"]?["searchedFolders"]?.AsArray().Any(p => p?.GetValue<string>() == Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)) == true,
                "the desktop name resolves to the actual Windows desktop location");
            var pages = Path.Combine(output, "pages"); Directory.CreateDirectory(pages);
            foreach (var i in Enumerable.Range(0, 85)) File.WriteAllText(Path.Combine(pages, $"page-{i:D3}.txt"), "fixture");
            var first = (await RunAction(new { action = "list_files", folderPath = pages }))["result"]!;
            var next = first["nextOffset"]!.GetValue<int>();
            var second = (await RunAction(new { action = "list_files", folderPath = pages, offset = next }))["result"]!;
            Check(first["files"]!.AsArray().Count + second["files"]!.AsArray().Count == 85 &&
                !first["files"]!.AsArray().Select(f => f!["name"]!.GetValue<string>()).Intersect(second["files"]!.AsArray().Select(f => f!["name"]!.GetValue<string>())).Any(),
                "successive pages cover a directory without dropping or duplicating entries");
            var note = result["files"]!.AsArray().Single(f => f?["name"]?.GetValue<string>() == "说明.md")!;
            var recycled = await RunAction(new { action = "recycle_file", fileId = note["id"]!.GetValue<string>() });
            Check(recycled["result"]?["recycled"]?.GetValue<bool>() == true && !File.Exists(Path.Combine(outside, "说明.md")),
                "global access can recycle the exact observed ordinary file outside selected folders");
            policy = JsonSerializer.Deserialize<ClassroomAgentPolicy>(JsonSerializer.Serialize(new {
                AllowAllFolders = false, Folders = new[] { allowed } }))!;
            var denied = await RunAction(new { action = "list_files", folderPath = outside });
            Check(denied["success"]?.GetValue<bool>() == false, "an explicitly saved restriction still rejects an outside folder after upgrade");
            var revoked = await RunAction(new { action = "recycle_file", fileId = found["result"]!["files"]![0]!["id"]!.GetValue<string>() });
            Check(revoked["success"]?.GetValue<bool>() == false && File.Exists(Path.Combine(outside, "outside.txt")),
                "revoking global access prevents an earlier file identity from bypassing the new scope");
            policy = new ClassroomAgentPolicy { Enabled = false };
            var disabled = await RunAction(new { action = "list_files", folderPath = outside });
            Check(disabled["success"]?.GetValue<bool>() == false, "global file access does not re-enable disabled computer control");
            policy = new ClassroomAgentPolicy { AllowInteraction = false };
            var readOnly = await RunAction(new { action = "list_files", folderPath = outside, query = "outside.txt" });
            Check(readOnly["result"]?["files"]?.AsArray().Any(f => f?["name"]?.GetValue<string>() == "outside.txt") == true,
                "a classroom in read-only mode can still browse its folders");
            var readOnlyRecycle = await RunAction(new { action = "recycle_file", fileId = readOnly["result"]!["files"]![0]!["id"]!.GetValue<string>() });
            Check(readOnlyRecycle["success"]?.GetValue<bool>() == false && File.Exists(Path.Combine(outside, "outside.txt")),
                "global file access does not permit recycling while interaction is disabled");
            Console.WriteLine($"{checks.Count} file access checks passed.");
        }
        finally { File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { checks }, new JsonSerializerOptions { WriteIndented = true })); }
    }
}

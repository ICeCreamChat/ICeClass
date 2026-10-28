using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

internal static class FileRecycleOfficeReview
{
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)] private static extern int CLSIDFromProgID(string name, out Guid id);
    [DllImport("oleaut32.dll", PreserveSig = true)] private static extern int GetActiveObject(ref Guid id, nint reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
    internal static async Task Run(string output)
    {
        output = Path.GetFullPath(output); Directory.CreateDirectory(output);
        var checks = new List<string>();
        var owned = new List<object>();
        var created = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        void Check(bool passed, string name) { if (!passed) throw new Exception(name); checks.Add(name); }
        CLSIDFromProgID("Kwps.Application", out var writerId);
        var attached = GetActiveObject(ref writerId, 0, out var existingWriter) == 0 ? existingWriter : null;
        dynamic writer = Own(attached ?? Activator.CreateInstance(Type.GetTypeFromProgID("Kwps.Application", true)!)!);
        writer.Visible = true;
        dynamic documents = Own(writer.Documents);
        var policy = new ClassroomAgentPolicy { AllowAllFolders = false, Folders = [output] };
        var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:8866", DeviceId = Guid.NewGuid().ToString(), ClassId = Guid.NewGuid().ToString() };
        using var service = new ClassroomAgentService(() => policy);
        async Task<JsonObject> Action(object parameters)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return await service.ExecuteAsync(JsonSerializer.SerializeToElement(new { commandId = Guid.NewGuid().ToString(),
                deviceId = config.DeviceId, classId = config.ClassId, issuedAt = now, expiresAt = now + 25000, parameters }), config, CancellationToken.None);
        }
        async Task<JsonObject> Recycle(string name)
        {
            var listed = await Action(new { action = "list_files", query = name });
            var id = listed["result"]!["files"]!.AsArray().Single()!["id"]!.GetValue<string>();
            return await Action(new { action = "recycle_file", fileId = id });
        }
        try
        {
            var marker = "班班回收验证-" + Guid.NewGuid().ToString("N");
            dynamic sentinel = Own(documents.Add()); created.Add(sentinel);
            dynamic sentinelText = Own(sentinel.Content); sentinelText.Text = "这份无关验收文稿应保持原样。";
            var baseline = (string)sentinelText.Text;
            dynamic saved = Own(documents.Add()); created.Add(saved);
            dynamic savedText = Own(saved.Content); savedText.Text = "只删除本次创建且已保存的目标文稿。";
            var savedName = marker + "-saved.docx"; var savedPath = Path.Combine(output, savedName);
            saved.SaveAs2(savedPath);
            CLSIDFromProgID("Kwps.Application", out var activeId);
            var activeResult = GetActiveObject(ref activeId, 0, out var running);
            var fixtureInActive = 0;
            string? activePath = null;
            if (running is not null)
            {
                dynamic activeWriter = Own(running); activePath = (string)activeWriter.Path;
                dynamic activeDocs = Own(activeWriter.Documents);
                for (var index = 1; index <= (int)activeDocs.Count; index++)
                {
                    dynamic activeDoc = Own(activeDocs.Item(index));
                    if (string.Equals((string)activeDoc.FullName, savedPath, StringComparison.OrdinalIgnoreCase)) fixtureInActive++;
                }
            }
            File.WriteAllText(Path.Combine(output, "editor-diagnostic.json"), JsonSerializer.Serialize(new {
                createdPath = (string)writer.Path, activeResult, activePath, fixtureInActive,
                allowedPaths = policy.Available().Where(a => a.Kind == "wps-writer").Select(a => a.Path).ToArray() }));
            var receipt = await Recycle(savedName);
            File.WriteAllText(Path.Combine(output, "saved-receipt.json"), receipt.ToJsonString());
            Check(receipt["success"]!.GetValue<bool>() && receipt["result"]!["recycled"]!.GetValue<bool>() && !File.Exists(savedPath),
                "an exact saved Word document can be closed and recycled while its editor is open");
            Check((string)sentinelText.Text == baseline, "an unrelated open document stays open and unchanged");
            dynamic dirty = Own(documents.Add()); created.Add(dirty);
            dynamic dirtyText = Own(dirty.Content); dirtyText.Text = "保存时的正文。";
            var dirtyName = marker + "-dirty.docx"; var dirtyPath = Path.Combine(output, dirtyName);
            dirty.SaveAs2(dirtyPath); dirtyText.Text = "这段尚未保存的修改必须保留。";
            var dirtyBaseline = (string)dirtyText.Text;
            var denied = await Recycle(dirtyName);
            Check(denied["success"]!.GetValue<bool>() == false && File.Exists(dirtyPath) && (string)dirtyText.Text == dirtyBaseline,
                "a target with unsaved changes is neither closed nor recycled");
            Check((string)sentinelText.Text == baseline, "rejected recycling leaves other documents intact");
            Console.WriteLine($"{checks.Count} open-document recycle checks passed.");
        }
        finally
        {
            foreach (dynamic document in created.AsEnumerable().Reverse())
                try { document.Close(0); } catch (Exception error) when (error is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { checks }));
        }
    }
}

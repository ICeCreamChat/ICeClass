using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>One bounded operation at a time. The websocket receive loop remains free to stop it.</summary>
internal sealed class ClassroomAgentService : IDisposable
{
    private readonly SemaphoreSlim _serial = new(1, 1);
    private readonly ConcurrentDictionary<string, Lazy<Task<JsonObject>>> _jobs = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _active = new();
    private readonly Dictionary<string, ObservedFile> _files = new();
    private sealed record ObservedFile(string Path, long Length, long ModifiedTicks, long ObservedAt);
    private readonly object _fileGate = new();
    private readonly ClassroomAgentWorker _windows = new();
    private readonly Func<ClassroomAgentPolicy> _policyLoader;
    private readonly object _stopGate = new();
    private bool _stopping;
    private long _stoppedThrough;
    private string _binding = "";
    internal event Action<string>? StatusChanged;
    internal string Status { get; private set; } = "暂无电脑操作";

    internal ClassroomAgentService(Func<ClassroomAgentPolicy>? policyLoader = null)
        => _policyLoader = policyLoader ?? ClassroomAgentPolicy.Load;

    internal void Stop()
    {
        var active = false;
        foreach (var token in _active.Values)
        {
            try { token.Cancel(); active = true; }
            catch (ObjectDisposedException) { }
        }
        lock (_stopGate) { if (_stopping) return; }
        SetStatus(active ? "正在停止电脑操作…" : "当前没有正在执行的电脑操作");
    }

    internal void BeginTaskStop()
    {
        lock (_stopGate) _stopping = true;
        Stop();
        SetStatus("正在停止本轮任务…");
    }

    internal void CompleteTaskStop(long stoppedThrough, bool hadWork)
    {
        lock (_stopGate) { _stoppedThrough = Math.Max(_stoppedThrough, stoppedThrough); _stopping = false; }
        SetStatus(hadWork ? "本轮任务已停止；已完成的操作不会撤销" : "当前没有待停止的任务");
    }

    internal void TaskStopFailed() => SetStatus("本机操作已暂停，未能确认平台停止结果。请检查连接后重试。");

    private void SetStatus(string value) { Status = value; StatusChanged?.Invoke(value); }
    internal Task<JsonObject> ExecuteAsync(JsonElement command, ReceiverConfig binding, CancellationToken connection)
    {
        var id = Text(command, "commandId", 100);
        if (!Guid.TryParse(id, out _)) throw new InvalidOperationException("操作编号无效。");
        var copy = command.Clone();
        // A read-only image is transient, never an entry in the persistent
        // write-receipt or completed-task cache.
        if (copy.TryGetProperty("parameters", out var readArgs) && readArgs.TryGetProperty("action", out var readAction) &&
            readAction.GetString() == "capture_window") return RunAsync(copy, binding, connection);
        // Concurrent duplicate messages share the same task/result.
        return _jobs.GetOrAdd(id, _ => new Lazy<Task<JsonObject>>(() => RunAsync(copy, binding, connection))).Value;
    }

    private async Task<JsonObject> RunAsync(JsonElement command, ReceiverConfig config, CancellationToken connection)
    {
        var id = Text(command, "commandId", 100);
        JsonObject Reply(bool success, JsonObject? result = null, string? error = null, bool cancelled = false) => new()
        {
            ["type"] = "device_command_ack", ["commandId"] = id, ["action"] = "agent_control",
            ["success"] = success, ["cancelled"] = cancelled, ["result"] = result, ["error"] = error,
            ["outputVolume"] = ClassroomControlService.ReadVolume()
        };
        var entered = false;
        CancellationTokenSource? lifetime = null;
        try
        {
            ValidateEnvelope(command, config);
            var args = command.GetProperty("parameters");
            var action = Text(args, "action", 80);
            if (action == "stop")
            {
                if (args.TryGetProperty("operationId", out var stopId))
                {
                    var originalId = stopId.GetString() ?? "";
                    if (_active.TryGetValue(originalId, out var cancellation)) cancellation.Cancel();
                    else return Reply(false, error: "目标操作已结束或当前没有执行；已完成的操作不会撤销。");
                }
                else Stop();
                return Reply(true, new() { ["verified"] = true, ["detail"] = "已停止待执行输入；已完成的操作不会撤销。" });
            }
            var policy = _policyLoader();
            if (!policy.Enabled) throw new InvalidOperationException("本机已关闭班班电脑控制，请在教室端设置中开启。");
            if (!policy.AllowInteraction && action is not ("inspect" or "list_files" or "inspect_controls" or "wait_for_control" or "read_document" or "capture_window"))
                throw new InvalidOperationException("本机当前仅允许查看，请在教室端设置中允许操作。");
            // Never queue commands behind a long or hung application.
            entered = await _serial.WaitAsync(0, connection);
            if (!entered) throw new InvalidOperationException("本机正在执行另一项操作，请等待结果或停止。");
            lifetime = CancellationTokenSource.CreateLinkedTokenSource(connection);
            lifetime.CancelAfter(TimeSpan.FromSeconds(18));
            _active[id] = lifetime;
            // Block arrivals while the whole turn is being cancelled, including
            // commands already sent by the server before its stop acknowledgement.
            lock (_stopGate)
                if (_stopping || command.GetProperty("issuedAt").GetInt64() <= _stoppedThrough)
                    lifetime.Cancel();
            lifetime.Token.ThrowIfCancellationRequested();
            var bindingKey = config.Endpoint + "|" + config.DeviceId + "|" + config.ClassId;
            if (_binding != bindingKey) { _binding = bindingKey; lock (_fileGate) _files.Clear(); _windows.Reset(); }
            if (action == "capture_window")
            {
                var captured = await RunActionAsync(action, args, policy, config, lifetime.Token);
                lifetime.Token.ThrowIfCancellationRequested();
                SetStatus("已读取当前窗口画面");
                return Reply(true, captured);
            }
            var receipt = ReceiptPath(config, id);
            if (File.Exists(receipt))
                return JsonNode.Parse(await File.ReadAllTextAsync(receipt, lifetime.Token))?.AsObject() ?? Reply(false, error: "上次操作结果无法读取，未重复执行。");
            Directory.CreateDirectory(Path.GetDirectoryName(receipt)!);
            // Persist before touching another application, so restarting this
            // client can never replay an uncertain write/input operation.
            await File.WriteAllTextAsync(receipt, Reply(true, new() { ["verified"] = false, ["detail"] = "上次操作被中断，结果未确认，未重复执行。" }).ToJsonString(), lifetime.Token);
            SetStatus("正在执行：" + action);
            var result = await RunActionAsync(action, args, policy, config, lifetime.Token);
            lifetime.Token.ThrowIfCancellationRequested();
            var reply = Reply(true, result);
            var stored = reply.DeepClone().AsObject();
            ReleaseFrame(stored);
            await File.WriteAllTextAsync(receipt, stored.ToJsonString(), CancellationToken.None);
            SetStatus(result["detail"]?.GetValue<string>() ?? "电脑操作已完成");
            PruneReceipts(Path.GetDirectoryName(receipt)!);
            return reply;
        }
        catch (OperationCanceledException)
        {
            bool stopping;
            lock (_stopGate) stopping = _stopping;
            if (!stopping) SetStatus("电脑操作已停止；已完成的操作不会撤销");
            return Reply(false, new() { ["verified"] = false }, "操作已停止；已完成的操作不会撤销。", true);
        }
        catch (Exception error)
        {
            AppLog.Error("Classroom agent operation failed", error);
            lock (_stopGate)
                if (!_stopping) SetStatus("电脑操作未完成：" + error.Message);
            return Reply(false, error: error.Message);
        }
        finally
        {
            _active.TryRemove(id, out _);
            lifetime?.Dispose();
            if (entered) _serial.Release();
            // Retain completed tasks until their short command lifetime ends.
            if (_jobs.Count > 300)
                foreach (var old in _jobs.Where(p => p.Value.IsValueCreated && p.Value.Value.IsCompleted).Take(100)) _jobs.TryRemove(old.Key, out _);
        }
    }

    internal static void ReleaseFrame(JsonObject reply)
    {
        if (reply["result"] is JsonObject result && result["screenshot"] is JsonObject screenshot) screenshot.Remove("dataUrl");
    }

    internal static void ValidateEnvelope(JsonElement command, ReceiverConfig config, long? clock = null)
    {
        var now = clock ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Text(command, "deviceId", 80) != config.DeviceId || Text(command, "classId", 80) != config.ClassId)
            throw new InvalidOperationException("教室绑定已变化，此操作不会执行。");
        var issued = command.GetProperty("issuedAt").GetInt64();
        var expires = command.GetProperty("expiresAt").GetInt64();
        if (issued > now + 5000 || issued < now - 30000 || expires <= now || expires > issued + 30000)
            throw new InvalidOperationException("操作已过期，请重新提出操作。");
        if (!command.TryGetProperty("parameters", out var args) || args.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("操作参数无效。");
    }

    private async Task<JsonObject> RunActionAsync(string action, JsonElement args, ClassroomAgentPolicy policy, ReceiverConfig config, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var applications = policy.Available(config);
        if (action == "inspect")
        {
            var result = await _windows.InspectAsync(applications, token);
            result["applications"] = new JsonArray(applications.Select(a => (JsonNode)new JsonObject { ["id"] = a.Id, ["name"] = a.Name, ["kind"] = a.Kind }).ToArray());
            var fileLocations = policy.FileLocations();
            result["folders"] = new JsonArray(fileLocations.Select(p => (JsonNode)JsonValue.Create(p.Name)).ToArray());
            result["fileAccess"] = policy.AllowAllFolders ? "all_folders" : "selected_folders";
            result["fileLocations"] = new JsonArray(fileLocations.Select(p => (JsonNode)new JsonObject { ["name"] = p.Name, ["path"] = p.Path }).ToArray());
            result["outputVolume"] = ClassroomControlService.ReadVolume();
            result["interactionAllowed"] = policy.AllowInteraction;
            result["detail"] = "已读取当前允许的应用和窗口。";
            return result;
        }
        if (action == "list_files") return ListFiles(policy, args, token);
        if (action == "recycle_file")
        {
            var fileId = Text(args, "fileId", 100);
            ObservedFile? file;
            lock (_fileGate) _files.TryGetValue(fileId, out file);
            if (file is null || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - file.ObservedAt >= 120000)
                throw new InvalidOperationException("文件信息已过期或已经使用，请重新查找指定文件。");
            if (!policy.FileVisible(file.Path)) throw new InvalidOperationException("文件已移动或不在当前允许的文件夹中，请重新查找。");
            var result = await _windows.OperateAsync(action, JsonSerializer.SerializeToElement(new {
                path = file.Path, length = file.Length, modifiedTicks = file.ModifiedTicks }), applications, token);
            if (result["recycled"]?.GetValue<bool>() == true) lock (_fileGate) _files.Remove(fileId);
            return result;
        }
        if (action == "set_volume")
        {
            var volume = args.GetProperty("volume").GetInt32();
            return new() { ["outputVolume"] = ClassroomControlService.SetVolume(volume), ["verified"] = true, ["detail"] = "已读取并确认系统音量。" };
        }
        if (action == "open_reading")
        {
            await ClassroomControlService.OpenReadingAsync(config, token);
            return new() { ["verified"] = true, ["detail"] = "早读陪伴已打开。" };
        }
        if (action is "open_app" or "open_file" or "open_website")
        {
            var appId = Text(args, "appId", 100, false);
            string? path = null;
            if (action == "open_file")
            {
                var fileId = Text(args, "fileId", 100);
                lock (_fileGate) path = _files.GetValueOrDefault(fileId)?.Path;
                if (path is null || !policy.FileAllowed(path)) throw new InvalidOperationException("文件已移动、不在允许文件夹中或不是可打开的文档类型，请重新查找。");
            }
            var app = applications.SingleOrDefault(a => a.Id == appId);
            if (app is null && action == "open_file" && string.IsNullOrEmpty(appId))
            {
                var extension = Path.GetExtension(path!);
                var kinds = extension.ToLowerInvariant() switch
                {
                    ".ppt" or ".pptx" or ".pps" or ".ppsx" or ".dps" or ".dpt" => new[] { "powerpoint", "wps-presentation" },
                    ".doc" or ".docx" or ".wps" => new[] { "word", "wps-writer" },
                    ".xls" or ".xlsx" or ".et" => new[] { "excel", "wps-sheet" },
                    ".enb" or ".enbx" or ".enpx" => new[] { "seewo" }, _ => new[] { "browser" }
                };
                app = kinds.Select(kind => applications.FirstOrDefault(a => a.Kind == kind)).FirstOrDefault(a => a is not null);
            }
            if (app is null && action == "open_website" && string.IsNullOrEmpty(appId)) app = applications.FirstOrDefault(a => a.Kind == "browser");
            if (app is null) throw new InvalidOperationException("应用未安装或未在本机允许，请先查看应用或在教室端添加。");
            if (action == "open_website" && app.Kind != "browser") throw new InvalidOperationException("请选择允许的浏览器。");
            if (action == "open_app")
            {
                var current = await _windows.InspectAsync(applications, token);
                var existing = current["windows"]!.AsArray().FirstOrDefault(w => w?["appId"]?.GetValue<string>() == app.Id);
                if (existing is not null)
                {
                    var focused = await _windows.OperateAsync("maximize_window", JsonSerializer.SerializeToElement(new { targetId = existing["id"]!.GetValue<string>() }), applications, token);
                    return focused;
                }
            }
            var start = new ProcessStartInfo(app.Path) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(app.Path)! };
            if (action == "open_file") start.ArgumentList.Add(path!);
            if (action == "open_website") start.ArgumentList.Add(Website(Text(args, "url", 1000)));
            token.ThrowIfCancellationRequested();
            using var launched = Process.Start(start) ?? throw new InvalidOperationException("应用未启动。");
            var clock = Stopwatch.StartNew();
            JsonObject result;
            do
            {
                await Task.Delay(150, token);
                result = await _windows.InspectAsync(applications, token);
                if (result["windows"]!.AsArray().Any(w => w?["appId"]?.GetValue<string>() == app.Id)) break;
            } while (clock.Elapsed < TimeSpan.FromSeconds(5));
            var visible = result["windows"]!.AsArray().FirstOrDefault(w => w?["appId"]?.GetValue<string>() == app.Id);
            if (visible is not null)
                result = await _windows.OperateAsync("maximize_window", JsonSerializer.SerializeToElement(new { targetId = visible["id"]!.GetValue<string>() }), applications, token);
            // Window presentation is observable; document/network load is not.
            if (action != "open_app" || visible is null)
            {
                result["verified"] = false;
                result["detail"] = action == "open_file" ? "已启动课件打开请求，请核对窗口中的文件。" : action == "open_website" ? "已向浏览器发送地址，请核对网页是否加载。" : "已发出启动请求，暂未看到应用窗口。";
            }
            return result;
        }
        return await _windows.OperateAsync(action, args, applications, token);
    }

    internal static string Website(string value)
    {
        if (value.Any(char.IsControl) || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo) || uri.IsLoopback || string.IsNullOrWhiteSpace(uri.Host))
            throw new InvalidOperationException("请使用完整的 HTTPS 教学网站地址。");
        return uri.AbsoluteUri;
    }

    private JsonObject ListFiles(ClassroomAgentPolicy policy, JsonElement args, CancellationToken token)
    {
        var query = Text(args, "query", 100, false).Trim();
        if (query is "*" or "*.*") query = "";
        var requested = Text(args, "folderPath", 4096, false);
        var recursive = query.Length > 0;
        if (args.TryGetProperty("recursive", out var recurse))
        {
            if (recurse.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidOperationException("请明确是否搜索子文件夹。");
            recursive = recurse.GetBoolean();
        }
        var offset = 0;
        if (args.TryGetProperty("offset", out var page) && (page.ValueKind != JsonValueKind.Number || !page.TryGetInt32(out offset) || offset is < 0 or > 5000))
            throw new InvalidOperationException("文件列表位置无效，请重新浏览文件夹。");
        var locations = policy.FileLocations();
        var roots = requested.Length > 0 ? new[] { policy.ResolveFolder(requested) } : locations.Select(l => l.Path).ToArray();
        if (requested.Length > 0 && !policy.FolderAllowed(roots[0]))
            throw new InvalidOperationException("文件夹不存在、当前 Windows 账号无法访问，或未在本机允许范围内。");
        var files = new JsonArray();
        var directories = new JsonArray();
        var scanned = 0;
        var matched = 0;
        var more = false;
        var incomplete = false;
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_fileGate)
            foreach (var old in _files.Where(pair => now - pair.Value.ObservedAt >= 120000).Select(pair => pair.Key).ToArray()) _files.Remove(old);
        var options = new EnumerationOptions { RecurseSubdirectories = recursive, IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.ReparsePoint | (policy.AllowAllFolders ? 0 : FileAttributes.Hidden | FileAttributes.System) };
        foreach (var folder in roots.Where(policy.FolderAllowed))
        {
            try
            {
                foreach (var path in Directory.EnumerateFileSystemEntries(folder, "*", options))
                {
                    token.ThrowIfCancellationRequested();
                    if (!visited.Add(path)) continue;
                    if (++scanned > 5000) { incomplete = true; break; }
                    if (!Path.GetFileName(path).Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                    var isDirectory = Directory.Exists(path);
                    if (isDirectory ? !policy.FolderAllowed(path) : !policy.FileVisible(path)) continue;
                    if (matched++ < offset) continue;
                    if (files.Count + directories.Count >= 80) { more = true; break; }
                    if (isDirectory)
                    {
                        directories.Add(new JsonObject { ["name"] = Path.GetFileName(path), ["path"] = path });
                        continue;
                    }
                    var info = new FileInfo(path);
                    if (!info.Exists) continue;
                    var id = Guid.NewGuid().ToString("N");
                    lock (_fileGate) _files[id] = new(path, info.Length, info.LastWriteTimeUtc.Ticks, now);
                    files.Add(new JsonObject { ["id"] = id, ["name"] = info.Name, ["folder"] = folder, ["path"] = path,
                        ["relativePath"] = Path.GetRelativePath(folder, path), ["canOpen"] = policy.FileAllowed(path),
                        ["canRecycle"] = ClassroomAgentFiles.CanRecycle(path) });
                }
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                if (requested.Length > 0) throw new InvalidOperationException("无法读取这个文件夹，请检查 Windows 文件夹权限或磁盘连接。", error);
                incomplete = true;
            }
            if (scanned > 5000 || more) break;
        }
        return new() { ["files"] = files, ["directories"] = directories, ["searchedFolders"] = new JsonArray(roots.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()),
            ["fileCount"] = files.Count, ["directoryCount"] = directories.Count,
            ["fileAccess"] = policy.AllowAllFolders ? "all_folders" : "selected_folders", ["truncated"] = more || incomplete,
            ["nextOffset"] = more ? offset + files.Count + directories.Count : null, ["searchIncomplete"] = incomplete, ["verified"] = true,
            ["detail"] = roots.Length == 0 ? "尚未设置可访问文件夹。" : incomplete ? "已返回当前查找到的内容；搜索未覆盖全部文件，请指定更具体的文件夹继续。" :
                more ? "还有更多内容，可从 nextOffset 继续浏览。" : files.Count + directories.Count == 0 ? "所查文件夹中没有匹配的内容。" : "已读取所查文件夹中的文件和子文件夹。" };
    }

    internal static string Text(JsonElement source, string name, int max, bool required = true)
    {
        if (!source.TryGetProperty(name, out var node)) return required ? throw new InvalidOperationException("缺少操作参数：" + name) : "";
        if (node.ValueKind != JsonValueKind.String || node.GetString() is not string value || value.Length > max || required && string.IsNullOrWhiteSpace(value) || value.Contains('\0'))
            throw new InvalidOperationException("操作参数格式不正确：" + name);
        return value;
    }

    private static string ReceiptPath(ReceiverConfig config, string id) => Path.Combine(ClassroomAgentPolicy.Root, "receipts", ClassroomAgentPolicy.Identity(config.Endpoint + "|" + config.DeviceId + "|" + config.ClassId), id + ".json");
    private static void PruneReceipts(string folder)
    {
        try { foreach (var path in new DirectoryInfo(folder).EnumerateFiles("*.json").Where(f => f.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-1))) path.Delete(); }
        catch (IOException) { }
    }
    public void Dispose() { Stop(); _windows.Reset(); }
}

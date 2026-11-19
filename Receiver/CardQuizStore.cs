using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>One durable journal per classroom session. Sync metadata never rewrites a confirmed event.</summary>
internal sealed class CardQuizStore
{
    private readonly string _root, _classId, _deviceId;
    private readonly object _gate = new();
    internal CardQuizStore(string root, string classId, string deviceId)
    {
        _root = Path.GetFullPath(root); _classId = classId; _deviceId = deviceId;
        Directory.CreateDirectory(Path.Combine(_root, "sessions"));
    }
    private string SessionPath(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("课堂编号无效。");
        return Path.Combine(_root, "sessions", id + ".json");
    }
    internal JsonObject? Read(string id)
    {
        lock (_gate)
        {
            var path = SessionPath(id);
            return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : null;
        }
    }
    internal JsonObject Load()
    {
        lock (_gate)
        {
            var journals = new JsonArray(); var errors = new JsonArray();
            foreach (var file in Directory.EnumerateFiles(Path.Combine(_root, "sessions"), "*.json"))
            {
                try
                {
                    var journal = JsonNode.Parse(File.ReadAllText(file))!.AsObject(); Validate(journal);
                    journals.Add(journal);
                }
                catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException or IOException)
                { errors.Add($"课堂 {Path.GetFileNameWithoutExtension(file)} 的本机记录无法读取，原文件已保留，请核对。"); }
            }
            return new JsonObject { ["journals"] = journals, ["errors"] = errors };
        }
    }
    private void Validate(JsonObject journal)
    {
        try
        {
            if (journal["session"] is not JsonObject session || session["classId"]?.GetValue<string>() != _classId ||
                session["deviceId"]?.GetValue<string>() != _deviceId || session["schema"]?.GetValue<int>() != 1 ||
                session["seq"]?.GetValue<int>() is not int seq || seq < 0 || seq > 100_000 ||
                journal["events"] is not JsonArray events || events.Count != seq || journal["receipts"] is not JsonObject receipts || receipts.Count != seq)
                throw new InvalidDataException("课堂归属、序号、事件或请求回执不完整。");
            var sessionId = session["id"]?.GetValue<string>() ?? ""; _ = SessionPath(sessionId);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < events.Count; i++)
            {
                if (events[i] is not JsonObject e || e["seq"]?.GetValue<int>() != i + 1 ||
                    !Guid.TryParseExact(e["id"]?.GetValue<string>(), "D", out _) || !ids.Add(e["id"]!.GetValue<string>()))
                    throw new InvalidDataException("课堂确认事件缺序或编号重复。");
                var id = e["id"]!.GetValue<string>();
                if (e["action"]?.GetValue<string>() is not string action || action is not
                    ("add_question" or "start_round" or "answer" or "end_round" or "resume_round" or "recover" or "set_source" or "set_multi_option" or "edit_question" or "reveal" or "set_exempt" or "end_session") ||
                    e["payload"] is not JsonObject || e["at"]?.GetValueKind() != JsonValueKind.Number || e["at"]!.Deserialize<long>() < 0 ||
                    e["generation"]?.GetValue<int>() is not int generation || generation < 1 ||
                    string.IsNullOrEmpty(e["sourceId"]?.GetValue<string>()) ||
                    receipts[id] is not JsonObject receipt || receipt["fingerprint"]?.GetValue<string>() is not string fingerprint ||
                    JsonNode.Parse(fingerprint) is not JsonObject command ||
                    command["id"]?.GetValue<string>() != id || command["sessionId"]?.GetValue<string>() != sessionId || command["action"]?.GetValue<string>() != action ||
                    !JsonNode.DeepEquals(command["payload"] ?? new JsonObject(), e["payload"]) ||
                    !JsonNode.DeepEquals(command["generation"], e["generation"]) || !JsonNode.DeepEquals(command["sourceId"], e["sourceId"]) ||
                    !JsonNode.DeepEquals(command["questionId"], e["questionId"]) || !JsonNode.DeepEquals(command["roundId"], e["roundId"]) ||
                    receipt["result"] is not JsonObject result || result["seq"]?.GetValue<int>() != i + 1 || result["status"]?.GetValue<string>() != "confirmed" ||
                    result["state"] is not JsonObject state || state["sessionId"]?.GetValue<string>() != sessionId || state["seq"]?.GetValue<int>() != i + 1)
                    throw new InvalidDataException("课堂事件与请求指纹、确认回执或序号不一致。");
                foreach (var key in new[] { "questionId", "roundId" })
                    if (e[key] is not null && !Guid.TryParseExact(e[key]!.GetValue<string>(), "D", out _))
                        throw new InvalidDataException("课堂事件的题目或轮次编号无效。");
            }
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException or ArgumentException)
        { throw new InvalidDataException("课堂记录或请求回执格式无效，原文件已保留，请核对。", error); }
    }
    internal JsonObject Commit(JsonObject input)
    {
        lock (_gate)
        {
            var journal = input.DeepClone().AsObject(); Validate(journal);
            var s = journal["session"]!; var id = s["id"]!.GetValue<string>(); var seq = s["seq"]!.GetValue<int>();
            var previous = Read(id);
            if (previous is null)
            {
                if (seq != 0) throw new InvalidDataException("请先保存课堂初始状态。");
                journal["syncedSeq"] = 0; journal["reviewError"] = null;
            }
            else
            {
                Validate(previous); var oldSeq = previous["session"]!["seq"]!.GetValue<int>();
                if (seq == oldSeq)
                {
                    if (!JsonNode.DeepEquals(previous["session"], s) || !JsonNode.DeepEquals(previous["events"], journal["events"]) ||
                        !JsonNode.DeepEquals(previous["receipts"], journal["receipts"]))
                        throw new InvalidDataException("同一确认序号的内容不同，原记录已保留。");
                    return previous;
                }
                if (seq != oldSeq + 1 || previous["session"]!["endedAt"] is not null)
                    throw new InvalidDataException("课堂已结束或确认序号不连续，请重新打开核对。");
                for (var i = 0; i < oldSeq; i++)
                    if (!JsonNode.DeepEquals(previous["events"]![i], journal["events"]![i]))
                        throw new InvalidDataException("已确认事件不能改写。");
                foreach (var receipt in previous["receipts"]!.AsObject())
                    if (!JsonNode.DeepEquals(receipt.Value, journal["receipts"]![receipt.Key]))
                        throw new InvalidDataException("已确认请求的回执不能改写。");
                foreach (var oldQuestion in previous["session"]!["questions"]?.AsArray() ?? new JsonArray())
                {
                    var question = s["questions"]?.AsArray().FirstOrDefault(q => JsonNode.DeepEquals(q?["id"], oldQuestion?["id"]));
                    foreach (var oldRound in oldQuestion?["rounds"]?.AsArray() ?? new JsonArray())
                    {
                        if (oldRound?["status"]?.GetValue<string>() != "closed") continue;
                        var round = question?["rounds"]?.AsArray().FirstOrDefault(r => JsonNode.DeepEquals(r?["id"], oldRound["id"]));
                        if (!JsonNode.DeepEquals(oldRound, round))
                            throw new InvalidDataException("已封存轮次的作答和免答记录不能改写。");
                    }
                }
                journal["syncedSeq"] = previous["syncedSeq"]?.DeepClone() ?? JsonValue.Create(0);
                journal["reviewError"] = previous["reviewError"]?.DeepClone();
            }
            var json = journal.ToJsonString();
            if (Encoding.UTF8.GetByteCount(json) > 16 * 1024 * 1024) throw new InvalidDataException("本课堂记录已达到保存上限，请结束后另开课堂。");
            Write(SessionPath(id), json); return journal;
        }
    }
    internal void MarkSynced(string id, int through)
    {
        lock (_gate)
        {
            var journal = Read(id) ?? throw new InvalidDataException("本机课堂不存在。");
            if (through < (journal["syncedSeq"]?.GetValue<int>() ?? 0) || through > journal["session"]!["seq"]!.GetValue<int>())
                throw new InvalidDataException("同步回执序号无效。");
            journal["syncedSeq"] = through; journal["reviewError"] = null; Write(SessionPath(id), journal.ToJsonString());
        }
    }
    internal void MarkReview(string id, string reason)
    {
        lock (_gate)
        {
            var journal = Read(id) ?? throw new InvalidDataException("本机课堂不存在。");
            journal["reviewError"] = reason; Write(SessionPath(id), journal.ToJsonString());
        }
    }
    private string CachePath(string name)
    {
        if (name != "context"
            && !(name.StartsWith("publication-", StringComparison.Ordinal) && Guid.TryParseExact(name[12..], "D", out _))
            && !(name.StartsWith("receipt-", StringComparison.Ordinal) && Guid.TryParseExact(name[8..], "D", out _)))
            throw new InvalidDataException("缓存编号无效。");
        return Path.Combine(_root, "cache", name + ".json");
    }
    internal JsonObject? LoadCache(string name)
    {
        lock (_gate) { var path = CachePath(name); return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : null; }
    }
    internal void SaveCache(string name, JsonObject value) { lock (_gate) Write(CachePath(name), value.ToJsonString()); }
    private static void Write(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                file.Write(Encoding.UTF8.GetBytes(value)); file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

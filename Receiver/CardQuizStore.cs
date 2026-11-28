using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>One durable journal per classroom session. Sync metadata never rewrites a confirmed event.</summary>
internal sealed class CardQuizStore
{
    private readonly string _root, _classId, _deviceId;
    private readonly object _gate = new();
    private readonly Dictionary<string, (FileStamp Stamp, JournalStatus Status)> _statuses = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (FileStamp Stamp, int Seq)> _receiptProgress = new(StringComparer.OrdinalIgnoreCase);

    private readonly record struct FileStamp(long Length, DateTime LastWrite)
    {
        internal static FileStamp Of(FileInfo file) => new(file.Length, file.LastWriteTimeUtc);
    }

    // Keep just the fields used by the status line and the list of recoverable lessons.
    private sealed record JournalStatus(string Id, int Seq, int SyncedSeq, string? ReviewError,
        string? SubjectId, long? StartedAt, long? EndedAt)
    {
        internal JsonObject ToJson() => new() {
            ["session"] = new JsonObject { ["id"] = Id, ["seq"] = Seq, ["subjectId"] = SubjectId,
                ["startedAt"] = StartedAt, ["endedAt"] = EndedAt },
            ["syncedSeq"] = SyncedSeq, ["reviewError"] = ReviewError
        };
    }
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
    private JsonObject ReadJournal(FileInfo file)
    {
        var stamp = FileStamp.Of(file);
        var journal = JsonNode.Parse(File.ReadAllText(file.FullName)) as JsonObject ?? throw new InvalidDataException("课堂记录格式无效。");
        Validate(journal);
        var session = journal["session"]!;
        var id = session["id"]!.GetValue<string>();
        if (!string.Equals(file.Name, id + ".json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("课堂编号与本机记录不匹配。");
        _statuses[file.FullName] = (stamp, new JournalStatus(id, session["seq"]!.GetValue<int>(),
            journal["syncedSeq"]?.GetValue<int>() ?? 0, journal["reviewError"]?.GetValue<string>(),
            session["subjectId"]?.GetValue<string>(), session["startedAt"]?.GetValue<long>(), session["endedAt"]?.GetValue<long>()));
        return journal;
    }
    internal JsonObject ReadJournal(string id)
    {
        lock (_gate)
        {
            try { return ReadJournal(new FileInfo(SessionPath(id))); }
            catch (FileNotFoundException) { throw new InvalidDataException("本机课堂不存在。"); }
        }
    }
    private JournalStatus Status(FileInfo file)
    {
        if (_statuses.TryGetValue(file.FullName, out var cached) && cached.Stamp == FileStamp.Of(file)) return cached.Status;
        ReadJournal(file);
        return _statuses[file.FullName].Status;
    }
    private IEnumerable<T> ReadSessions<T>(Func<FileInfo, T> read, JsonArray? errors = null)
    {
        foreach (var file in new DirectoryInfo(Path.Combine(_root, "sessions")).EnumerateFiles("*.json"))
        {
            T value;
            try { value = read(file); }
            catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException
                or IOException or UnauthorizedAccessException or FormatException or OverflowException)
            {
                errors?.Add($"课堂 {Path.GetFileNameWithoutExtension(file.Name)} 的本机记录无法读取，原文件已保留，请核对。");
                continue;
            }
            yield return value;
        }
    }
    internal JsonObject Load(string? sessionId = null)
    {
        lock (_gate)
        {
            var errors = new JsonArray();
            var journals = sessionId is null ? new JsonArray(ReadSessions(ReadJournal, errors).ToArray()) : new JsonArray(ReadJournal(sessionId));
            return new JsonObject { ["journals"] = journals, ["errors"] = errors };
        }
    }
    internal JsonObject LoadStatus(string? currentId = null)
    {
        lock (_gate)
        {
            var errors = new JsonArray();
            var journals = ReadSessions(Status, errors).Where(s => currentId is null ||
                string.Equals(s.Id, currentId, StringComparison.OrdinalIgnoreCase) ||
                s.EndedAt is null || s.SyncedSeq < s.Seq || !string.IsNullOrEmpty(s.ReviewError));
            return new JsonObject { ["journals"] = new JsonArray(journals.Select(s => s.ToJson()).ToArray()), ["errors"] = errors };
        }
    }
    internal string[] PendingSessionIds(bool retry)
    {
        lock (_gate)
            return ReadSessions(Status).Where(s => (retry || string.IsNullOrEmpty(s.ReviewError)) &&
                (s.SyncedSeq != s.Seq || ReceiptSequence(s.Id) != s.Seq)).Select(s => s.Id).ToArray();
    }
    private int? ReceiptSequence(string id)
    {
        var file = new FileInfo(CachePath("receipt-" + id));
        if (!file.Exists) return 0; // Legacy journals may have events on the server but no receipt checkpoint.
        try
        {
            var stamp = FileStamp.Of(file);
            if (_receiptProgress.TryGetValue(file.FullName, out var cached) && cached.Stamp == stamp) return cached.Seq;
            var seq = LoadCache("receipt-" + id)?["seq"]?.GetValue<int>() ?? 0;
            _receiptProgress[file.FullName] = (stamp, seq);
            return seq;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or IOException or FormatException)
        { return null; } // Let the sync attempt report the unreadable checkpoint and retry it.
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
                if (seq != 0 && (seq != 1 || !StartsWithQuestion(s, journal["events"]![0]!)))
                    throw new InvalidDataException("课堂首次保存须包含初始状态或完整的第一题。");
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
            WriteJournal(id, json); return journal;
        }
    }
    private static bool StartsWithQuestion(JsonNode session, JsonNode entry)
    {
        if (entry["action"]?.GetValue<string>() != "add_question" ||
            entry["questionId"] is not null || entry["roundId"] is not null ||
            entry["sourceId"]?.GetValue<string>() != "board" || entry["generation"]?.GetValue<int>() != 1 ||
            session["questions"] is not JsonArray { Count: 1 } questions ||
            questions[0] is not JsonObject question || question["rounds"] is not JsonArray { Count: 0 })
            return false;

        return session["endedAt"] is null && session["currentRoundId"] is null &&
            session["source"]?.GetValue<string>() == "board" && session["sourceId"]?.GetValue<string>() == "board" &&
            session["generation"]?.GetValue<int>() == 2 &&
            Guid.TryParseExact(question["id"]?.GetValue<string>(), "D", out _) &&
            JsonNode.DeepEquals(session["currentQuestionId"], question["id"]);
    }

    internal void MarkSynced(string id, int through)
    {
        lock (_gate)
        {
            var journal = Read(id) ?? throw new InvalidDataException("本机课堂不存在。");
            if (through < (journal["syncedSeq"]?.GetValue<int>() ?? 0) || through > journal["session"]!["seq"]!.GetValue<int>())
                throw new InvalidDataException("同步回执序号无效。");
            journal["syncedSeq"] = through; journal["reviewError"] = null; WriteJournal(id, journal.ToJsonString());
        }
    }
    internal void MarkReview(string id, string reason)
    {
        lock (_gate)
        {
            var journal = Read(id) ?? throw new InvalidDataException("本机课堂不存在。");
            journal["reviewError"] = reason; WriteJournal(id, journal.ToJsonString());
        }
    }
    private void WriteJournal(string id, string json)
    {
        var path = SessionPath(id);
        Write(path, json);
        _statuses.Remove(path);
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
    internal void SaveCache(string name, JsonObject value)
    {
        lock (_gate)
        {
            var path = CachePath(name);
            Write(path, value.ToJsonString());
            _receiptProgress.Remove(path);
        }
    }
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

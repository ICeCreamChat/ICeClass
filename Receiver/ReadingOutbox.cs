using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>Each acknowledged local write is durable independently of the WebView and network.</summary>
internal sealed class ReadingOutbox
{
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, ReadingOutbox> Shared = new(StringComparer.OrdinalIgnoreCase);
    internal static ReadingOutbox Open(string root) => Shared.GetOrAdd(Path.GetFullPath(root), path => new ReadingOutbox(path));
    private readonly string _root;
    private readonly object _gate = new();
    private int _pending, _review;
    internal ReadingOutbox(string root)
    {
        _root = root; Directory.CreateDirectory(Queue);
        _pending = Directory.GetFiles(Queue, "*.json").Length;
        _review = Directory.Exists(Review) ? Directory.GetFiles(Review, "*.json").Length : 0;
    }
    private string Queue => Path.Combine(_root, "pending");
    private string Review => Path.Combine(_root, "review");
    public int Pending { get { lock (_gate) return _pending; } }
    public int ReviewCount { get { lock (_gate) return _review; } }
    public string? LoadContext() { lock (_gate) return File.Exists(Path.Combine(_root, "context.json")) ? File.ReadAllText(Path.Combine(_root, "context.json")) : null; }
    public void SaveContext(string json) { lock (_gate) Write(Path.Combine(_root, "context.json"), json); }

    public void Store(JsonObject batch)
    {
        var id = batch["id"]?.GetValue<string>() ?? "";
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("记录编号无效。");
        var json = batch.ToJsonString();
        if (json.Length > 128 * 1024) throw new InvalidDataException("单组记录过大。");
        lock (_gate)
        {
            var path = Path.Combine(Queue, id + ".json");
            if (File.Exists(path))
            {
                if (File.ReadAllText(path) != json) throw new InvalidDataException("记录编号冲突。");
                return;
            }
            Write(path, json);
            ++_pending;
        }
    }

    public List<JsonObject> Peek(int limit = 60)
    {
        lock (_gate)
        {
            var result = new List<JsonObject>();
            foreach (var path in Directory.EnumerateFiles(Queue, "*.json").Take(limit).ToArray())
            {
                try { result.Add(JsonNode.Parse(File.ReadAllText(path))!.AsObject()); }
                catch (Exception error) when (error is JsonException or InvalidOperationException)
                { MoveToReview(Path.GetFileNameWithoutExtension(path), "本地记录文件损坏，原文件已保留。"); }
            }
            return result;
        }
    }

    public void Acknowledge(IEnumerable<string> ids)
    {
        lock (_gate)
            foreach (var id in ids)
                if (Guid.TryParseExact(id, "D", out _))
                {
                    var path = Path.Combine(Queue, id + ".json");
                    if (File.Exists(path)) { File.Delete(path); --_pending; }
                }
    }

    public void MoveToReview(string id, string reason)
    {
        if (!Guid.TryParseExact(id, "D", out _)) return;
        lock (_gate)
        {
            var path = Path.Combine(Queue, id + ".json");
            if (!File.Exists(path)) return;
            Directory.CreateDirectory(Review);
            Write(Path.Combine(Review, id + ".reason.txt"), reason);
            File.Move(path, Path.Combine(Review, id + ".json"), true);
            --_pending; _review = Directory.GetFiles(Review, "*.json").Length;
        }
    }

    internal static void Write(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(value);
                file.Write(bytes); file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace ICeClass.Diagnostics;

internal sealed class ClientErrorReporter : IDisposable
{
    private readonly Func<string, string, CancellationToken, Task> _send;
    private readonly object _sync = new();
    private readonly List<Entry> _pending = [];
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly string? _queuePath;
    private readonly string _identity;
    private bool _disposed;
    private Batch? _batch;

    internal ClientErrorReporter(Func<string, string, CancellationToken, Task> send, string? queuePath = null, string identity = "")
    {
        _send = send;
        _queuePath = queuePath;
        _identity = identity;
        Restore();
        var token = _lifetime.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
                while (await timer.WaitForNextTickAsync(token)) await FlushAsync(token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        });
    }

    internal void Record(string message)
    {
        var safe = SupportDiagnostics.Redact(message);
        if (safe.Length > 512) safe = safe[..(char.IsHighSurrogate(safe[511]) ? 511 : 512)];
        lock (_sync)
        {
            if (_disposed) return;
            if (_pending.LastOrDefault() is { } last && last.Message == safe)
                _pending[^1] = last with { Count = last.Count == int.MaxValue ? last.Count : last.Count + 1 };
            else
            {
                if (_pending.Count >= 24) _pending.RemoveAt(0);
                _pending.Add(new(Guid.NewGuid(), DateTimeOffset.Now, safe, 1));
            }
            Persist();
        }
    }

    internal async Task FlushAsync(CancellationToken token)
    {
        await _sending.WaitAsync(token);
        try
        {
            lock (_sync)
            {
                if (_disposed || _pending.Count == 0 && _batch is null) return;
                if (_batch is null)
                {
                    var entries = _pending.ToArray();
                    var text = new StringBuilder("自动错误汇总\n");
                    text.AppendLine($"系统：{RuntimeInformation.OSDescription} / {RuntimeInformation.ProcessArchitecture}；.NET {Environment.Version}");
                    foreach (var entry in entries) text.AppendLine($"[{entry.At:O}] {entry.Message}（重复 {entry.Count} 次）");
                    _batch = new(Guid.NewGuid().ToString(), text.ToString(), entries);
                    Persist();
                }
            }
            var batch = _batch;
            try { await _send(batch.Id, batch.Report, token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch { return; } // Keep local evidence; reporting failures must never report themselves.
            lock (_sync)
            {
                if (_disposed) return;
                foreach (var sent in batch.Entries)
                {
                    var index = _pending.FindIndex(entry => entry.Id == sent.Id);
                    if (index < 0) continue;
                    var current = _pending[index];
                    if (current.Count <= sent.Count) _pending.RemoveAt(index);
                    else _pending[index] = current with { Count = current.Count - sent.Count };
                }
                _batch = null;
                Persist();
            }
        }
        finally { _sending.Release(); }
    }

    public void Dispose()
    {
        lock (_sync) { if (_disposed) return; _disposed = true; }
        _lifetime.Cancel(); _lifetime.Dispose();
    }

    private void Restore()
    {
        if (_queuePath is null) return;
        try
        {
            if (!File.Exists(_queuePath) || new FileInfo(_queuePath).Length > 256 * 1024) return;
            var saved = JsonSerializer.Deserialize<Outbox>(File.ReadAllText(_queuePath));
            if (saved is null || saved.Identity != _identity || !Valid(saved.Pending)) return;
            if (saved.Batch is { } batch && (!Guid.TryParse(batch.Id, out _) || !Valid(batch.Entries) ||
                batch.Report is null || Encoding.UTF8.GetByteCount(batch.Report) > 65536)) return;
            _pending.AddRange(saved.Pending);
            _batch = saved.Batch;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
    }

    private static bool Valid(Entry[]? entries) => entries is { Length: <= 24 } &&
        entries.All(entry => entry is not null && entry.Id != Guid.Empty && entry.Count > 0 && entry.Message is { Length: <= 512 });

    private void Persist()
    {
        if (_queuePath is null) return;
        var temporary = _queuePath + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_queuePath)!);
            File.WriteAllText(temporary, JsonSerializer.Serialize(new Outbox(_identity, _pending.ToArray(), _batch)));
            File.Move(temporary, _queuePath, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        // Errors are already retained in the normal local log. Never report an outbox write failure recursively.
    }

    private sealed record Outbox(string Identity, Entry[] Pending, Batch? Batch);
    private sealed record Batch(string Id, string Report, Entry[] Entries);
    private sealed record Entry(Guid Id, DateTimeOffset At, string Message, int Count);
}

internal static class ClientDiagnostics
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    internal static string Identity(params string[] fields) => Convert.ToHexString(
        System.Security.Cryptography.SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(fields)));

    internal static string InstallationId(string directory)
    {
        var path = Path.Combine(directory, "diagnostic-device-id.txt");
        if (File.Exists(path) && Guid.TryParse(File.ReadAllText(path).Trim(), out var existing)) return existing.ToString();
        Directory.CreateDirectory(directory);
        var identifier = Guid.NewGuid().ToString(); File.WriteAllText(path, identifier); return identifier;
    }

    internal static async Task<string> UploadAsync(HttpClient http, HttpRequestMessage request, string edition,
        string kind, string version, string installationId, string report, CancellationToken token, string? reportId = null)
    {
        report = SupportDiagnostics.Redact(report);
        if (Encoding.UTF8.GetByteCount(report) > (kind == "error" ? 65536 : SupportDiagnostics.MaximumReportBytes))
            throw new InvalidDataException("诊断日志超过大小限制，请刷新后重试。");
        reportId ??= new Guid(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(edition + kind + version + installationId + report)).AsSpan(0, 16)).ToString();
        request.Content = JsonContent.Create(new { id = reportId, edition, kind, version, installationId,
            deviceName = Environment.MachineName, summary = kind == "manual" ? "手动提交的近期诊断" : "自动错误汇总", report }, options: Json);
        using var response = await http.SendAsync(request, token);
        if ((int)response.StatusCode is 404 or 405) throw new InvalidOperationException("学校平台尚未启用诊断上报，请先导出诊断包。");
        if ((int)response.StatusCode is 401 or 403) throw new InvalidOperationException("登录或教室绑定已失效，请重新登录或绑定后重试。");
        if ((int)response.StatusCode == 429) throw new InvalidOperationException("提交较频繁，请稍后重试。");
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<UploadResponse>(cancellationToken: token);
        if (result is not { Status: "stored" } || !Guid.TryParse(result.Id, out _))
            throw new InvalidDataException("未收到服务器保存确认，请稍后重试或导出诊断包。");
        return result.Id;
    }
    private sealed record UploadResponse(string Id, string Status);
}

using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>Credentials stay native. The independent outbox keeps syncing when the classroom window is closed.</summary>
internal sealed class CardQuizService : IDisposable
{
    private static readonly object Registry = new();
    private static CardQuizService? _current;
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(25) };
    private static readonly TimeSpan HandoffTimeout = TimeSpan.FromSeconds(10);
    private readonly ReceiverConfig _config;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _outbox = new(1, 1);
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _journalSync = new();
    private readonly object _receiptProgress = new();
    private readonly SemaphoreSlim _bootstrap = new(1, 1);
    private readonly object _authorization = new();
    private long _authorizationVersion;
    private volatile bool _revoked;
    private DateTimeOffset _nextBootstrap;
    private string? _lastError;
    internal CardQuizStore Store { get; }
    internal string ClassName => _config.ClassName;
    internal string DeviceId => _config.DeviceId;
    internal string ClassId => _config.ClassId;
    internal string Endpoint => _config.Endpoint;
    internal bool IsRevoked => _revoked;
    internal event Action<string>? AuthorizationRevoked;
    private CardQuizService(ReceiverConfig config)
    {
        _config = new ReceiverConfig { Endpoint = ReceiverConfig.NormalizeEndpoint(config.Endpoint), DeviceId = config.DeviceId,
            DeviceToken = config.DeviceToken, ClassId = config.ClassId, ClassName = config.ClassName };
        var key = BindingKey(_config);
        var root = ReceiverConfig.IsPreview(config) ? Path.Combine(AppContext.BaseDirectory, "CardQuizData", key) :
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "CardQuiz", key);
        Store = new CardQuizStore(root, _config.ClassId, _config.DeviceId);
        _revoked = Store.LoadCache("context")?["revoked"]?.GetValue<bool>() == true;
        _ = Task.Run(() => RunAsync(_lifetime.Token));
    }
    internal static string BindingKey(ReceiverConfig config) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(ReceiverConfig.NormalizeEndpoint(config.Endpoint) + "\n" + config.DeviceId + "\n" + config.ClassId)))[..24];

    internal bool Matches(ReceiverConfig config) => _config.Endpoint == ReceiverConfig.NormalizeEndpoint(config.Endpoint) &&
        _config.DeviceId == config.DeviceId && _config.ClassId == config.ClassId && _config.DeviceToken == config.DeviceToken;
    internal static CardQuizService For(ReceiverConfig config)
    {
        lock (Registry)
        {
            if (_current is not null && _current.Matches(config)) return _current;
            _current?.Dispose(); return _current = new(config);
        }
    }
    internal static void Stop() { lock (Registry) { _current?.Dispose(); _current = null; } }
    public void Dispose() => _lifetime.Cancel();
    private HttpRequestMessage Request(string path, JsonObject? body = null)
    {
        var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, _config.Endpoint.TrimEnd('/') + "/api/card-quiz/" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.DeviceToken);
        request.Headers.Add("X-ICeClass-Device-Id", _config.DeviceId); request.Headers.Add("X-ICeClass-Class-Id", _config.ClassId);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return request;
    }
    private sealed class ApiFailure(string message, HttpStatusCode status) : Exception(message) { internal HttpStatusCode Status => status; }
    private async Task<JsonObject> SendAsync(string path, JsonObject? body, CancellationToken token)
    {
        using var request = Request(path, body); using var response = await Http.SendAsync(request, token);
        var text = await response.Content.ReadAsStringAsync(token);
        JsonObject? value = null;
        try { value = JsonNode.Parse(text)?.AsObject(); } catch (JsonException) { }
        if (!response.IsSuccessStatusCode)
        {
            var message = value?["error"]?.GetValue<string>() ?? "学校服务暂时不可用，请稍后重试。";
            if (response.StatusCode == HttpStatusCode.Unauthorized || path == "device/bootstrap" && response.StatusCode == HttpStatusCode.Forbidden) Revoke(message);
            else if (response.StatusCode == HttpStatusCode.Forbidden)
            {
                // A paired teacher or one resource can lose access while this device remains valid.
                try { await RefreshContextAsync(token); }
                catch (Exception error) when (error is not OutOfMemoryException && !token.IsCancellationRequested) { }
            }
            throw new ApiFailure(message, response.StatusCode);
        }
        return value ?? throw new InvalidDataException("学校服务返回了无法读取的数据。");
    }
    private void Revoke(string message)
    {
        try
        {
            lock (_authorization)
            {
                _revoked = true; _authorizationVersion++; _lastError = message;
                var context = Store.LoadCache("context") ?? new JsonObject { ["classId"] = _config.ClassId };
                context["revoked"] = true; Store.SaveCache("context", context);
                foreach (var journal in Store.LoadStatus()["journals"]!.AsArray().OfType<JsonObject>())
                    if (journal["syncedSeq"]!.GetValue<int>() < journal["session"]!["seq"]!.GetValue<int>()) Store.MarkReview(journal["session"]!["id"]!.GetValue<string>(), message);
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        { _lastError = message + " 撤权状态未能保存，请保留本机记录并核对：" + error.Message; }
        finally { AuthorizationRevoked?.Invoke(_lastError ?? message); }
    }
    private void RequirePublication(string id)
    {
        var context = Store.LoadCache("context");
        if (_revoked || context?["revoked"]?.GetValue<bool>() == true) throw new InvalidOperationException("设备绑定已失效，请重新绑定后使用。");
        if (context?["publications"] is not JsonArray published || !published.Any(p => p?["id"]?.GetValue<string>() == id))
            throw new InvalidOperationException("该题单未发布到本班或已被撤回。");
    }
    internal JsonObject Commit(JsonObject journal)
    {
        lock (_authorization)
        {
            var session = journal["session"]!.AsObject(); var previous = Store.Read(session["id"]!.GetValue<string>());
            if (previous is null)
            {
                if (_revoked || Store.LoadCache("context") is not JsonObject context || context["revoked"]?.GetValue<bool>() == true)
                    throw new InvalidOperationException("本班授权尚未就绪或已失效，请联网刷新名单。");
                if (journal["publicationId"]?.GetValue<string>() is string publicationId) RequirePublication(publicationId);
            }
            else
            {
                if (!JsonNode.DeepEquals(previous["publicationId"], journal["publicationId"])) throw new InvalidDataException("课堂的原题单不能替换。");
                if (_revoked && session["seq"]!.GetValue<int>() != previous["session"]!["seq"]!.GetValue<int>())
                    ValidateRevokedClose(previous["session"]!.AsObject(), session, journal["events"]!.AsArray().Last()!.AsObject());
            }
            return Store.Commit(journal);
        }
    }
    private static void ValidateRevokedClose(JsonObject previous, JsonObject incoming, JsonObject entry)
    {
        var action = entry["action"]?.GetValue<string>();
        if (action is not ("recover" or "end_round" or "end_session")) throw new InvalidOperationException("设备授权已撤销，已停止采集；本机记录保留待核对。");
        var expected = previous.DeepClone().AsObject(); expected["seq"] = previous["seq"]!.GetValue<int>() + 1;
        expected["generation"] = previous["generation"]!.GetValue<int>() + 1;
        var question = expected["questions"]!.AsArray().FirstOrDefault(q => JsonNode.DeepEquals(q?["id"], expected["currentQuestionId"]));
        var round = question?["rounds"]?.AsArray().FirstOrDefault(r => JsonNode.DeepEquals(r?["id"], expected["currentRoundId"]));
        if (round is not null && round["status"]?.GetValue<string>() != "closed")
        {
            round["status"] = action == "recover" ? "paused" : "closed";
            if (action == "recover") round["generation"] = expected["generation"]!.DeepClone(); else round["endedAt"] = entry["at"]!.DeepClone();
        }
        if (action == "end_session") expected["endedAt"] = entry["at"]!.DeepClone();
        if (!JsonNode.DeepEquals(expected, incoming)) throw new InvalidOperationException("授权失效后仅可暂停或封存原记录，不能继续采集或修改题目。");
    }
    internal JsonObject Load(string? sessionId = null) => WithContext(Store.Load(sessionId));
    internal JsonObject Status(string? sessionId = null) => WithContext(Store.LoadStatus(sessionId));
    private JsonObject WithContext(JsonObject data)
    {
        var context = Store.LoadCache("context");
        if (_revoked) { context ??= new JsonObject { ["classId"] = _config.ClassId }; context["revoked"] = true; }
        if (context is not null)
        {
            context["deviceId"] = _config.DeviceId;
            if (context["publications"] is JsonArray publications)
                foreach (var publication in publications.OfType<JsonObject>())
                    publication["cached"] = Guid.TryParseExact(publication["id"]?.GetValue<string>(), "D", out _) && Store.LoadCache("publication-" + publication["id"]!.GetValue<string>()) is not null;
        }
        data["context"] = context; data["classId"] = _config.ClassId; data["deviceId"] = _config.DeviceId;
        data["className"] = _config.ClassName; data["endpoint"] = _config.Endpoint; data["error"] = _lastError;
        return data;
    }
    internal async Task<JsonObject> BootstrapAsync(CancellationToken token)
    {
        await RefreshContextAsync(token);
        return Load();
    }
    private async Task RefreshContextAsync(CancellationToken token)
    {
        await _bootstrap.WaitAsync(token);
        try { await BootstrapCoreAsync(token); }
        finally { _bootstrap.Release(); }
    }
    private async Task BootstrapCoreAsync(CancellationToken token)
    {
        long authorizationVersion; lock (_authorization) authorizationVersion = _authorizationVersion;
        try
        {
            var context = await SendAsync("device/bootstrap", null, token);
            if (context["classId"]?.GetValue<string>() != _config.ClassId) throw new InvalidDataException("学校返回了不属于本设备的班级。");
            context["deviceId"] = _config.DeviceId; context["revoked"] = false;
            lock (_authorization)
            {
                if (authorizationVersion == _authorizationVersion) { Store.SaveCache("context", context); _revoked = false; _lastError = null; }
            }
        }
        catch (ApiFailure error) when (error.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException(error.Message);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            _lastError = "暂时无法连接学校服务；已缓存的名单和题单可离线使用。";
            if (Store.LoadCache("context") is null) throw new InvalidOperationException(_lastError);
        }
    }
    internal async Task<JsonObject> PublicationAsync(string id, CancellationToken token, string? sessionId = null)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("题单编号无效。");
        var cached = Store.LoadCache("publication-" + id);
        // A withdrawal affects future starts. An already-created local classroom keeps its snapshot.
        if (cached is not null && sessionId is not null && Store.Read(sessionId)?["publicationId"]?.GetValue<string>() == id) return cached;
        lock (_authorization) RequirePublication(id);
        if (cached is not null) return cached;
        var publication = await SendAsync("device/publications/" + id, null, token);
        var images = new JsonObject(); var bytes = 0;
        foreach (var question in publication["questions"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            var imageId = question["imageId"]?.GetValue<string>(); if (string.IsNullOrEmpty(imageId) || images.ContainsKey(imageId)) continue;
            if (!Guid.TryParseExact(imageId, "D", out _)) throw new InvalidDataException("题目图片标识无效。");
            using var request = Request("images/" + imageId); using var response = await Http.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                if (response.StatusCode == HttpStatusCode.Unauthorized) Revoke("设备授权已失效，已停止采集。");
                else if (response.StatusCode == HttpStatusCode.Forbidden)
                {
                    try { await RefreshContextAsync(token); }
                    catch (Exception error) when (error is not OutOfMemoryException && !token.IsCancellationRequested) { }
                }
                throw new InvalidOperationException("题目图片下载失败，尚不能离线使用，请联网重试。");
            }
            var mime = response.Content.Headers.ContentType?.MediaType;
            if (mime is not ("image/png" or "image/jpeg" or "image/webp")) throw new InvalidDataException("题目图片类型无效。");
            var content = await response.Content.ReadAsByteArrayAsync(token); bytes += content.Length;
            if (content.Length > 2 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new InvalidDataException("题单图片缓存过大，请在教师工作台拆分题单。");
            images[imageId] = "data:" + mime + ";base64," + Convert.ToBase64String(content);
        }
        cached = new JsonObject { ["publication"] = publication, ["images"] = images };
        lock (_authorization) { RequirePublication(id); Store.SaveCache("publication-" + id, cached); }
        return cached;
    }
    private string ReceiptClassName(string id)
    {
        lock (_receiptProgress)
        {
            var progress = Store.LoadCache("receipt-" + id) ?? new JsonObject { ["seq"] = 0 };
            if (progress["className"] is null)
            {
                progress["className"] = _config.ClassName;
                Store.SaveCache("receipt-" + id, progress);
            }
            return progress["className"]!.GetValue<string>();
        }
    }
    private void SaveReceiptProgress(string id, int through)
    {
        lock (_receiptProgress)
        {
            var progress = Store.LoadCache("receipt-" + id) ?? new JsonObject();
            progress["seq"] = through;
            Store.SaveCache("receipt-" + id, progress);
        }
    }
    internal async Task<JsonObject> SyncAsync(bool retry, CancellationToken token)
    {
        await SyncPendingAsync(retry, token);
        return Status();
    }
    internal async Task SyncPendingAsync(bool retry, CancellationToken token)
    {
        await _outbox.WaitAsync(token);
        try
        {
            foreach (var id in Store.PendingSessionIds(retry))
            {
                try { await SyncJournalAsync(id, retry, token); }
                catch (ApiFailure error) when (NeedsReview(error)) { /* Keep syncing other lessons. */ }
            }
        }
        finally { _outbox.Release(); }
    }
    private static bool NeedsReview(ApiFailure error) =>
        (int)error.Status is >= 400 and < 500 && error.Status is not (HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests);

    private async Task<int> SyncJournalAsync(string id, bool retry, CancellationToken token)
    {
        if (!Guid.TryParseExact(id, "D", out var key)) throw new InvalidDataException("课堂编号无效。");
        var gate = _journalSync.GetOrAdd(key, static _ => new(1, 1));
        await gate.WaitAsync(token);
        try
        {
            var item = Store.ReadJournal(id);
            var session = item["session"]!.AsObject();
            var seq = session["seq"]!.GetValue<int>(); var synced = item["syncedSeq"]?.GetValue<int>() ?? 0;
            if (!retry && !string.IsNullOrEmpty(item["reviewError"]?.GetValue<string>())) return synced;
            var delivered = Store.LoadCache("receipt-" + id)?["seq"]?.GetValue<int>() ?? 0;
            if (delivered < 0 || delivered > seq) throw new InvalidDataException("本机回执进度异常，原记录已保留待核对。");
            var candidates = new List<JsonObject>(); var through = delivered;
            foreach (var entry in item["events"]!.AsArray().OfType<JsonObject>().Where(e => e["seq"]!.GetValue<int>() > delivered))
            {
                if (candidates.Count == 128) break;
                through = entry["seq"]!.GetValue<int>();
                if (entry["sourceId"]?.GetValue<string>() == "board") continue;
                candidates.Add(entry);
            }
            var receipts = new JsonArray();
            if (candidates.Count > 0)
            {
                // Only actual phone submissions need an original receipt, including in old journals.
                var lookup = await SendAsync("device/receipt-ids", new JsonObject { ["sessionId"] = id,
                    ["ids"] = new JsonArray(candidates.Select(e => e["id"]!.DeepClone()).ToArray()) }, token);
                if (lookup["commandIds"] is not JsonArray commandIds) throw new InvalidDataException("手机请求来源尚未核实，原记录将继续保留。");
                var registeredIds = commandIds.Select(n => n!.GetValue<string>()).ToArray();
                if (registeredIds.Distinct().Count() != registeredIds.Length || registeredIds.Any(value => !candidates.Any(e => e["id"]!.GetValue<string>() == value)))
                    throw new InvalidDataException("手机请求来源回执不匹配，原记录将继续保留。");
                var receiptClassName = registeredIds.Length > 0 ? ReceiptClassName(id) : null;
                foreach (var requestId in registeredIds)
                {
                    var original = item["receipts"]![requestId]!.AsObject();
                    var result = original["result"]!.DeepClone().AsObject(); result["state"]!["className"] = receiptClassName;
                    var receipt = new JsonObject { ["id"] = requestId, ["fingerprint"] = original["fingerprint"]!.DeepClone(), ["result"] = result };
                    if (Encoding.UTF8.GetByteCount(receipt.ToJsonString()) > 16 * 1024) throw new InvalidDataException("手机原回执超过传输上限，已保留原记录，请核对后重试。");
                    receipts.Add(receipt);
                }
            }
            if (synced != seq || receipts.Count > 0)
            {
                var events = new JsonArray(item["events"]!.AsArray().Where(e => e!["seq"]!.GetValue<int>() > synced).Select(e => e!.DeepClone()).ToArray());
                var response = await SendAsync("device/sync", new JsonObject {
                    ["session"] = session.DeepClone(), ["publicationId"] = item["publicationId"]?.DeepClone(),
                    ["events"] = events, ["fromSeq"] = synced + 1, ["receipts"] = receipts
                }, token);
                if (response["syncedSeq"]?.GetValue<int>() != seq) throw new InvalidDataException("同步回执不完整，记录已保留待核对。");
                if (receipts.Count > 0 && (response["receiptIds"] is not JsonArray ids ||
                    !ids.Select(n => n!.GetValue<string>()).Order().SequenceEqual(receipts.Select(n => n!["id"]!.GetValue<string>()).Order())))
                    throw new InvalidDataException("手机回执尚未完整确认，原结果将继续补传。");
                Store.MarkSynced(id, seq); _lastError = null;
            }
            if (through > delivered) SaveReceiptProgress(id, through);
            return seq;
        }
        catch (ApiFailure error) when (NeedsReview(error))
        {
            Store.MarkReview(id, error.Message); _lastError = error.Message;
            throw;
        }
        finally { gate.Release(); }
    }
    internal async Task<JsonObject> SyncSessionAsync(string id, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(HandoffTimeout);
        try { return new JsonObject { ["syncedSeq"] = await SyncJournalAsync(id, true, deadline.Token) }; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { throw new TimeoutException("本堂课同步超时。"); }
        catch (HttpRequestException)
        { throw new InvalidOperationException("暂时无法连接学校服务。"); }
    }
    internal async Task<JsonObject> RelayAsync(JsonObject body, CancellationToken token)
    {
        var outbound = body.DeepClone().AsObject();
        if (outbound["receipts"] is JsonArray receipts && receipts.OfType<JsonObject>().Any(r => r["result"] is JsonObject))
        {
            var id = outbound["sessionId"]?.GetValue<string>();
            if (!Guid.TryParseExact(id, "D", out _)) throw new InvalidDataException("成功回执的课堂编号无效。");
            var className = ReceiptClassName(id);
            foreach (var receipt in receipts.OfType<JsonObject>().Where(r => r["result"] is JsonObject))
            {
                if (receipt["result"]!["state"] is not JsonObject state || state["sessionId"]?.GetValue<string>() != id)
                    throw new InvalidDataException("成功回执的课堂状态不匹配。");
                state["className"] = className;
            }
        }
        return await SendAsync("device/relay", outbound, token);
    }
    internal async Task<JsonObject> PairAsync(string sessionId, CancellationToken token)
    {
        var journal = Store.Read(sessionId) ?? throw new InvalidDataException("请先在本机建立课堂。");
        var session = journal["session"]!;
        if (session["endedAt"] is not null) throw new InvalidOperationException("课堂已经结束。");
        var synced = journal["syncedSeq"]!.GetValue<int>();
        var body = new JsonObject { ["sessionId"] = sessionId, ["quickScan"] = true };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(HandoffTimeout);
        try
        {
            // A just-saved return to the board must reach the school before issuing a new phone code.
            if (session["source"]?.GetValue<string>() == "board" && journal["events"]!.AsArray().OfType<JsonObject>()
                .Any(e => e["seq"]!.GetValue<int>() > synced && e["action"]!.GetValue<string>() == "set_source"))
                await SyncJournalAsync(sessionId, true, deadline.Token);
            JsonObject pair;
            try { pair = await SendAsync("device/pair", body, deadline.Token); }
            catch (ApiFailure error) when (error.Status == HttpStatusCode.NotFound && synced == 0 && session["seq"]!.GetValue<int>() > 0)
            {
                await SyncJournalAsync(sessionId, true, deadline.Token);
                pair = await SendAsync("device/pair", body, deadline.Token);
            }
            // The binding has the public origin, including HTTPS behind the school's reverse proxy.
            var link = new Uri(pair["url"]!.GetValue<string>(), UriKind.Absolute);
            pair["url"] = _config.Endpoint + link.PathAndQuery + link.Fragment;
            return pair;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { throw new TimeoutException("获取二维码超时。"); }
        catch (HttpRequestException)
        { throw new InvalidOperationException("暂时无法连接学校服务。"); }
    }
    internal Task<JsonObject> CancelPairAsync(string sessionId, string pairId, CancellationToken token) =>
        SendAsync("device/pair/cancel", new JsonObject { ["sessionId"] = sessionId, ["pairId"] = pairId }, token);
    private async Task RunAsync(CancellationToken token)
    {
        var failures = 0;
        while (!token.IsCancellationRequested)
        {
            try
            {
                if (DateTimeOffset.UtcNow >= _nextBootstrap)
                { _nextBootstrap = DateTimeOffset.UtcNow.AddMinutes(1); await RefreshContextAsync(token); }
                await SyncPendingAsync(false, token); failures = 0;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error) when (error is not OutOfMemoryException)
            { _lastError = error is ApiFailure or InvalidOperationException ? error.Message : "暂未完成同步，本机记录已保留。"; failures = Math.Min(failures + 1, 4); }
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Min(60, 5 * (1 << failures))), token); }
            catch (OperationCanceledException) { break; }
        }
    }
}

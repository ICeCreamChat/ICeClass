using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

if (args is ["--encode-json"]) {
    Console.Write(JsonNode.Parse(await Console.In.ReadToEndAsync())!.ToJsonString());
    return;
}

using var port = new TcpListener(IPAddress.Loopback, 0); port.Start();
var endpoint = "http://127.0.0.1:" + ((IPEndPoint)port.LocalEndpoint).Port; port.Stop();
using var listener = new HttpListener(); listener.Prefixes.Add(endpoint + "/"); listener.Start();
using var lifetime = new CancellationTokenSource();
var bootstrap = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var received = new List<JsonObject>(); var loseReply = false; var failures = new List<string>(); var count = 0;
var bootstrapStatus = 503; var publications = new JsonArray(); var bootstrapCalls = 0; var activeBootstrap = 0; var maximumBootstrap = 0;
TaskCompletionSource? holdBootstrap = null, bootstrapStarted = null; var relayStatus = 200;
var localCommandIds = new HashSet<string>();
var relayed = new List<JsonObject>();
JsonObject? invitationRequest = null, cancellationRequest = null;
const string scanPath = "/card-quiz/phone.html#scan=synthetic-test-invitation";
var handlers = new List<Task>();
async Task Handle(HttpListenerContext request) {
    try {
        JsonObject response;
        if (request.Request.Url!.AbsolutePath.EndsWith("/bootstrap")) {
            var active = Interlocked.Increment(ref activeBootstrap); maximumBootstrap = Math.Max(maximumBootstrap, active); Interlocked.Increment(ref bootstrapCalls);
            try {
                var status = bootstrapStatus; var currentPublications = publications.DeepClone(); var hold = holdBootstrap; holdBootstrap = null;
                if (hold is not null) { bootstrapStarted?.TrySetResult(); await hold.Task.WaitAsync(lifetime.Token); }
                request.Response.StatusCode = status;
                response = status == 200 ? new() { ["classId"] = "c1", ["className"] = "隔离服务检查班", ["students"] = new JsonArray(), ["publications"] = currentPublications } : new() { ["error"] = "isolated device authorization unavailable" };
                bootstrap.TrySetResult();
            } finally { Interlocked.Decrement(ref activeBootstrap); }
        } else if (request.Request.Url.AbsolutePath.EndsWith("/relay") && relayStatus != 200) {
            request.Response.StatusCode = relayStatus; response = new() { ["error"] = "isolated authorization unavailable" };
        } else if (request.Request.Url.AbsolutePath.EndsWith("/relay")) {
            using var reader = new StreamReader(request.Request.InputStream);
            relayed.Add(JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject());
            response = new() { ["commands"] = new JsonArray(), ["pairings"] = new JsonArray() };
        } else if (request.Request.Url.AbsolutePath.EndsWith("/device/pair")) {
            using var reader = new StreamReader(request.Request.InputStream);
            invitationRequest = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
            response = new() { ["mode"] = "scan", ["pairId"] = "test-pair", ["url"] = "http://upstream.example" + scanPath };
        } else if (request.Request.Url.AbsolutePath.EndsWith("/device/pair/cancel")) {
            using var reader = new StreamReader(request.Request.InputStream);
            cancellationRequest = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
            response = new() { ["ok"] = true };
        } else if (request.Request.Url.AbsolutePath.EndsWith("/receipt-ids")) {
            using var reader = new StreamReader(request.Request.InputStream);
            var body = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
            response = new() { ["commandIds"] = new JsonArray(body["ids"]!.AsArray().Where(n => !localCommandIds.Contains(n!.GetValue<string>())).Select(n => n!.DeepClone()).ToArray()) };
        } else {
            using var reader = new StreamReader(request.Request.InputStream);
            var body = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
            received.Add(body.DeepClone().AsObject());
            if (request.Request.Headers["Authorization"] != "Bearer isolated-device-token" || request.Request.Headers["X-ICeClass-Class-Id"] != "c1") failures.Add("native authentication headers missing");
            response = new() { ["syncedSeq"] = body["session"]!["seq"]!.DeepClone(), ["receiptIds"] = new JsonArray(body["receipts"]!.AsArray().Select(r => r!["id"]!.DeepClone()).ToArray()) };
        }
        var bytes = Encoding.UTF8.GetBytes(response.ToJsonString()); request.Response.ContentType = "application/json";
        request.Response.ContentLength64 = bytes.Length + (loseReply && request.Request.Url.AbsolutePath.EndsWith("/sync") ? 128 : 0);
        await request.Response.OutputStream.WriteAsync(bytes);
        if (loseReply && request.Request.Url.AbsolutePath.EndsWith("/sync")) request.Response.Abort(); else request.Response.Close();
    } catch (Exception error) when (error is HttpListenerException or IOException or ObjectDisposedException or OperationCanceledException) { }
}
var serving = Task.Run(async () => {
    try {
        while (!lifetime.IsCancellationRequested) {
            var request = await listener.GetContextAsync().WaitAsync(lifetime.Token);
            handlers.Add(Handle(request));
        }
    } catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
});
void Check(bool success, string name) { if (!success) throw new Exception(name); count++; Console.WriteLine("PASS " + name); }
void Refuses(Action action, string name) { try { action(); } catch (InvalidOperationException) { Check(true, name); return; } throw new Exception("未拒绝：" + name); }
JsonObject Initial(string id) => new() {
    ["session"] = new JsonObject { ["schema"] = 1, ["id"] = id, ["classId"] = "c1", ["deviceId"] = "d1", ["subjectId"] = "math", ["seq"] = 0, ["generation"] = 1, ["source"] = "board", ["sourceId"] = "board", ["endedAt"] = null, ["questions"] = new JsonArray(), ["currentQuestionId"] = null, ["currentRoundId"] = null },
    ["events"] = new JsonArray(), ["receipts"] = new JsonObject(), ["syncedSeq"] = 0, ["reviewError"] = null
};
JsonObject Advance(JsonObject input, string action, string? source = null, JsonObject? content = null) {
    var j = input.DeepClone().AsObject(); var s = j["session"]!.AsObject(); var seq = s["seq"]!.GetValue<int>() + 1; var id = Guid.NewGuid().ToString();
    var payload = content?.DeepClone().AsObject() ?? (source is null ? new JsonObject() : new JsonObject { ["source"] = "phone", ["sourceId"] = source });
    var command = new JsonObject { ["id"] = id, ["sessionId"] = s["id"]!.DeepClone(), ["action"] = action, ["payload"] = payload.DeepClone(), ["generation"] = s["generation"]!.DeepClone(), ["sourceId"] = s["sourceId"]!.DeepClone(), ["questionId"] = s["currentQuestionId"]?.DeepClone(), ["roundId"] = s["currentRoundId"]?.DeepClone() };
    j["events"]!.AsArray().Add(new JsonObject { ["id"] = id, ["seq"] = seq, ["action"] = action, ["at"] = 1000 + seq, ["payload"] = payload.DeepClone(), ["generation"] = command["generation"]!.DeepClone(), ["sourceId"] = command["sourceId"]!.DeepClone(), ["questionId"] = command["questionId"]?.DeepClone(), ["roundId"] = command["roundId"]?.DeepClone() });
    s["seq"] = seq; if (action is "add_question" or "start_round" or "end_round" or "resume_round" or "recover" or "set_source" or "set_multi_option" or "end_session") s["generation"] = s["generation"]!.GetValue<int>() + 1;
    if (source is not null) { s["source"] = "phone"; s["sourceId"] = source; }
    j["receipts"]![id] = new JsonObject { ["fingerprint"] = command.ToJsonString(), ["result"] = new JsonObject { ["seq"] = seq, ["status"] = "confirmed", ["state"] = new JsonObject { ["sessionId"] = s["id"]!.DeepClone(), ["seq"] = seq, ["className"] = "", ["generation"] = s["generation"]!.DeepClone() } } }; return j;
}
JsonObject RelayBody(JsonObject journal, string className) {
    var requestId = journal["events"]!.AsArray().Last()!["id"]!.GetValue<string>();
    var result = journal["receipts"]![requestId]!["result"]!.DeepClone(); result!["state"]!["className"] = className;
    return new JsonObject { ["sessionId"] = journal["session"]!["id"]!.DeepClone(), ["state"] = result["state"]!.DeepClone(),
        ["receipts"] = new JsonArray(new JsonObject { ["id"] = requestId, ["result"] = result }) };
}
try {
    var config = new ReceiverConfig { Endpoint = endpoint, ClassId = "c1", ClassName = "隔离服务检查班", DeviceId = "d1", DeviceToken = "isolated-device-token" };
    var service = CardQuizService.For(config); await bootstrap.Task.WaitAsync(TimeSpan.FromSeconds(5));
    Check(service.Matches(config) && ReferenceEquals(service, CardQuizService.For(config)), "运行时绑定复用不使用磁盘DPAPI保护副本");
    var sid = Guid.NewGuid().ToString(); var j = Initial(sid); service.Store.Commit(j);
    var invitation = await service.PairAsync(sid, lifetime.Token);
    Check(invitationRequest?["quickScan"]?.GetValue<bool>() == true && invitationRequest["sessionId"]?.GetValue<string>() == sid &&
          invitation["url"]?.GetValue<string>() == endpoint + scanPath, "扫码链接沿用白板绑定地址并保留本堂邀请");
    await service.CancelPairAsync(sid, "test-pair", lifetime.Token);
    Check(cancellationRequest?["pairId"]?.GetValue<string>() == "test-pair" && cancellationRequest["sessionId"]?.GetValue<string>() == sid,
          "取消邀请只提交原课堂和配对编号");
    j = Advance(j, "set_source", Guid.NewGuid().ToString()); service.Store.Commit(j); j = Advance(j, "recover"); service.Store.Commit(j);
    service.Store.SaveCache("receipt-" + sid, new JsonObject { ["seq"] = 0 });
    var cacheRoot = (string)typeof(CardQuizStore).GetField("_root", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(service.Store)!;
    using (var locked = new FileStream(Path.Combine(cacheRoot, "cache", "receipt-" + sid + ".json"), FileMode.Open, FileAccess.Read, FileShare.Read)) {
        var beforeSend = received.Count;
        try { await service.SyncAsync(false, lifetime.Token); throw new Exception("receipt name write failure was accepted"); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        Check(received.Count == beforeSend && service.Store.Read(sid)!["syncedSeq"]!.GetValue<int>() == 0, "原回执班名无法持久化时不发送同步或推进进度");
    }
    loseReply = true;
    try { await service.SyncAsync(false, lifetime.Token); throw new Exception("truncated response was accepted"); } catch (HttpRequestException) { } catch (IOException) { }
    Check(service.Store.Read(sid)!["syncedSeq"]!.GetValue<int>() == 0, "丢失HTTP确认不推进同步进度");
    var original = received.Last()["receipts"]!.DeepClone(); var originalClassName = config.ClassName;
    Check(service.Store.LoadCache("receipt-" + sid)?["className"]?.GetValue<string>() == originalClassName, "首次发送前持久化回执班名，丢失响应仍可原样恢复");
    CardQuizService.Stop(); config.ClassName = "更名后的隔离检查班"; service = CardQuizService.For(config);
    loseReply = false; await service.SyncAsync(false, lifetime.Token);
    Check(JsonNode.DeepEquals(original, received.Last()["receipts"]), "后台重试发送同一持久化原回执");
    Check(service.Store.LoadCache("receipt-" + sid)!["className"]!.GetValue<string>() == originalClassName, "班级更名并重启后保留第一次回执班名");
    Check(service.Store.LoadCache("receipt-" + sid)!["seq"]!.GetValue<int>() == 2, "手机回执送达进度独立落盘");
    Check(received.Last()["receipts"]!.AsArray().Count == 1 && received.Last()["receipts"]![0]!["result"]!["state"]!["className"]!.GetValue<string>() == originalClassName, "只补传手机来源并提供原匿名班名");
    var calls = received.Count; await service.SyncAsync(false, lifetime.Token); Check(received.Count == calls, "已确认同步和回执不重复发送");
    var receiptProgress = service.Store.LoadCache("receipt-" + sid)!; receiptProgress["seq"] = 0;
    service.Store.SaveCache("receipt-" + sid, receiptProgress); await service.SyncAsync(false, lifetime.Token);
    Check(received.Last()["events"]!.AsArray().Count == 0 && received.Last()["fromSeq"]!.GetValue<int>() == 3 && received.Last()["receipts"]!.AsArray().Count == 1, "事件已同步时仍补传缺少确认的历史手机回执");
    for (var i = 0; i < 130; i++) { j = Advance(j, "recover"); service.Store.Commit(j); }
    await service.SyncAsync(false, lifetime.Token);
    Check(received.Last()["receipts"]!.AsArray().Count == 128 && service.Store.LoadCache("receipt-" + sid)!["seq"]!.GetValue<int>() == 130, "历史回执每批最多128条并保存有界进度");
    await service.SyncAsync(false, lifetime.Token);
    Check(received.Last()["events"]!.AsArray().Count == 0 && received.Last()["receipts"]!.AsArray().Count == 2 && service.Store.LoadCache("receipt-" + sid)!["seq"]!.GetValue<int>() == 132, "批量已同步后继续补齐剩余两条回执");
    Check(failures.Count == 0, "设备认证保留在原生请求头");
    var relaySid = Guid.NewGuid().ToString(); var relayJournal = Initial(relaySid); service.Store.Commit(relayJournal);
    relayJournal = Advance(relayJournal, "set_source", Guid.NewGuid().ToString()); service.Store.Commit(relayJournal);
    relayJournal = Advance(relayJournal, "recover"); service.Store.Commit(relayJournal);
    service.Store.SaveCache("receipt-" + relaySid, new JsonObject { ["seq"] = 0 });
    using (var locked = new FileStream(Path.Combine(cacheRoot, "cache", "receipt-" + relaySid + ".json"), FileMode.Open, FileAccess.Read, FileShare.Read)) {
        var beforeRelay = relayed.Count;
        try { await service.RelayAsync(RelayBody(relayJournal, config.ClassName), lifetime.Token); throw new Exception("relay sent before receipt name was durable"); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        Check(relayed.Count == beforeRelay && service.Store.Read(relaySid)!["syncedSeq"]!.GetValue<int>() == 0, "实时回执班名无法持久化时不发送成功或推进进度");
    }
    var relayInput = RelayBody(relayJournal, config.ClassName); var relayInputBefore = relayInput.DeepClone();
    await service.RelayAsync(relayInput, lifetime.Token); var firstRelay = relayed.Last()["receipts"]![0]!.DeepClone();
    Check(service.Store.LoadCache("receipt-" + relaySid)!["className"]!.GetValue<string>() == config.ClassName && JsonNode.DeepEquals(relayInput, relayInputBefore), "实时回执先保存统一班名并保留调用者原结果");
    CardQuizService.Stop(); config.ClassName = "再次更名后的检查班"; service = CardQuizService.For(config);
    await service.SyncAsync(false, lifetime.Token);
    Check(JsonNode.DeepEquals(firstRelay!["result"], received.Last()["receipts"]![0]!["result"]), "实时先确认且首次补传前重启更名仍发送同一原结果");
    relayJournal = Advance(relayJournal, "recover"); service.Store.Commit(relayJournal);
    await service.RelayAsync(RelayBody(relayJournal, config.ClassName), lifetime.Token); var laterRelay = relayed.Last()["receipts"]![0]!.DeepClone();
    await service.SyncAsync(false, lifetime.Token);
    Check(JsonNode.DeepEquals(laterRelay!["result"], received.Last()["receipts"]![0]!["result"]) && laterRelay["result"]!["state"]!["className"]!.GetValue<string>() != config.ClassName, "更名后的新命令实时回执与后台补传共用已保存班名");
    var revokedEvents = 0; service.AuthorizationRevoked += _ => revokedEvents++;
    bootstrapStatus = 401; try { await service.BootstrapAsync(lifetime.Token); } catch (InvalidOperationException) { }
    Check(service.IsRevoked && revokedEvents == 1, "明确撤权发出停采集通知并持久化撤权");
    Refuses(() => service.Commit(Advance(j, "answer")), "撤权后原生提交拒绝新的采集事件");
    Refuses(() => service.Commit(Initial(Guid.NewGuid().ToString())), "撤权后不能新建课堂");
    j = Advance(j, "recover"); service.Commit(j); Check(service.Store.Read(sid)!["session"]!["seq"]!.GetValue<int>() == 133, "撤权后仍可可靠暂停原课堂而不新增答案");
    bootstrapStatus = 503; try { await service.BootstrapAsync(lifetime.Token); } catch (Exception) { }
    Check(service.IsRevoked, "暂时连接失败不能清除已确认撤权");
    bootstrapStatus = 200; await service.BootstrapAsync(lifetime.Token); Check(!service.IsRevoked, "更新的真实成功鉴权可恢复授权");

    var priorReview = service.Store.Read(sid)!["reviewError"]?.DeepClone(); relayStatus = 403;
    try { await service.RelayAsync(new JsonObject(), lifetime.Token); } catch (Exception) { }
    Check(!service.IsRevoked && JsonNode.DeepEquals(priorReview, service.Store.Read(sid)!["reviewError"]), "手机或资源403经设备鉴权成功后不扩大为整机撤权");
    relayStatus = 200;

    var root = (string)typeof(CardQuizStore).GetField("_root", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(service.Store)!;
    using (var locked = new FileStream(Path.Combine(root, "cache", "context.json"), FileMode.Open, FileAccess.Read, FileShare.Read)) {
        bootstrapStatus = 401; var before = revokedEvents;
        try { await service.BootstrapAsync(lifetime.Token); } catch (InvalidOperationException) { }
        Check(service.IsRevoked && revokedEvents == before + 1 && service.Load()["error"]!.GetValue<string>().Contains("未能保存"), "撤权缓存写入失败仍通知停机并明确未能持久化");
        try { await service.BootstrapAsync(lifetime.Token); } catch (InvalidOperationException) { }
        Check(revokedEvents == before + 2, "已置内存撤权后重试仍可通知停机而不丢失通知");
    }
    bootstrapStatus = 200; await service.BootstrapAsync(lifetime.Token);
    using (var locked = new FileStream(Path.Combine(root, "sessions", sid + ".json"), FileMode.Open, FileAccess.Read, FileShare.Read)) {
        bootstrapStatus = 401; var before = revokedEvents;
        try { await service.BootstrapAsync(lifetime.Token); } catch (InvalidOperationException) { }
        Check(service.IsRevoked && revokedEvents == before + 1 && service.Load()["error"]!.GetValue<string>().Contains("未能保存"), "历史待核对标记写入失败仍到达停机通知");
    }
    bootstrapStatus = 200; await service.BootstrapAsync(lifetime.Token); await service.SyncAsync(true, lifetime.Token);

    var local = Advance(j, "edit_question"); var localId = local["events"]!.AsArray().Last()!["id"]!.GetValue<string>();
    localCommandIds.Add(localId);
    var command = JsonNode.Parse(local["receipts"]![localId]!["fingerprint"]!.GetValue<string>())!.AsObject();
    command["payload"]!["text"] = new string('x', 20000); local["events"]!.AsArray().Last()!["payload"] = command["payload"]!.DeepClone(); local["receipts"]![localId]!["fingerprint"] = command.ToJsonString();
    service.Store.Commit(local); j = Advance(local, "recover"); service.Store.Commit(j);
    await service.SyncAsync(false, lifetime.Token);
    Check(received.Last()["events"]!.AsArray().Count == 2 && received.Last()["receipts"]!.AsArray().Count == 1 && received.Last()["receipts"]![0]!["id"]!.GetValue<string>() != localId,
        "手机来源下本机长题目保留完整事件，仅实际手机请求进入有界回执通道");
    Check(service.Store.LoadCache("receipt-" + sid)!["seq"]!.GetValue<int>() == j["session"]!["seq"]!.GetValue<int>(), "本机长题目与后续手机回执全部确认后推进恢复进度");

    var publicationId = Guid.NewGuid().ToString(); publications.Add(new JsonObject { ["id"] = publicationId, ["title"] = "isolated", ["questionCount"] = 0 }); await service.BootstrapAsync(lifetime.Token);
    service.Store.SaveCache("publication-" + publicationId, new JsonObject { ["publication"] = new JsonObject { ["id"] = publicationId }, ["images"] = new JsonObject() });
    var started = Initial(Guid.NewGuid().ToString()); started["publicationId"] = publicationId; service.Commit(started);
    publications.Clear(); await service.BootstrapAsync(lifetime.Token);
    var future = Initial(Guid.NewGuid().ToString()); future["publicationId"] = publicationId;
    Refuses(() => service.Commit(future), "已获知题单撤回后在原生首次提交处拒绝新课堂");
    Check((await service.PublicationAsync(publicationId, lifetime.Token, started["session"]!["id"]!.GetValue<string>()))["publication"]!["id"]!.GetValue<string>() == publicationId, "题单撤回保留已经建立的原课堂快照");

    publications.Add(new JsonObject { ["id"] = publicationId });
    holdBootstrap = new(TaskCreationOptions.RunContinuationsAsynchronously); bootstrapStarted = new(TaskCreationOptions.RunContinuationsAsynchronously); var release = holdBootstrap;
    var earlier = service.BootstrapAsync(lifetime.Token); await bootstrapStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
    publications.Clear(); var callsBefore = bootstrapCalls; var later = service.BootstrapAsync(lifetime.Token); await Task.Delay(80);
    Check(bootstrapCalls == callsBefore && maximumBootstrap == 1, "并发名单刷新串行请求和应用避免旧响应覆盖");
    release.TrySetResult(); await Task.WhenAll(earlier, later);
    Check(service.Store.LoadCache("context")!["publications"]!.AsArray().Count == 0, "最后接受的题单撤回不会被旧发布列表恢复");

    holdBootstrap = new(TaskCreationOptions.RunContinuationsAsynchronously); bootstrapStarted = new(TaskCreationOptions.RunContinuationsAsynchronously); release = holdBootstrap;
    earlier = service.BootstrapAsync(lifetime.Token); await bootstrapStarted.Task.WaitAsync(TimeSpan.FromSeconds(5)); relayStatus = 401;
    try { await service.RelayAsync(new JsonObject(), lifetime.Token); } catch (Exception) { }
    release.TrySetResult(); await earlier;
    Check(service.IsRevoked && service.Store.LoadCache("context")!["revoked"]!.GetValue<bool>(), "其他设备请求已撤权后迟到的旧200不能解除撤权");

    bootstrapStatus = 200; relayStatus = 200; await service.BootstrapAsync(lifetime.Token);
    var multiId = Guid.NewGuid().ToString(); var multiQuestionId = Guid.NewGuid().ToString(); var multiRoundId = Guid.NewGuid().ToString();
    var multi = Initial(multiId); var multiSession = multi["session"]!;
    multiSession["cardVersion"] = "ice-v1"; multiSession["source"] = "phone"; multiSession["sourceId"] = Guid.NewGuid().ToString();
    multiSession["currentQuestionId"] = multiQuestionId; multiSession["currentRoundId"] = multiRoundId;
    multiSession["questions"] = new JsonArray(new JsonObject { ["id"] = multiQuestionId, ["type"] = "multiple", ["options"] = new JsonArray("甲", "乙"), ["answer"] = "A",
        ["rounds"] = new JsonArray(new JsonObject { ["id"] = multiRoundId, ["status"] = "collecting", ["activeOption"] = "A", ["generation"] = 1, ["answers"] = new JsonObject(), ["exempt"] = new JsonArray() }) });
    JsonObject MultiRound(JsonObject journal) => journal["session"]!["questions"]![0]!["rounds"]![0]!.AsObject();
    void MultiPublic(JsonObject journal, string target, int received, int optionReceived) {
        var state = journal["receipts"]!.AsObject().Last().Value!["result"]!["state"]!;
        state["questionType"] = "multiple"; state["activeOption"] = target; state["received"] = received; state["optionReceived"] = optionReceived;
    }
    service.Commit(multi);
    multi = Advance(multi, "answer", content: new JsonObject { ["cardNumber"] = 1, ["option"] = "B", ["targetOption"] = "A" });
    MultiRound(multi)["answers"]!["s1"] = new JsonObject { ["choices"] = new JsonObject { ["A"] = false }, ["option"] = "", ["confirmedAt"] = 1001, ["seq"] = 1 };
    MultiPublic(multi, "A", 0, 1); service.Commit(multi);
    multi = Advance(multi, "set_multi_option", content: new JsonObject { ["option"] = "B" });
    MultiRound(multi)["activeOption"] = "B"; MultiRound(multi)["generation"] = 2; MultiPublic(multi, "B", 0, 0); service.Commit(multi);
    Check(service.Load()["journals"]!.AsArray().Any(n => n!["session"]!["id"]!.GetValue<string>() == multiId), "服务载入包含新换项动作的部分多选记录");
    multi = Advance(multi, "answer", content: new JsonObject { ["cardNumber"] = 1, ["option"] = "B", ["targetOption"] = "B" });
    MultiRound(multi)["answers"]!["s1"]!["choices"]!["B"] = false;
    MultiRound(multi)["answers"]!["s1"]!["confirmedAt"] = 1003; MultiRound(multi)["answers"]!["s1"]!["seq"] = 3;
    MultiPublic(multi, "B", 1, 1); service.Commit(multi);
    loseReply = true;
    try { await service.SyncAsync(false, lifetime.Token); throw new Exception("truncated multiple sync was accepted"); } catch (HttpRequestException) { } catch (IOException) { }
    var multiWire = received.Last(n => n["session"]!["id"]!.GetValue<string>() == multiId).DeepClone();
    Check(service.Store.Read(multiId)!["syncedSeq"]!.GetValue<int>() == 0 &&
        multiWire["events"]![1]!["action"]!.GetValue<string>() == "set_multi_option" &&
        multiWire["events"]![2]!["payload"]!["targetOption"]!.GetValue<string>() == "B", "多选换项与目标项完整上传且丢确认不推进进度");
    CardQuizService.Stop(); loseReply = false; service = CardQuizService.For(config);
    await service.SyncAsync(false, lifetime.Token);
    var resentMulti = received.Last(n => n["session"]!["id"]!.GetValue<string>() == multiId);
    Check(JsonNode.DeepEquals(multiWire["session"], resentMulti["session"]) && JsonNode.DeepEquals(multiWire["events"], resentMulti["events"]) &&
        JsonNode.DeepEquals(multiWire["receipts"], resentMulti["receipts"]), "重启补传多选状态事件与每份历史手机回执原样一致");
    Check(MultiRound(service.Store.Read(multiId)!)["answers"]!["s1"]!["option"]!.GetValue<string>() == "" &&
        JsonNode.DeepEquals(MultiRound(service.Store.Read(multiId)!)["answers"]!["s1"]!["choices"], JsonNode.Parse("{\"A\":false,\"B\":false}")) &&
        service.Store.LoadCache("receipt-" + multiId)!["seq"]!.GetValue<int>() == 3, "全不选的完整确认与多选手机回执进度在重启后保留");
    Check(resentMulti["receipts"]![0]!["result"]!["state"]!["received"]!.GetValue<int>() == 0 &&
        resentMulti["receipts"]![1]!["result"]!["state"]!["activeOption"]!.GetValue<string>() == "B" &&
        resentMulti["receipts"]![2]!["result"]!["state"]!["received"]!.GetValue<int>() == 1 &&
        resentMulti["receipts"]!.AsArray().All(r => r!["result"]!["state"]!["choices"] is null && r["result"]!["state"]!["answers"] is null),
        "多选历史公开回执保留部分到完整计数且不注入个人选择");
    bootstrapStatus = 401; try { await service.BootstrapAsync(lifetime.Token); } catch (InvalidOperationException) { }
    Refuses(() => service.Commit(Advance(multi, "set_multi_option", content: new JsonObject { ["option"] = "A" })), "设备撤权仍拒绝多选换项动作");
    CardQuizService.Stop(); Console.WriteLine($"{count} checks passed");
} catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
finally { CardQuizService.Stop(); lifetime.Cancel(); listener.Stop(); await serving; await Task.WhenAll(handlers); }

namespace ICeClass.Receiver {
    internal sealed class ReceiverConfig {
        public string Endpoint { get; set; } = ""; public string ClassId { get; set; } = ""; public string ClassName { get; set; } = ""; public string DeviceId { get; set; } = ""; public string DeviceToken { get; set; } = "";
        internal static ReceiverConfig ProtectedCopy(ReceiverConfig c) => new() { Endpoint = c.Endpoint, ClassId = c.ClassId, ClassName = c.ClassName, DeviceId = c.DeviceId, DeviceToken = "dpapi:synthetic-persistence-value" };
        internal static bool IsPreview(ReceiverConfig _) => true;
        internal static string NormalizeEndpoint(string value) => value.TrimEnd('/');
    }
}

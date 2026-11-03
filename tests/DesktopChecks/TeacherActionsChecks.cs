#if TEACHER_ACTION_CHECKS
using System.Text.Json;
using ICeClass.Desktop;

var checks = 0;
void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks++; }
const string endpoint = "https://school.example";
const string page = endpoint + "/teacher/";
var clientId = Guid.NewGuid().ToString();
TeacherActionContext? context = new(clientId, "native-only-session-secret");
var calls = 0;
var release = new TaskCompletionSource<TeacherActionResult>(TaskCreationOptions.RunContinuationsAsynchronously);
var registry = new TeacherActions(endpoint, () => Task.FromResult<TeacherActionContext?>(context),
    new("teacher.about", "关于", false, "打开窗口", _ => { calls++; return release.Task; }),
    new("teacher.refresh", "刷新", false, "重新加载", _ => throw new Exception("password=exception-secret")));
string Request(string method = "execute", string action = "teacher.about", object? payload = null,
    string operationId = "test-operation", string? document = null) => JsonSerializer.Serialize(new {
        type = "iceclass-teacher-action", requestId = Guid.NewGuid().ToString(), clientId = document ?? clientId, method,
        action, payload = payload ?? new { }, operationId });
string Catalog(string? document = null) => JsonSerializer.Serialize(new {
    type = "iceclass-teacher-action", requestId = Guid.NewGuid().ToString(), clientId = document ?? clientId, method = "catalog" });
async Task<JsonElement> Result(string message, string source = page, string current = page, bool mainFrame = true)
{
    var reply = await registry.HandleAsync(message, source, current, mainFrame);
    Assert(reply is not null, "Valid request gets a reply");
    var json = JsonSerializer.Serialize(reply, TeacherActions.Json);
    Assert(!json.Contains("native-only-session-secret") && !json.Contains("exception-secret"), "Native secrets never appear in receipts");
    return JsonSerializer.SerializeToElement(reply!.Result, TeacherActions.Json);
}
void Code(JsonElement result, string code) => Assert(result.GetProperty("code").GetString() == code, "Expected refusal: " + code);

var catalog = await Result(Catalog());
Assert(catalog.GetProperty("clientId").GetString() == clientId, "Catalog identifies the current document");
Assert(catalog.GetProperty("actions").GetArrayLength() == 2, "Catalog comes from registered actions");
Assert(catalog.GetProperty("actions")[0].GetProperty("fields").GetArrayLength() == 0, "Registered actions declare empty fields");
Assert(!catalog.GetProperty("actions")[1].GetProperty("confirmation").GetBoolean(), "Refresh leaves confirmation to the original native guard");
Code(await Result(Request(action: "teacher.unknown")), "unknown-action");
foreach (var payload in new object[] { new { unexpected = "secret-input" }, new[] { "value" }, 42 })
    Code(await Result(Request(payload: payload)), "invalid-fields");
foreach (var id in new[] { "", new string('x', 129), "bad id", "../bad?" })
    Code(await Result(Request(operationId: id)), "invalid-operation-id");
Code(await Result(Request(method: "arbitrary")), "unknown-method");
Code(await Result(Request(method: "receipt", operationId: "never-executed")), "receipt-missing");
Assert(calls == 0, "Malformed, unknown, and invalid-field requests have no effects");
foreach (var origin in new[] { "https://school.example.attacker.test/teacher/", "http://school.example/teacher/", "https://user:secret@school.example/teacher/", "https://school.example:444/teacher/" })
    Code(await Result(Request(), source: origin), "untrusted-source");
Code(await Result(Request(), mainFrame: false), "untrusted-source");
Code(await Result(Request(), current: endpoint + "/other/"), "untrusted-source");
Assert(TeacherActions.TrustedSource(endpoint, page + "#one", page + "#two", true), "Hash changes stay in the same main document");
context = null;
Code(await Result(Request()), "sign-in-required");
Assert((await Result(Catalog())).GetProperty("actions").GetArrayLength() == 0, "Signed-out catalog has no actions");
context = new(clientId, "native-only-session-secret");
Code(await Result(Request(document: Guid.NewGuid().ToString())), "document-changed");

var request = Request();
var first = registry.HandleAsync(request, page, page, true);
var duplicate = registry.HandleAsync(Request(), page, page, true);
Assert(calls == 1 && !first.IsCompleted && !duplicate.IsCompleted, "Concurrent duplicate operations share one invocation");
release.SetResult(TeacherActionResult.Opened("已打开，尚未保存。"));
var pair = await Task.WhenAll(first, duplicate);
Assert(ReferenceEquals(pair[0]!.Result, pair[1]!.Result), "Concurrent duplicates share the same receipt");
Assert((await Result(Request())).GetProperty("state").GetString() == "opened" && calls == 1, "Completed duplicates reuse the receipt without opening again");
Code(await Result(Request(action: "teacher.refresh")), "operation-conflict");
context = new(clientId, "different-account-session");
Code(await Result(Request()), "operation-conflict");
context = null;
Code(await Result(Request()), "sign-in-required");
context = new(clientId, "native-only-session-secret");
var failed = await Result(Request(action: "teacher.refresh", operationId: "failed-operation"));
Code(failed, "action-failed");
Assert(!failed.GetProperty("success").GetBoolean() && !failed.GetProperty("verified").GetBoolean(), "Exception details cannot imply verified success");
registry.InvalidateDocument();
context = new(Guid.NewGuid().ToString(), "native-only-session-secret");
Code(await Result(Request(document: context.ClientId)), "operation-conflict");

var auth = new TaskCompletionSource<TeacherActionContext?>(TaskCreationOptions.RunContinuationsAsynchronously);
var waitingCalls = 0;
var waiting = new TeacherActions(endpoint, () => auth.Task,
    new TeacherAction("teacher.about", "关于", false, "打开", _ => { waitingCalls++; return Task.FromResult(TeacherActionResult.Opened("打开")); }));
var stale = waiting.HandleAsync(Request(), page, page, true);
waiting.InvalidateDocument(); auth.SetResult(new(clientId, "session"));
Assert(((TeacherActionResult)(await stale)!.Result).Code == "document-changed" && waitingCalls == 0, "Navigation during authentication prevents execution");
registry.InvalidateDocument(closed: true);
Code(await Result(Request()), "closed");

var count = 0;
var bounded = new TeacherActions(endpoint, () => Task.FromResult<TeacherActionContext?>(new(clientId, "session")),
    new TeacherAction("teacher.about", "关于", false, "打开", _ => { count++; return Task.FromResult(TeacherActionResult.Opened("打开")); }));
for (var index = 0; index < TeacherActions.MaximumOperations; index++)
    await bounded.HandleAsync(Request(operationId: "bounded-" + index), page, page, true);
var full = await bounded.HandleAsync(Request(operationId: "one-too-many"), page, page, true);
Assert(((TeacherActionResult)full!.Result).Code == "operation-limit" && count == TeacherActions.MaximumOperations, "A full receipt cache refuses new work without evicting old IDs");
await bounded.HandleAsync(Request(operationId: "bounded-0"), page, page, true);
Assert(count == TeacherActions.MaximumOperations, "The oldest receipt still prevents duplicate execution at capacity");
var afterReply = 0;
var started = new TeacherActionResult(true, false, "开始", "started") { AfterReply = () => afterReply++ };
Assert(!JsonSerializer.Serialize(started, TeacherActions.Json).Contains("afterReply"), "Native continuations are never serialized");
started.ReplyScheduled(); started.ReplyScheduled();
Assert(afterReply == 1, "Refresh navigation can only be scheduled once after a receipt");
Assert(TeacherActions.IsMessage(new string('x', TeacherActions.MaximumMessageLength + 1)), "Oversized messages cannot enter diagnostic fallback");
Assert(!TeacherActions.IsMessage("not-json"), "Malformed unrelated messages are ignored");
Assert(await bounded.HandleAsync("{}", page, page, true) is null, "Non-bridge messages are ignored");
Console.WriteLine($"Teacher native action checks passed: {checks}");
#endif

using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

var checks = 0;
void Check(bool value, string label) { if (!value) throw new Exception(label); checks++; Console.WriteLine("PASS " + label); }
static async Task Wait(Func<bool> condition) { using var limit = new CancellationTokenSource(5000); while (!condition()) await Task.Delay(10, limit.Token); }

try
{
await using (var fixture = new Fixture())
{
    ClassroomAgentWorker.Observations.Enqueue([new("A", "原题A"), new("B", "原题B")]);
    ClassroomAgentWorker.Observations.Enqueue([new("B", "原题B")]);
    ClassroomMathDialogs.Choices.Enqueue("A"); ClassroomMathDialogs.Choices.Enqueue("B");
    await fixture.StartAsync(); await fixture.Review.ContinueAsync(); await fixture.StartAsync();
    Check(ClassroomMathDialogs.ChoiceCount == 2, "a lost selected window requires a new explicit choice even with one remaining window");
    Check(ClassroomAgentWorker.Captured.SequenceEqual(new[] { "A", "B" }), "the confirmed replacement is captured");
}

await using (var fixture = new Fixture())
{
    await fixture.StartAsync();
    Check(ClassroomMathDialogs.ChoiceCount == 0 && ClassroomAgentWorker.Captured.SequenceEqual(new[] { "A" }), "one initial window is selected automatically");
    var result = fixture.Workshop.States.Last();
    Check(result.GetProperty("state").GetString() == "complete" && result.GetProperty("verdict").GetString() == "correct", "validated complete result reaches the display");
    Check(!result.TryGetProperty("observations", out _) && !JsonSerializer.Serialize(fixture.Workshop.Commands).Contains("synthetic-token"), "display receives neither internal evidence nor credentials");
    await fixture.Review.ContinueAsync();
    await Wait(() => fixture.Cancellations.Count == 1);
    Check(fixture.Cancellations.Single() == fixture.PreparedKeys.Single(), "continue cancels the exact prepared request key");
}

await using (var fixture = new Fixture { WrongResultId = true })
{
    await fixture.StartAsync();
    Check(!fixture.Workshop.States.Any(state => state.GetProperty("state").GetString() == "complete") && fixture.Workshop.States.Last().GetProperty("state").GetString() == "error", "a response for another review ID never reaches the display");
}

await using (var fixture = new Fixture { RequireSelection = true })
{
    ClassroomMathDialogs.Selection = new(0, 0, 1, 1);
    await fixture.StartAsync();
    Check(fixture.Paths.Count(path => path.EndsWith("/selection")) == 1 && fixture.Workshop.Commands.Count(command => command.Type == "freeze_frame") == 1, "selection continues the same review without refreezing");
    Check(fixture.SelectionBody is { } selected && selected.GetProperty("width").GetInt32() == 1 && selected.EnumerateObject().Count() == 4, "selection sends original integer coordinates only");
}

await using (var fixture = new Fixture { RequireSelection = true })
{
    await fixture.StartAsync();
    Check(!fixture.Paths.Any(path => path.EndsWith("/selection")) && fixture.Workshop.Commands.Any(command => command.Type == "resume"), "cancelled question selection resumes without a fabricated verdict");
}

await using (var fixture = new Fixture())
{
    ClassroomAgentWorker.QuestionOffset = -3000;
    await fixture.StartAsync();
    Check(!fixture.Paths.Any(path => path.EndsWith("/analyse")) && fixture.Workshop.States.Last().GetProperty("state").GetString() == "error", "mixed-time images are rejected before analysis");
}

await using (var fixture = new Fixture())
{
    ClassroomAgentWorker.Observations.Enqueue([]);
    await fixture.StartAsync();
    Check(!fixture.Paths.Any(), "missing WPS stops before preparing a paid review");
}

await using (var fixture = new Fixture { HoldAnalysis = true })
{
    var pending = fixture.StartAsync();
    await Wait(() => fixture.Paths.Any(path => path.EndsWith("/analyse")));
    await fixture.Review.ContinueAsync();
    fixture.ReleaseAnalysis.TrySetResult(); await pending;
    await Wait(() => fixture.Cancellations.Count == 1);
    Check(!fixture.Workshop.States.Any(state => state.GetProperty("state").GetString() == "complete"), "a late analysis cannot overwrite a resumed display");
    fixture.HoldAnalysis = false; await fixture.StartAsync();
    Check(fixture.Workshop.States.Last().GetProperty("state").GetString() == "complete" && fixture.PreparedKeys.Distinct().Count() == 2, "a new generation completes independently after cancellation");
}

await using (var fixture = new Fixture())
{
    fixture.Workshop.Fire("review_requested", new { generation = 7 });
    await Wait(() => fixture.Workshop.States.Any(state => state.GetProperty("state").GetString() == "complete"));
    Check(fixture.Workshop.Commands.Where(command => command.Type is "freeze_frame" or "review_state").All(command => command.Payload.GetProperty("generation").GetInt64() == 7), "source generation follows freeze and every display state");
    var commandCount = fixture.Workshop.Commands.Count;
    fixture.Workshop.Fire("resume_requested", new { generation = 6 });
    fixture.Workshop.Fire("review_requested", new { generation = 7 });
    await Task.Delay(40);
    Check(fixture.Workshop.Commands.Count == commandCount && fixture.PreparedKeys.Count == 1, "old source events and duplicate requests cannot replace the current review");
    fixture.Workshop.Fire("resume_requested", new { generation = 8 });
    await Wait(() => fixture.Workshop.Commands.Any(command => command.Type == "resume"));
    Check(fixture.Workshop.Commands.Last(command => command.Type == "resume").Payload.GetProperty("generation").GetInt64() == 8, "resume acknowledges the generation emitted after local clearing");
}

Console.WriteLine($"PASS {checks} math review coordinator checks");
}
catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }

internal sealed class Fixture : IAsyncDisposable
{
    private readonly HttpListener _listener = new();
    private readonly Task _server;
    private readonly ConcurrentBag<Task> _handlers = [];
    internal readonly ConcurrentQueue<string> Paths = [], PreparedKeys = [], Cancellations = [];
    internal readonly TaskCompletionSource ReleaseAnalysis = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal readonly ClassroomWorkshopService Workshop = new();
    internal readonly ClassroomMathReview Review;
    private long _generation;
    internal Task StartAsync() => Review.StartAsync(++_generation);
    internal bool WrongResultId, RequireSelection, HoldAnalysis;
    internal JsonElement? SelectionBody;
    private string _id = "";
    internal Fixture()
    {
        ClassroomAgentWorker.ResetFixture(); ClassroomMathDialogs.ResetFixture();
        using var port = new TcpListener(IPAddress.Loopback, 0); port.Start();
        var endpoint = "http://127.0.0.1:" + ((IPEndPoint)port.LocalEndpoint).Port; port.Stop();
        _listener.Prefixes.Add(endpoint + "/"); _listener.Start();
        _server = Task.Run(async () => {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync(); } catch (Exception error) when (error is HttpListenerException or ObjectDisposedException) { break; }
                _handlers.Add(HandleAsync(context));
            }
        });
        Review = new(Workshop, () => new ReceiverConfig { Endpoint = endpoint, DeviceId = "synthetic-device", ClassId = "synthetic-class", DeviceToken = "synthetic-token" });
    }
    private async Task HandleAsync(HttpListenerContext context)
    {
        try
        {
            var path = context.Request.Url!.AbsolutePath; Paths.Enqueue(path);
            if (context.Request.Headers["Authorization"] != "Bearer synthetic-token" || context.Request.Headers["X-ICeClass-Device"] != "synthetic-device" || context.Request.Headers["X-ICeClass-Class"] != "synthetic-class") throw new Exception("missing device identity");
            using var input = new StreamReader(context.Request.InputStream); var text = await input.ReadToEndAsync();
            using var document = JsonDocument.Parse(text.Length == 0 ? "{}" : text); var body = document.RootElement;
            object response;
            if (path == "/api/session") response = new { user = new { csrfToken = "synthetic-csrf" } };
            else
            {
                if (context.Request.Headers["X-CSRF-Token"] != "synthetic-csrf") throw new Exception("missing csrf");
                if (path == "/api/banban/math-reviews")
                {
                    PreparedKeys.Enqueue(body.GetProperty("requestKey").GetString()!); _id = Guid.NewGuid().ToString("N");
                    response = new { reviewId = _id, expiresAt = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(), quota = new { used = 0 } };
                }
                else if (path.EndsWith("/cancel")) { Cancellations.Enqueue(body.GetProperty("requestKey").GetString()!); response = new { cancelled = true }; }
                else
                {
                    var id = _id;
                    if (path.EndsWith("/selection")) SelectionBody = body.Clone();
                    if (HoldAnalysis && path.EndsWith("/analyse")) await ReleaseAnalysis.Task;
                    object result = RequireSelection && path.EndsWith("/analyse") ? new { state = "needs_question_selection", reason = "同页多题" }
                        : new { state = "complete", verdict = "correct", strength = "等价变形正确。", nextStep = "", knowledgePoints = new[] { "等价变形" }, observations = new[] { "两边同时减去相同数。" } };
                    response = new { reviewId = WrongResultId ? Guid.NewGuid().ToString("N") : id, result, quota = new { used = 1 } };
                }
            }
            var bytes = JsonSerializer.SerializeToUtf8Bytes(response); context.Response.ContentType = "application/json"; context.Response.ContentLength64 = bytes.Length;
            await context.Response.OutputStream.WriteAsync(bytes); context.Response.Close();
        }
        catch (Exception error) when (error is HttpListenerException or IOException or ObjectDisposedException) { }
    }
    public async ValueTask DisposeAsync()
    {
        ReleaseAnalysis.TrySetResult(); Review.Dispose(); await Task.Delay(20); _listener.Close(); await _server; await Task.WhenAll(_handlers);
    }
}

namespace ICeClass.Receiver
{
    internal class ReceiverConfig { public string Endpoint = "", DeviceId = "", ClassId = "", DeviceToken = "", ClassName = "", DeviceName = ""; }
    internal record AgentApplication(string Kind);
    internal class ClassroomAgentPolicy { internal bool Enabled => true; internal static ClassroomAgentPolicy Load() => new(); internal AgentApplication[] Available(ReceiverConfig config) => [new("wps-presentation")]; }
    internal record ClassroomQuestionWindow(string Id, string Title);
    internal record ClassroomQuestionSelection(int X, int Y, int Width, int Height);
    internal static class ClassroomMathDialogs
    {
        internal static readonly Queue<string?> Choices = new(); internal static int ChoiceCount; internal static ClassroomQuestionSelection? Selection;
        internal static void ResetFixture() { Choices.Clear(); ChoiceCount = 0; Selection = null; }
        internal static Task<string?> ChooseWindowAsync(IReadOnlyList<ClassroomQuestionWindow> windows, CancellationToken token) { ChoiceCount++; return Task.FromResult(Choices.TryDequeue(out var choice) ? choice : windows.First().Id); }
        internal static Task ShowQuestionAsync(ClassroomMathImage image, CancellationToken token) => Task.CompletedTask;
        internal static Task<ClassroomQuestionSelection?> SelectQuestionAsync(ClassroomMathImage image, CancellationToken token) => Task.FromResult(Selection);
    }
    internal sealed record ClassroomPluginMessage(JsonElement Payload);
    internal class ClassroomWorkshopService
    {
        internal event Action<string, JsonElement>? ActionRequested;
        internal event Action? ReviewInvalidated;
        internal readonly List<(string Type, JsonElement Payload)> Commands = [];
        internal IEnumerable<JsonElement> States => Commands.Where(command => command.Type == "review_state").Select(command => command.Payload);
        internal bool IsRunning => true;
        internal void Fire(string type, object payload) => ActionRequested?.Invoke(type, JsonSerializer.SerializeToElement(payload));
        internal Task<ClassroomPluginMessage> CommandAsync(string type, object payload, CancellationToken token)
        {
            token.ThrowIfCancellationRequested(); Commands.Add((type, JsonSerializer.SerializeToElement(payload)));
            var frame = JsonSerializer.SerializeToNode(ClassroomAgentWorker.Image())!.AsObject();
            if (JsonSerializer.SerializeToElement(payload).TryGetProperty("generation", out var generation)) frame["generation"] = generation.GetInt64();
            return Task.FromResult(new ClassroomPluginMessage(JsonSerializer.SerializeToElement(frame)));
        }
        internal void Suspend() => ReviewInvalidated?.Invoke();
    }
    internal class ClassroomAgentWorker
    {
        internal static readonly Queue<ClassroomQuestionWindow[]> Observations = new(); internal static readonly List<string> Captured = []; internal static int QuestionOffset;
        internal static void ResetFixture() { Observations.Clear(); Captured.Clear(); QuestionOffset = 0; }
        internal static object Image(int offset = 0) => new { dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=", width = 1, height = 1, capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + offset };
        internal Task<JsonObject> MathWindowsAsync(AgentApplication[] apps, CancellationToken token) => Task.FromResult(JsonSerializer.SerializeToNode(new { windows = Observations.TryDequeue(out var windows) ? windows.Select(window => new { id = window.Id, title = window.Title }).ToArray() : [new { id = "A", title = "原题A" }] })!.AsObject());
        internal Task<JsonObject> MathCaptureAsync(string id, AgentApplication[] apps, CancellationToken token) { Captured.Add(id); return Task.FromResult(JsonSerializer.SerializeToNode(Image(QuestionOffset))!.AsObject()); }
        internal void Reset() { }
    }
}

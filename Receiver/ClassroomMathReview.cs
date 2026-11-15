using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>One immutable pair per local generation; only the host has classroom credentials.</summary>
internal sealed class ClassroomMathReview : IDisposable
{
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private readonly ClassroomWorkshopService _workshop;
    private readonly Func<ReceiverConfig?> _binding;
    private readonly ClassroomAgentWorker _windows = new();
    private Review? _current;
    private ClassroomMathImage? _question;
    private string? _targetId;
    private long _generation;
    private long _pluginGeneration;
    private bool _disposed, _questionOpen;
    private sealed class Review(long generation, long pluginGeneration, ReceiverConfig binding)
    {
        internal readonly long Generation = generation;
        internal readonly long PluginGeneration = pluginGeneration;
        internal readonly ReceiverConfig Binding = binding;
        internal readonly string RequestKey = Guid.NewGuid().ToString("N");
        internal readonly CancellationTokenSource Lifetime = new();
        internal string? Csrf, ReviewId;
        internal int CancelSent;
    }
    internal ClassroomMathReview(ClassroomWorkshopService workshop, Func<ReceiverConfig?> binding)
    {
        _workshop = workshop; _binding = binding;
        workshop.ActionRequested += ActionRequested;
        workshop.ReviewInvalidated += EndSession;
    }
    private async void ActionRequested(string action, JsonElement payload)
    {
        try
        {
            if (action == "open_workshop") return;
            if (!payload.TryGetProperty("generation", out var source) || !source.TryGetInt64(out var generation) ||
                generation is <= 0 or > 9007199254740991) return;
            if (action == "question_requested")
            {
                if (_current?.PluginGeneration != generation) return;
            }
            else
            {
                if (generation <= _pluginGeneration) return;
                _pluginGeneration = generation;
            }
            switch (action)
            {
                case "review_requested": await StartAsync(generation); break;
                case "resume_requested": await ContinueAsync(generation); break;
                case "review_invalidated": Invalidate(); break;
                case "question_requested":
                    if (_question is not null && _current is { } current && !_questionOpen)
                    { _questionOpen = true; try { await ClassroomMathDialogs.ShowQuestionAsync(_question, current.Lifetime.Token); } finally { _questionOpen = false; } }
                    break;
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { /* A disconnect cannot publish an old result. */ }
    }

    private bool Current(Review review) => !_disposed && ReferenceEquals(_current, review) && review.Generation == _generation;
    private static ReceiverConfig Copy(ReceiverConfig config) => new() { Endpoint = config.Endpoint, DeviceId = config.DeviceId,
        ClassId = config.ClassId, DeviceToken = config.DeviceToken, ClassName = config.ClassName, DeviceName = config.DeviceName };

    internal async Task StartAsync(long pluginGeneration)
    {
        if (_disposed || pluginGeneration is <= 0 or > 9007199254740991 || pluginGeneration < _pluginGeneration) return;
        _pluginGeneration = pluginGeneration;
        if (_current is { } current)
        {
            if (current.PluginGeneration == pluginGeneration) return;
            Invalidate();
        }
        var binding = _binding();
        if (binding is null) return;
        var review = new Review(++_generation, pluginGeneration, Copy(binding)); _current = review;
        var token = review.Lifetime.Token;
        try
        {
            await State(review, new { state = "preparing", message = "正在确定本次题目…" });
            var policy = ClassroomAgentPolicy.Load();
            if (!policy.Enabled) throw new InvalidOperationException("本机已关闭班班电脑查看，请在班班电脑设置中开启查看后再点评。");
            var apps = policy.Available(binding).Where(app => app.Kind.StartsWith("wps-", StringComparison.Ordinal)).ToArray();
            var observed = await _windows.MathWindowsAsync(apps, token);
            var candidates = observed["windows"]!.AsArray().Select(window => new ClassroomQuestionWindow(window!["id"]!.GetValue<string>(), window["title"]!.GetValue<string>())).ToArray();
            if (candidates.Length == 0) throw new InvalidOperationException("未找到可用的 WPS 放映，请先开始放映，再点评当前题目。");
            if (!candidates.Any(window => window.Id == _targetId)) _targetId = _targetId is null && candidates.Length == 1 ? candidates[0].Id
                : await ClassroomMathDialogs.ChooseWindowAsync(candidates, token);
            if (!Current(review)) return;
            if (_targetId is null) { await ContinueAsync(); return; }

            var session = await Request(review, "/api/session", null, token, 10);
            review.Csrf = session.GetProperty("user").GetProperty("csrfToken").GetString() ?? throw new InvalidOperationException("教室身份未就绪，请检查连接。");
            var prepared = await Request(review, "/api/banban/math-reviews", new { requestKey = review.RequestKey }, token, 15);
            review.ReviewId = prepared.GetProperty("reviewId").GetString();
            if (!Guid.TryParseExact(review.ReviewId, "N", out _)) throw new InvalidDataException("点评会话编号无效，请重新开始。");
            review.Lifetime.CancelAfter(TimeSpan.FromMinutes(5));
            if (!Current(review)) return;

            var captured = await _workshop.CommandAsync("freeze_frame", new { generation = review.PluginGeneration }, token);
            if (!captured.Payload.TryGetProperty("generation", out var frameGeneration) ||
                !frameGeneration.TryGetInt64(out var sourceGeneration) || sourceGeneration != review.PluginGeneration)
                throw new InvalidDataException("作答画面已变化，请继续展示后重新点评。");
            var answer = ClassroomMathImage.FromPayload(captured.Payload);
            if (Math.Abs((decimal)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - answer.CapturedAt) > 2000)
                throw new InvalidOperationException("视频画面不够新鲜，请恢复画面后继续展示再点评。");
            // Select first, freeze second, then read the already-observed HWND without changing focus.
            var questionPayload = await _windows.MathCaptureAsync(_targetId, apps, token);
            var question = ClassroomMathImage.FromPayload(JsonSerializer.SerializeToElement(questionPayload));
            ClassroomMathImage.ValidatePair(question, answer, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (!Current(review)) return;
            _question = question;
            await State(review, new { state = "analysing", message = "正在阅读题目与作答…" });
            var analysed = await Request(review, "/api/banban/math-reviews/" + review.ReviewId + "/analyse",
                new { question = question.Payload(), answer = answer.Payload() }, token, 65);
            if (!Current(review)) return;
            var result = ResultFor(review, analysed);
            if (result.GetProperty("state").GetString() == "needs_question_selection")
            {
                await State(review, new { state = "awaiting_selection", message = "请框选本次题目，确定后再判断作答。" });
                var selection = await ClassroomMathDialogs.SelectQuestionAsync(question, token);
                if (!Current(review)) return;
                if (selection is null) { await ContinueAsync(); return; }
                await State(review, new { state = "analysing", message = "正在点评所选题目…" });
                var resumed = await Request(review, "/api/banban/math-reviews/" + review.ReviewId + "/selection",
                    new { x = selection.X, y = selection.Y, width = selection.Width, height = selection.Height }, token, 65);
                result = ResultFor(review, resumed);
            }
            if (!Current(review)) return;
            var verdict = result.GetProperty("verdict").GetString();
            var strength = result.GetProperty("strength").GetString() ?? "";
            var nextStep = result.GetProperty("nextStep").GetString() ?? "";
            var knowledge = result.GetProperty("knowledgePoints").EnumerateArray().Select(point => point.GetString() ?? "").ToArray();
            if (result.GetProperty("state").GetString() != "complete" || verdict is not ("correct" or "incorrect" or "incomplete" or "uncertain") ||
                (strength + nextStep).EnumerateRunes().Count() > 120 || knowledge.Length > 2 || knowledge.Any(point => point.EnumerateRunes().Count() > 24))
                throw new InvalidDataException("点评结果格式无效，请继续展示后重新点评。");
            await State(review, new { state = "complete", verdict, strength, nextStep, knowledgePoints = knowledge });
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            if (!Current(review)) return;
            if (error is BindingExpiredException) { _workshop.Suspend(); return; }
            var message = error is OperationCanceledException ? "本次点评已超时，请继续展示后重新开始。"
                : error is HttpRequestException ? "暂时无法连接学校服务，请检查网络后重试。"
                : error is JsonException or KeyNotFoundException ? "点评结果格式无效，请继续展示后重新点评。" : error.Message;
            await CancelRemoteAsync(review);
            if (Current(review))
            {
                try { await _workshop.CommandAsync("review_state", new { generation = review.PluginGeneration, state = "error", message }, CancellationToken.None); } catch (Exception stateError) when (stateError is not OutOfMemoryException) { }
            }
        }
    }
    private Task State(Review review, object payload)
    {
        if (!Current(review)) return Task.CompletedTask;
        var state = JsonSerializer.SerializeToNode(payload)!.AsObject();
        state["generation"] = review.PluginGeneration;
        return _workshop.CommandAsync("review_state", state, review.Lifetime.Token);
    }

    private static JsonElement ResultFor(Review review, JsonElement response)
    {
        if (!response.TryGetProperty("reviewId", out var id) || id.ValueKind != JsonValueKind.String ||
            !string.Equals(id.GetString(), review.ReviewId, StringComparison.Ordinal))
            throw new InvalidDataException("点评结果不属于本次作答，请继续展示后重新开始。");
        return response.GetProperty("result");
    }

    internal async Task ContinueAsync(long? pluginGeneration = null)
    {
        var generation = pluginGeneration ?? _current?.PluginGeneration;
        Invalidate();
        if (_workshop.IsRunning && generation is not null) await _workshop.CommandAsync("resume", new { generation }, CancellationToken.None);
    }
    internal void Invalidate()
    {
        var old = _current; _current = null; _question = null; ++_generation;
        _windows.Reset();
        if (old is not null) { old.Lifetime.Cancel(); _ = CancelRemoteAsync(old); old.Lifetime.Dispose(); }
    }
    private void EndSession() { _targetId = null; _pluginGeneration = 0; Invalidate(); }
    private static async Task CancelRemoteAsync(Review review)
    {
        if (review.Csrf is null || Interlocked.Exchange(ref review.CancelSent, 1) != 0) return;
        try { using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await Request(review, "/api/banban/math-reviews/cancel", new { requestKey = review.RequestKey }, limit.Token, 8); }
        catch (Exception error) when (error is not OutOfMemoryException) { }
    }

    private static async Task<JsonElement> Request(Review review, string path, object? body, CancellationToken token, int seconds)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(TimeSpan.FromSeconds(seconds));
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, review.Binding.Endpoint.TrimEnd('/') + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", review.Binding.DeviceToken);
        request.Headers.Add("X-ICeClass-Device", review.Binding.DeviceId); request.Headers.Add("X-ICeClass-Class", review.Binding.ClassId);
        if (review.Csrf is not null) request.Headers.Add("X-CSRF-Token", review.Csrf);
        if (body is not null)
        {
            var json = JsonSerializer.SerializeToUtf8Bytes(body);
            if (json.Length > 6 * 1024 * 1024) throw new InvalidDataException("本次双图过大，请调整展示范围后重试。");
            request.Content = new ByteArrayContent(json); request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token);
        await using var stream = await response.Content.ReadAsStreamAsync(limit.Token);
        using var memory = new MemoryStream(); var buffer = new byte[4096]; int read;
        while ((read = await stream.ReadAsync(buffer, limit.Token)) > 0)
        { if (memory.Length + read > 65536) throw new InvalidDataException("点评服务响应过大，请重新开始。"); memory.Write(buffer, 0, read); }
        using var document = JsonDocument.Parse(memory.ToArray());
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new BindingExpiredException();
            var error = document.RootElement.TryGetProperty("error", out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: <= 240 } text
                ? text : response.StatusCode == HttpStatusCode.TooManyRequests ? "本月班班次数已用完。" : "本次点评未完成，请继续展示后重试。";
            throw new InvalidOperationException(error);
        }
        return document.RootElement.Clone();
    }
    private sealed class BindingExpiredException : InvalidOperationException { }
    public void Dispose()
    {
        if (_disposed) return; _disposed = true;
        _workshop.ActionRequested -= ActionRequested; _workshop.ReviewInvalidated -= EndSession; EndSession();
    }
}

using System.Net;
using System.Text;
using System.Text.Json;
using ICeClass.Receiver;

internal static class ClassroomHomeChecks
{
    internal static async Task Run()
    {
        var handler = new CaptureHandler();
        using var client = new HttpClient(handler);
        var api = new ClassroomHomeApi(client);
        var binding = new ReceiverConfig {Endpoint = "http://127.0.0.1:8869", DeviceId = "review-device",
            DeviceToken = "review-token", ClassId = "review-class"};
        var result = await api.SendAsync(binding, "?date=2026-11-04", null, default);
        Check(result.GetProperty("ok").GetBoolean(), "JSON response is returned");
        Check(handler.Uri == "http://127.0.0.1:8869/api/homework/classroom?date=2026-11-04", "request stays on configured service");
        Check(handler.Authorization == "Bearer review-token" && handler.Device == "review-device" && handler.Class == "review-class", "native device authorization is attached");
        using var document = JsonDocument.Parse("""{"classId":"review-class","revision":2,"missing":["student-2"]}""");
        await api.SendAsync(binding, "/records", document.RootElement, default);
        Check(handler.Method == HttpMethod.Put && handler.Body!.Contains("student-2"), "record update preserves payload");
        foreach (var path in new[] {"https://example.com", "/records?redirect=x", "?date=2026-11-04&x=1", "/../teacher", "?date=2026-02-30"})
            await Reject(() => api.SendAsync(binding, path, null, default));
        await Reject(() => api.SendAsync(binding, "/records", null, default));
        await Reject(() => api.SendAsync(binding, "", document.RootElement, default));
        using var otherClass = JsonDocument.Parse("""{"classId":"another-class"}""");
        await Reject(() => api.SendAsync(binding, "/records", otherClass.RootElement, default));
        Check(handler.Count == 2, "invalid and cross-class requests never reach transport");
        handler.Status = HttpStatusCode.Conflict; handler.Response = """{"error":"记录已更新，请重新载入"}""";
        try { await api.SendAsync(binding, "/records", document.RootElement, default); throw new Exception("conflict accepted"); }
        catch (InvalidOperationException error) { Check(error.Message == "记录已更新，请重新载入", "conflict feedback survives bridge"); }
        Console.WriteLine("Classroom home bridge checks passed.");
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Reject(Func<Task<JsonElement>> request)
    {
        try { await request(); } catch (ArgumentException) { return; }
        throw new Exception("Invalid bridge request was accepted.");
    }
    private sealed class CaptureHandler : HttpMessageHandler
    {
        public string? Uri, Authorization, Device, Class, Body;
        public HttpMethod? Method;
        public int Count;
        public HttpStatusCode Status = HttpStatusCode.OK;
        public string Response = "{\"ok\":true}";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Count++; Uri = request.RequestUri!.AbsoluteUri; Method = request.Method;
            Authorization = request.Headers.Authorization?.ToString();
            Device = request.Headers.GetValues("X-ICeClass-Device-Id").Single();
            Class = request.Headers.GetValues("X-ICeClass-Class-Id").Single();
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(Status) {Content = new StringContent(Response, Encoding.UTF8, "application/json")};
        }
    }
}

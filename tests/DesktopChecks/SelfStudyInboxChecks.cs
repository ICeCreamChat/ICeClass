using System.Net;
using System.Text;
using ICeClass.Desktop;

internal static class SelfStudyInboxChecks
{
    internal static async Task Run()
    {
        var assertions = 0;
        void Check(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); assertions++; }
        string? session = "account-one";
        var handler = new Stub();
        using var http = new HttpClient(handler);
        using var inbox = new SelfStudyInbox("http://127.0.0.1:8870", () => Task.FromResult<string?>(session), http);
        await inbox.RefreshAsync(default);
        Check(inbox.Pending.Count == 1, "Unreviewed reported events notify the teacher");
        Check(handler.Cookie == "iceclass_session=account-one", "The active native session is attached");
        Check(handler.Path == "/api/self-study/events?limit=100", "Only metadata is fetched");
        inbox.Dismiss();
        await inbox.RefreshAsync(default);
        Check(inbox.Pending.Count == 0, "Dismissed events do not repeatedly interrupt");
        session = "account-two";
        await inbox.RefreshAsync(default);
        Check(inbox.Pending.Count == 1, "A different teacher has an independent inbox");
        handler.DuringRequest = () => session = null;
        await inbox.RefreshAsync(default);
        Check(inbox.Pending.Count == 0, "A response after logout cannot retain class data");
        handler.DuringRequest = null; session = "account-three"; handler.Status = HttpStatusCode.Forbidden;
        await inbox.RefreshAsync(default);
        Check(inbox.Pending.Count == 0, "Subject teachers and expired accounts cannot receive incidents");
        Console.WriteLine($"Self-study inbox checks passed: {assertions}");
    }
    private sealed class Stub : HttpMessageHandler
    {
        internal string? Cookie, Path;
        internal Action? DuringRequest;
        internal HttpStatusCode Status = HttpStatusCode.OK;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Cookie = request.Headers.GetValues("Cookie").Single(); Path = request.RequestUri!.PathAndQuery;
            DuringRequest?.Invoke();
            return Task.FromResult(new HttpResponseMessage(Status) { Content = new StringContent(
                """{"events":[{"id":"incident-one","class_name":"测试班","status":"reported","handled_at":null}]}""",
                Encoding.UTF8, "application/json") });
        }
    }
}

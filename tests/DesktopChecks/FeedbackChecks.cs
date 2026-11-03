using System.Net;
using System.Net.Http.Json;
using System.Text;
using ICeClass.Desktop;

internal static class FeedbackChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        async Task Reject(Func<Task> action, string part)
        {
            try { await action(); throw new Exception("Expected feedback failure: " + part); }
            catch (Exception error) when (error is InvalidOperationException or InvalidDataException)
            { Assert(error.Message.Contains(part), "Feedback explains the failure: " + part); }
        }
        string? session = null;
        var requests = 0; var posts = 0;
        var raw = ""; var cookie = ""; var csrf = "";
        var responseStatus = HttpStatusCode.Created;
        object responseBody = new { id = Guid.NewGuid().ToString(), status = "sent" };
        using var http = new HttpClient(new Handler(async request =>
        {
            requests++;
            Assert(request.RequestUri!.GetLeftPart(UriPartial.Authority) == "https://school.example", "Feedback credentials stay on the school origin");
            if (request.Method == HttpMethod.Get)
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new
                { authenticated = true, user = new { username = "teacher", displayName = "许老师", csrfToken = "csrf-proof" } }) };
            posts++; raw = await request.Content!.ReadAsStringAsync();
            cookie = request.Headers.GetValues("Cookie").Single(); csrf = request.Headers.GetValues("X-CSRF-Token").Single();
            return new HttpResponseMessage(responseStatus) { Content = JsonContent.Create(responseBody) };
        }));
        using var client = new TeacherFeedbackClient("https://school.example", () => Task.FromResult(session), http);
        await Reject(async () => await client.AccountAsync(default), "请先登录");
        Assert(requests == 0, "Logged-out feedback does not send any data");
        session = "session-A";
        var account = await client.AccountAsync(default);
        Assert(account.Username == "teacher" && account.DisplayName == "许老师", "Feedback uses the authenticated reporter");
        var report = new FeedbackReport("来音无法播放", "", "2.5.1", "Windows", "150%", DateTimeOffset.Now.ToString("O"), "https://school.example/?token=page-private#account");
        var diagnostic = "Cookie: private-cookie\nAuthorization: Bearer private-bearer\npassword=private-password\n{\"api_key\":\"private-api-key\"}\nhttps://user:private-user@school.example/\naccess_token=private-access\n{\"Authorization\":\"Bearer private-json-bearer\"}\n{\"Cookie\":\"private-json-cookie\"}\n";
        var cleaned = FeedbackDiagnostics.Redact(diagnostic);
        Assert(!cleaned.Contains("private-"), "Diagnostic preview hides credentials, cookies, tokens and URL credentials");
        Assert(FeedbackDiagnostics.Page(report.Page) == "https://school.example/#account", "Diagnostic page drops sensitive query parameters");
        Assert(FeedbackDiagnostics.Page("https://user:password@school.example/") == "", "A credential-bearing page is not collected");
        var image = FeedbackImage.Create("bad-path/picture.png", Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPrsAAAAASUVORK5CYII="));
        await client.SendAsync(account, report, diagnostic, [image], default);
        Assert(cookie == "iceclass_session=session-A" && csrf == "csrf-proof", "Submitting feedback includes both login and CSRF proof");
        Assert(raw.Contains("desktop.txt") && raw.Contains("screenshot-1.png") && !raw.Contains("private-") && !raw.Contains("page-private"), "Multipart feedback includes only selected attachments and redacted metadata");
        Assert(raw.Contains("问题描述：来音无法播放") && raw.Contains("反馈人：许老师") && raw.Contains("显示缩放：150%"),
            "The diagnostic attachment remains understandable when forwarded on its own");
        await client.SendAsync(account, report, null, [], default);
        Assert(!raw.Contains("desktop.txt") && !raw.Contains("screenshot-1"), "Opting out removes logs and screenshots from the request");
        var before = posts;
        await Reject(async () => await client.SendAsync(account, report with { Description = "" }, null, [], default), "请填写");
        Assert(posts == before, "An empty report never reaches the server");
        session = "session-B";
        await Reject(async () => await client.SendAsync(account, report, null, [], default), "登录账号已变化");
        Assert(posts == before, "An old account's draft is never sent under a new session");
        session = "session-A";
        responseStatus = HttpStatusCode.ServiceUnavailable; responseBody = new { error = "邮件暂未发送成功" };
        await Reject(async () => await client.SendAsync(account, report, null, [], default), "邮件暂未发送成功");
        responseStatus = HttpStatusCode.Created; responseBody = new { status = "sent", id = "invalid" };
        await Reject(async () => await client.SendAsync(account, report, null, [], default), "未收到发送确认");
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-Feedback-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "settings.json"), "must-not-be-collected");
            File.WriteAllText(Path.Combine(directory, "desktop.log"), new string('x', 300 * 1024) + "\n" + diagnostic + "\nlast entry", Encoding.UTF8);
            var log = FeedbackDiagnostics.Collect(directory);
            Assert(log.Contains("256 KB") && log.Contains("last entry") && !log.Contains("private-") && !log.Contains("must-not-be-collected"), "Collection limits logs to the recent tail and never includes settings files");
            Assert(log.Contains("运行环境") && log.Contains("最近 24 小时") && log.Contains("运行时：") && log.Contains("错误详情"),
                "Diagnostic collection contains environment, activity coverage and error details even without a crash");
        }
        finally { Directory.Delete(directory, true); }
        return checks;
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => handler(request);
    }
}

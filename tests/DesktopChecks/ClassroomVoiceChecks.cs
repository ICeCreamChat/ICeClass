using System.Net;
using System.Net.Http.Json;
using ICeClass.Desktop;

internal static class ClassroomVoiceChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        string? session = null;
        var calls = 0;
        var audioCalls = 0;
        var status = HttpStatusCode.OK;
        var audio = new byte[] { 1, 2, 3, 4 };
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        object Message(string id, string name = "高一（1）班", bool played = false) => new
        {
            id, class_id = "class-" + name, class_name = name, audio_duration_ms = 1200,
            created_at = now, played_by_me = played, audio_url = "https://foreign.example/private.wav"
        };
        object[] messages = [Message("first"), Message("played", played: true)];
        using var http = new HttpClient(new Handler(request =>
        {
            calls++;
            Assert(request.RequestUri!.GetLeftPart(UriPartial.Authority) == "https://school.example", "Session stays on the configured school origin");
            Assert(request.Headers.GetValues("Cookie").Single() == "iceclass_session=" + session, "Each request uses the current login session");
            if (request.RequestUri.AbsolutePath.EndsWith("/audio"))
            {
                audioCalls++;
                Assert(request.RequestUri.AbsolutePath == "/api/classroom-voice/second/audio", "Audio path is derived from the message ID, ignoring a supplied foreign URL");
                return new HttpResponseMessage(status) { Content = new ByteArrayContent(audio) };
            }
            Assert(request.RequestUri.AbsolutePath == "/api/classroom-voice" && request.RequestUri.Query == "", "Inbox checks all authorized classes without the current page filter");
            return new HttpResponseMessage(status) { Content = JsonContent.Create(new { messages }) };
        }));
        using var inbox = new ClassroomVoiceInbox("https://school.example", () => Task.FromResult(session), http);
        var changes = 0;
        inbox.Changed += () => changes++;
        await inbox.RefreshAsync(default);
        Assert(calls == 0 && inbox.Pending.Count == 0, "Logged-out workbench does not fetch messages");
        session = "session-A";
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Select(item => item.Id).SequenceEqual(["first"]), "An unread classroom message becomes a desktop reminder");
        Assert(audioCalls == 0, "Receiving a reminder never fetches audio or marks it played");
        var unchanged = changes;
        await inbox.RefreshAsync(default);
        Assert(changes == unchanged && inbox.Pending.Count == 1, "Polling the same message does not repeat a reminder");
        inbox.DismissAll();
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Count == 0 && audioCalls == 0, "Later dismisses the reminder without playing or reannouncing it");
        var accountBefore = inbox.AccountVersion;
        var eventsBefore = changes;
        session = null;
        await inbox.RefreshAsync(default);
        Assert(inbox.AccountVersion != accountBefore && changes > eventsBefore, "Logging out also stops a player whose message has already left the inbox");
        session = "session-A";
        await inbox.RefreshAsync(default);
        inbox.DismissAll();
        messages = [Message("first"), Message("second"), Message("other", "高一（2）班")];
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Select(item => item.Id).SequenceEqual(["second", "other"]), "New arrivals are queued together while dismissed messages stay quiet");
        var second = inbox.Pending[0];
        Assert((await inbox.ReadAudioAsync(second, default)).SequenceEqual(audio), "Listening explicitly loads the selected authorized recording");
        Assert(audioCalls == 1, "Audio is fetched only after the listen action");
        inbox.Dismiss(second.Id);
        messages = [Message("first"), Message("second", played: true)];
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Count == 0, "Played, removed and expired messages leave the pending reminder");
        messages = [Message("second")];
        session = "session-B";
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Single().Id == "second", "A new login gets its own reminder state");
        status = HttpStatusCode.ServiceUnavailable;
        try { await inbox.RefreshAsync(default); throw new Exception("Accepted an unavailable inbox"); }
        catch (HttpRequestException) { checks++; }
        Assert(inbox.Pending.Count == 1, "Temporary connection failure retains the unhandled reminder");
        status = HttpStatusCode.Unauthorized;
        await inbox.RefreshAsync(default);
        Assert(inbox.Pending.Count == 0, "Expired or revoked login clears the old account's reminders");
        session = null;
        var beforeLogout = calls;
        try { await inbox.ReadAudioAsync(second, default); throw new Exception("Played audio after logout"); }
        catch (InvalidOperationException) { checks++; }
        Assert(calls == beforeLogout, "Stale reminders cannot request audio after logout");
        status = HttpStatusCode.OK;
        session = "session-C";
        await inbox.RefreshAsync(default);
        audio = new byte[4 * 1024 * 1024 + 1];
        try { await inbox.ReadAudioAsync(inbox.Pending.Single(), default); throw new Exception("Accepted oversized audio"); }
        catch (InvalidDataException) { checks++; }

        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var delayedHttp = new HttpClient(new AsyncHandler(async _ =>
        {
            started.SetResult();
            await finish.Task;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new { messages = new[] { Message("old-account") } }) };
        }));
        using var delayed = new ClassroomVoiceInbox("https://school.example", () => Task.FromResult<string?>(session), delayedHttp);
        var refresh = delayed.RefreshAsync(default);
        await started.Task;
        session = "session-D";
        finish.SetResult();
        await refresh;
        Assert(delayed.Pending.Count == 0, "A response arriving after an account switch cannot reveal the previous account's messages");
        return checks;
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(send(request));
    }
    private sealed class AsyncHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request);
    }
}

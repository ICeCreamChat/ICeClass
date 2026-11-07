using System.Net;
using System.Net.Sockets;
using System.Text;
using ICeClass.About;

internal static class AcknowledgementClientChecks
{
    internal static async Task Run(string output)
    {
        var checks = 0;
        void Check(bool value, string label) { if (!value) throw new Exception(label); checks++; Console.WriteLine(label); }
        Directory.CreateDirectory(output);
        var cache = Path.Combine(output, "cache-" + Guid.NewGuid().ToString("N"));
        using var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        var endpoint = $"http://127.0.0.1:{port}";
        using var listener = new HttpListener(); listener.Prefixes.Add(endpoint + "/"); listener.Start();
        async Task Respond(string text, int status = 200, bool chunked = false)
        {
            var request = await listener.GetContextAsync();
            Check(request.Request.RawUrl == "/api/about/acknowledgements", "The client reads the public acknowledgement endpoint.");
            Check(request.Request.Headers["Authorization"] is null && request.Request.Headers["Cookie"] is null,
                "Public acknowledgement reads never transmit device or teacher credentials.");
            var bytes = Encoding.UTF8.GetBytes(text);
            request.Response.StatusCode = status; request.Response.ContentType = "application/json";
            request.Response.Headers.Add(HttpResponseHeader.SetCookie, "acknowledgements-test=not-a-session; Path=/");
            if (status == 302) request.Response.RedirectLocation = endpoint + "/unexpected";
            request.Response.SendChunked = chunked;
            if (!chunked) request.Response.ContentLength64 = bytes.Length;
            try { await request.Response.OutputStream.WriteAsync(bytes); }
            catch (Exception error) when (error is IOException or HttpListenerException) { }
            finally { request.Response.Close(); }
        }
        var client = new AboutAcknowledgementsClient(endpoint, cache);
        Check(client.ReadCached().Sections.Select(s => s.Title).SequenceEqual(new[] { "感谢 AI 建模社", "感谢支持与指导", "特别感谢" }),
            "First use displays the sample's bundled groups before a server has been reached.");
        const string body = "{\"revision\":3,\"sections\":[{\"title\":\"新增致谢\",\"body\":\"测试老师甲、测试老师乙\\n测试老师丙\"}]}";
        var server = Respond(body);
        var updated = await client.RefreshAsync(default); await server;
        Check(updated.Revision == 3 && updated.Sections[0].Body == "测试老师甲、测试老师乙\n测试老师丙",
            "Server changes preserve names, order and explicit line breaks.");
        Check(new AboutAcknowledgementsClient(endpoint, cache).ReadCached().Sections[0].Title == "新增致谢",
            "Reopened windows use the last successfully synchronized content offline.");
        Check(new AboutAcknowledgementsClient(endpoint + "/different-platform", cache).ReadCached().Sections.Length == 3,
            "Changing platforms does not reuse another platform's acknowledgements.");
        foreach (var (text, status, chunked) in new[] {
            ("{\"revision\":4,\"sections\":[]}", 200, false),
            ("{\"sections\":[{\"title\":\"missing revision\",\"body\":\"text\"}]}", 200, false),
            ("{\"revision\":4,\"sections\":[{\"title\":null,\"body\":\"text\"}]}", 200, false),
            (new string('x', 40000), 200, true), ("{}", 503, false), ("{}", 302, false) })
        {
            server = Respond(text, status, chunked);
            var rejected = false;
            try { await client.RefreshAsync(default); }
            catch (Exception error) when (error is InvalidDataException or System.Text.Json.JsonException or HttpRequestException) { rejected = true; }
            await server;
            Check(rejected && client.ReadCached().Sections[0].Title == "新增致谢",
                $"Invalid, unavailable, oversized or redirected response ({status}, {text.Length} chars) cannot replace the last good content.");
        }
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        var cancelled = false;
        try { await client.RefreshAsync(cancellation.Token); }
        catch (OperationCanceledException) { cancelled = true; }
        Check(cancelled && client.ReadCached().Revision == 3, "Closing a window cancels refresh without changing the cached content.");
        Console.WriteLine($"{checks} acknowledgement client checks passed.");
    }
}

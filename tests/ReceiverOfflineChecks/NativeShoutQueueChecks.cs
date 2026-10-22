using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeShoutQueueChecks
{
    private const BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
    private static object Field(object target, string name) => target.GetType().GetField(name, Flags)!.GetValue(target)!;
    public static async Task Run(ClassroomIslandService island, CloudReceiverService receiver, ClassroomIslandWindow window,
        Action<bool, string> check, Action<Window, string> capture)
    {
        var events = new List<(ShoutData Data, ShoutCloseReason Reason)>(); var suspensions = new List<ShoutData>();
        Task Queue(ShoutData data, long expiry = 0) => island.QueueAsync(data, reason => events.Add((data, reason)), () => suspensions.Add(data), expiry);
        ShoutData Message(string name, string level = "info", bool preview = false) => new() {
            SenderName = name, Text = "请带好课本与练习册，第三节课开始前到实验室集合。", AlertLevel = level,
            DisplayDurationSec = 30, TtsVolume = 0, IsPreview = preview };
        void Acknowledge() => ((Button)Field(window, "_dismissShout")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        void Escape() => window.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
        async Task Rejected(Task task) { try { await task.WaitAsync(TimeSpan.FromSeconds(3)); throw new Exception("Expected rejection"); } catch (InvalidOperationException) { } catch (OperationCanceledException) { } }

        island.Clear();
        var first = Message("普通第一条"); var second = Message("普通第二条"); var preview = Message("本机演示", preview: true);
        await Queue(first); var secondShown = Queue(second); var previewShown = Queue(preview);
        check(island.IsCurrent(first) && !secondShown.IsCompleted && !previewShown.IsCompleted && island.WaitingShouts == 2,
            "equal-priority messages wait in FIFO order and a local preview waits behind real messages");
        await Task.Delay(1100);
        var warning = Message("重要插入", "warning"); await Queue(warning);
        var interrupted = ((List<QueuedShout>)Field(island, "_waitingShouts")).Single(item => ReferenceEquals(item.Data, first));
        check(island.IsCurrent(warning) && suspensions.SequenceEqual(new[] { first }) && events.Count == 0 && interrupted.Remaining is > 26 and < 29.5,
            "a higher-priority message pauses the interrupted message's remaining visible duration without acknowledging it");
        var urgent = Message("紧急插入", "urgent"); await Queue(urgent); await Task.Delay(750);
        check(island.IsCurrent(urgent) && window.WindowState == WindowState.Normal && window.IsUrgent && window.ClientSize.Height < 170 && suspensions.Count == 2,
            "an emergency immediately preempts important and ordinary messages in the same native window");
        capture(window, "priority-urgent");
        Escape(); await Task.Delay(1100);
        check(events.Contains((urgent, ShoutCloseReason.Dismissed)) && !events.Any(item => item.Reason == ShoutCloseReason.Acknowledged)
            && island.IsCurrent(warning) && window.WindowState == WindowState.Normal && !window.IsUrgent && window.Width <= 560 + IslandShoutCompanion.ExpansionWidth,
            "Escape only dismisses the emergency and resumes the important message in the island");
        Acknowledge(); await Task.Delay(100);
        check(island.IsCurrent(first) && events.Contains((warning, ShoutCloseReason.Acknowledged)),
            "human acknowledgement advances to the interrupted ordinary message before later equal-priority messages");
        Acknowledge(); await secondShown.WaitAsync(TimeSpan.FromSeconds(3));
        check(island.IsCurrent(second), "ordinary messages preserve their original FIFO order after priority interruptions");
        island.CancelPreviewShouts(); await Rejected(previewShown);
        check(island.IsCurrent(second) && island.WaitingShouts == 0,
            "ending a local demo removes its queued samples while preserving the real active notification");
        var expires = Queue(Message("等待过期"), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 50);
        await Task.Delay(1200); await Rejected(expires);
        check(events.Any(item => item.Data.SenderName == "等待过期" && item.Reason == ShoutCloseReason.Expired) && island.IsCurrent(second),
            "a message that expires while waiting is rejected without interrupting the active message");
        island.Clear();
        var urgentPreview = Message("紧急样例", "urgent", true); await Queue(urgentPreview);
        var actual = Message("真实普通通知"); await Queue(actual); island.CancelPreviewShouts(); await Task.Delay(900);
        check(island.IsCurrent(actual) && !window.IsUrgent && island.WaitingShouts == 0,
            "even an urgent preview yields to a real ordinary notification and cannot return after the demo ends");
        var cancelled = Queue(Message("待展示取消")); island.Clear(); await Rejected(cancelled);
        check(events.Any(item => item.Data.SenderName == "待展示取消" && item.Reason == ShoutCloseReason.Cancelled),
            "clearing the presenter completes queued lifecycle callbacks and waiting tasks");

        await CheckUrgentLayout(island, window, check, capture);
        await CheckAudioPreemption(island, receiver, window, check);
        await CheckReceiveLoop(island, receiver, window, check, Acknowledge, Escape);
    }

    private static async Task CheckAudioPreemption(ClassroomIslandService island, CloudReceiverService receiver, ClassroomIslandWindow window, Action<bool, string> check)
    {
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        var config = new ReceiverConfig { Endpoint = $"http://127.0.0.1:{port}", DeviceId = "audio-queue-check", DeviceToken = "local-test-only" };
        async Task<Task?> Display(ShoutData data) => await (Task<Task?>)typeof(CloudReceiverService).GetMethod("DisplayAsync", Flags)!
            .Invoke(receiver, [new ShoutPayload { Data = data }, config, CancellationToken.None])!;
        var voice = new ShoutData { SenderName = "教师原声", Text = "教师语音通知", AlertLevel = "warning", ContentType = "audio", AudioUrl = "/api/shouts/queue-test/audio", AudioDurationMs = 1000, DisplayDurationSec = 30 };
        var request = listener.GetContextAsync();
        var silent = await Display(new ShoutData { SenderName = "普通语音", Text = "教师语音通知", AlertLevel = "info", ContentType = "audio", AudioUrl = "/api/shouts/ordinary/audio", AudioDurationMs = 1000, DisplayDurationSec = 30 });
        await Task.Delay(100);
        check(silent is null && !request.IsCompleted, "ordinary notifications remain silent even when the payload contains a teacher recording");
        island.Clear(); var playback = await Display(voice); var context = await request.WaitAsync(TimeSpan.FromSeconds(3));
        var queuedData = new ShoutData { SenderName = "后到重要", Text = "请带好练习册", AlertLevel = "warning", TtsVolume = 0, DisplayDurationSec = 30 };
        var queued = Display(queuedData); await Task.Delay(150);
        check(!playback!.IsCompleted && !queued.IsCompleted && island.IsCurrent(voice),
            "receiving an equal-priority message leaves the current authenticated voice download running");
        var emergency = new ShoutData { SenderName = "紧急", Text = "请留在座位上，听从老师安排。", AlertLevel = "urgent", TtsVolume = 0, DisplayDurationSec = 30 };
        await Display(emergency);
        var stopped = false; try { await playback.WaitAsync(TimeSpan.FromSeconds(3)); } catch (OperationCanceledException) { stopped = true; }
        context.Response.Abort(); var extraRequest = listener.GetContextAsync();
        check(stopped && island.IsCurrent(emergency), "an emergency cancels the interrupted voice task before taking over presentation");
        window.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape }); await Task.Delay(1000);
        check(island.IsCurrent(voice) && !extraRequest.IsCompleted && !queued.IsCompleted,
            "resuming an interrupted message restores its text without downloading or replaying the same voice again");
        ((Button)Field(window, "_dismissShout")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await queued.WaitAsync(TimeSpan.FromSeconds(3));
        check(island.IsCurrent(queuedData), "finishing the resumed voice message advances to the next important message");
        island.Clear(); listener.Stop();
        try { await extraRequest; } catch (Exception error) when (error is HttpListenerException or ObjectDisposedException) { }
    }

    private static async Task CheckUrgentLayout(ClassroomIslandService island, ClassroomIslandWindow window, Action<bool, string> check, Action<Window, string> capture)
    {
        var local = (IslandLocalSettings)Field(island, "_local");
        foreach (var width in new[] { 380, 560 })
        {
            island.Clear(); local.Appearance = new() { Width = width, Theme = "light" };
            await island.QueueAsync(new() { SenderName = "班主任", Text = "请留在座位上。", AlertLevel = "urgent", DisplayDurationSec = 30 }, _ => { }, () => { });
            await Task.Delay(650);
            var ribbon = (ClassroomIslandRibbon)Field(window, "_ribbon");
            check(window.WindowState == WindowState.Normal && !ribbon.ImportantExpanded && window.ClientSize.Height <= 72 && ribbon.Frame is { Accent: false, Shout.Level: "urgent" },
                "a short urgent message appears immediately in the red thin island at " + width);
            capture(window, "urgent-short-" + width); island.Clear();
            var longText = string.Concat(Enumerable.Repeat("请保持通道畅通，留在座位上，听从老师安排。", 30))[..500];
            await island.QueueAsync(new() { SenderName = new string('师', 80), Text = longText, AlertLevel = "urgent", DisplayDurationSec = 30 }, _ => { }, () => { });
            await Task.Delay(600);
            check(ribbon.ImportantExpanded && window.ClientSize.Height is > 120 and < 170 && window.WindowState == WindowState.Normal,
                "a long urgent message opens two lines within the same red island at " + width);
            capture(window, "urgent-long-" + width);
            ((Button)Field(window, "_expand")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); await Task.Delay(600);
            var body = window.GetVisualDescendants().OfType<TextBlock>().Single(t => t.Text == longText);
            var scroll = body.GetVisualAncestors().OfType<ScrollViewer>().First();
            check(scroll.Extent.Height > scroll.Viewport.Height && window.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible).All(b => {
                var p = b.TranslatePoint(default, window)!.Value; return p.X >= 0 && p.Y >= 0 && p.X + b.Bounds.Width <= window.Bounds.Width + 1 && p.Y + b.Bounds.Height <= window.Bounds.Height + 1; }),
                "all 500 urgent characters remain scrollable with reachable island controls at " + width);
            capture(window, "urgent-full-" + width);
        }
        island.Clear(); local.Appearance = new() { Width = 560, Theme = "light" };
    }

    private static async Task CheckReceiveLoop(ClassroomIslandService island, CloudReceiverService receiver, ClassroomIslandWindow window,
        Action<bool, string> check, Action acknowledge, Action escape)
    {
        var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        using var client = new ClientWebSocket(); using var cancel = new CancellationTokenSource(); using var sendLock = new SemaphoreSlim(1, 1);
        var connecting = client.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/"), cancel.Token);
        var context = await listener.GetContextAsync(); using var server = (await context.AcceptWebSocketAsync(null)).WebSocket; await connecting;
        var config = new ReceiverConfig { Endpoint = $"http://127.0.0.1:{port}", DeviceId = "isolated-receive-test", DeviceToken = "local-test-only" };
        var receive = (Task)typeof(CloudReceiverService).GetMethod("ReceiveAsync", Flags)!.Invoke(receiver, [client, sendLock, config, cancel.Token])!;
        var frames = new List<JsonElement>();
        async Task Send(string id, string level)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var payload = new ShoutPayload { Type = "shout", Version = "1.0", Action = "shout", MessageId = id, Timestamp = now, ExpiresAt = now + 30_000,
                Data = new() { SenderName = id, Text = "请同学们准备好课本。", AlertLevel = level, TtsVolume = 0, DisplayDurationSec = 30 } };
            await server.SendAsync(JsonSerializer.SerializeToUtf8Bytes(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web)), WebSocketMessageType.Text, true, cancel.Token);
        }
        async Task Until(string id, string status)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)); var bytes = new byte[4096];
            while (!frames.Any(f => f.GetProperty("message_id").GetString() == id && f.GetProperty("status").GetString() == status))
            {
                var response = await server.ReceiveAsync(bytes.AsMemory(), timeout.Token);
                using var json = JsonDocument.Parse(bytes.AsMemory(0, response.Count)); frames.Add(json.RootElement.Clone());
            }
        }
        try
        {
            await Send("wire-first", "info"); await Until("wire-first", "displayed");
            await Send("wire-waiting", "info"); await Until("wire-waiting", "received");
            await Send("wire-emergency", "urgent"); await Until("wire-emergency", "displayed");
            check(window.IsUrgent && !frames.Any(f => f.GetProperty("message_id").GetString() == "wire-waiting" && f.GetProperty("status").GetString() == "displayed"),
                "the real websocket receive loop accepts and displays a later emergency while an earlier ordinary message is queued");
            escape(); await Task.Delay(1000); acknowledge(); await Until("wire-first", "acknowledged"); await Until("wire-waiting", "displayed");
            check(!frames.Any(f => f.GetProperty("message_id").GetString() == "wire-emergency" && f.GetProperty("status").GetString() == "acknowledged"),
                "only an explicit acknowledgement sends the human-confirmation websocket receipt; Escape sends none");
            acknowledge(); await Until("wire-waiting", "acknowledged");
        }
        finally
        {
            cancel.Cancel(); client.Abort(); server.Abort(); island.Clear();
            try { await receive; } catch (Exception error) when (error is OperationCanceledException or WebSocketException) { }
        }
    }
}

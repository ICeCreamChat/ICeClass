using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

// Real application heartbeat intervals against isolated loopback sockets. No binding is saved.
internal static class CloudConnectionChecks
{
    internal static void Run() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check()))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check()
    {
        var checks = 0;
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks++; Console.WriteLine("PASS " + label); }
        using var port = new TcpListener(IPAddress.Loopback, 0); port.Start();
        var endpoint = "http://127.0.0.1:" + ((IPEndPoint)port.LocalEndpoint).Port; port.Stop();
        using var listener = new HttpListener(); listener.Prefixes.Add(endpoint + "/"); listener.Start();
        using var lifetime = new CancellationTokenSource();
        var counts = new ConcurrentDictionary<string, int>();
        var sockets = new ConcurrentDictionary<string, WebSocket>();
        var handlers = new ConcurrentBag<Task>();
        var heartbeats = new ConcurrentDictionary<string, int>();
        var acknowledgements = new ConcurrentDictionary<string, int>();
        var server = Task.Run(async () => {
            try {
                while (!lifetime.IsCancellationRequested) {
                    var context = await listener.GetContextAsync().WaitAsync(lifetime.Token);
                    var id = context.Request.QueryString["deviceId"]!;
                    var socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
                    var number = counts.AddOrUpdate(id, 1, (_, count) => count + 1); sockets[id] = socket;
                    handlers.Add(Task.Run(async () => {
                        using (socket) try {
                            var buffer = new byte[16384];
                            while (!lifetime.IsCancellationRequested) {
                                using var message = new MemoryStream(); WebSocketReceiveResult part;
                                do {
                                    part = await socket.ReceiveAsync(buffer, lifetime.Token);
                                    if (part.MessageType == WebSocketMessageType.Close) return;
                                    message.Write(buffer, 0, part.Count);
                                } while (!part.EndOfMessage);
                                using var json = JsonDocument.Parse(message.ToArray());
                                if (json.RootElement.GetProperty("type").GetString() != "heartbeat") continue;
                                heartbeats.AddOrUpdate(id, 1, (_, count) => count + 1);
                                if (id == "silent" && number == 1) continue;
                                await socket.SendAsync("{\"type\":\"heartbeat_ack\"}"u8.ToArray(), WebSocketMessageType.Text, true, lifetime.Token);
                                acknowledgements.AddOrUpdate(id, 1, (_, count) => count + 1);
                            }
                        } catch (Exception error) when (error is OperationCanceledException or WebSocketException or ObjectDisposedException) { }
                    }));
                }
            } catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
        });
        using var speech = new SpeechService();
        var silent = new CloudReceiverService(speech); var healthy = new CloudReceiverService(speech);
        var states = new ConcurrentQueue<ReceiverConnectionState>();
        silent.ConnectionStateChanged += (_, state) => states.Enqueue(state);
        ReceiverConfig Config(string id) => new() { Endpoint = endpoint, DeviceId = id, DeviceToken = "isolated-fixture", ClassId = "fixture", ClassName = "隔离心跳测试" };
        async Task Wait(Func<bool> condition, int seconds = 8) {
            var elapsed = Stopwatch.StartNew();
            while (!condition()) { if (elapsed.Elapsed.TotalSeconds > seconds) throw new TimeoutException("Fixture condition timed out"); await Task.Delay(50); }
        }
        try {
            await silent.StartAsync(Config("silent")); await healthy.StartAsync(Config("healthy"));
            await Wait(() => counts.GetValueOrDefault("silent") == 1 && counts.GetValueOrDefault("healthy") == 1);
            await Wait(() => counts.GetValueOrDefault("silent") >= 2, 67);
            Assert(states.Any(s => !s.Connected && s.Text.Contains("重连")), "Application heartbeat silence reports disconnection and reconnects without a transport close");
            Assert(counts["healthy"] == 1 && heartbeats.GetValueOrDefault("healthy") >= 2, "Healthy idle replies keep one connection for more than a full timeout");
            await Wait(() => acknowledgements.GetValueOrDefault("silent") >= 1, 25);
            Assert(counts["silent"] == 2, "A fresh connection has its own response deadline and accepts heartbeat replies");
            sockets["silent"].Abort(); await Wait(() => counts["silent"] >= 3);
            Assert(counts["silent"] >= 3, "Explicit transport close retains automatic recovery");
            await silent.RestartAsync(Config("rebound")); await Wait(() => counts.GetValueOrDefault("rebound") == 1);
            Assert(states.Last().Connected, "Restart connects the replacement binding without retaining an expired deadline");
            var stopped = Stopwatch.StartNew(); await silent.StopAsync(); await healthy.StopAsync();
            Assert(stopped.Elapsed.TotalSeconds < 3, "Cancellation stops pending receives and heartbeat waits promptly");
            var count = counts.Values.Sum(); await Task.Delay(1500);
            Assert(counts.Values.Sum() == count && !states.Last().Connected, "Stopped clients never reconnect");
            Console.WriteLine($"{checks} cloud connection checks passed.");
        } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally {
            await silent.StopAsync(); await healthy.StopAsync(); lifetime.Cancel();
            foreach (var socket in sockets.Values) socket.Abort(); listener.Close();
            await server; await Task.WhenAll(handlers);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

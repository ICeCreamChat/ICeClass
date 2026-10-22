using System.IO.Pipes;

namespace ICeClass.Receiver;

internal static class InstanceActivation
{
    private static string PipeName => "ICeClass.Receiver.Activate." + Environment.UserName;
    private static readonly CancellationTokenSource Lifetime = new();

    public static void NotifyRunningInstance(bool islandDemo = false, bool shoutPreview = false)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(2500); client.WriteByte(shoutPreview ? (byte)3 : islandDemo ? (byte)2 : (byte)1); client.Flush();
        }
        catch { /* The first instance may still be starting or shutting down. */ }
    }

    public static void Listen(Action showWindow, Action? playIslandDemo = null, Action? previewShout = null)
    {
        _ = Task.Run(async () =>
        {
            while (!Lifetime.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(Lifetime.Token);
                    using var request = CancellationTokenSource.CreateLinkedTokenSource(Lifetime.Token);
                    request.CancelAfter(TimeSpan.FromSeconds(5));
                    var data = new byte[1];
                    if (await server.ReadAsync(data, request.Token) == 1)
                    {
                        if (data[0] == 1) showWindow();
                        else if (data[0] == 2) playIslandDemo?.Invoke();
                        else if (data[0] == 3) previewShout?.Invoke();
                    }
                }
                catch (OperationCanceledException) { }
                catch (IOException) { await Task.Delay(250); }
                catch (Exception error) { AppLog.Error("Listen for desktop activation failed", error); break; }
            }
        });
    }

    public static void Stop() => Lifetime.Cancel();
}

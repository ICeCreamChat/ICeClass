using System.Diagnostics;
using System.IO.Pipes;

namespace ICeClass.Receiver;

internal static class InstanceActivation
{
    internal static string Scope { get; set; } = "";
    private static string PipeName => "ICeClass.Receiver.Activate." + Environment.UserName + Scope;
    private static readonly CancellationTokenSource Lifetime = new();

    // Called on Main's STA thread, which must also release the mutex after the UI exits.
    internal static bool AcquireOrNotify(Mutex instance, bool islandDemo, bool shoutPreview, bool paperClassroom)
    {
        try
        {
            if (instance.WaitOne(0)) return true;
            var elapsed = Stopwatch.StartNew();
            do
            {
                try
                {
                    using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
                    client.Connect(250);
                    client.WriteByte(paperClassroom ? (byte)4 : shoutPreview ? (byte)3 : islandDemo ? (byte)2 : (byte)1);
                    return false;
                }
                catch (Exception error) when (error is TimeoutException or IOException)
                {
                    // A new owner may still be starting its listener, or the old one may be exiting.
                    if (instance.WaitOne(50)) return true;
                }
            } while (elapsed.Elapsed < TimeSpan.FromSeconds(10));
            AppLog.Error("Running receiver did not accept desktop activation within 10 seconds.");
        }
        catch (AbandonedMutexException) { return true; }
        catch (UnauthorizedAccessException error) { AppLog.Error("Desktop activation access denied", error); }
        Environment.ExitCode = 1;
        return false;
    }

    public static void Listen(Action showWindow, Action? playIslandDemo = null, Action? previewShout = null, Action? openPaperClassroom = null)
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
                        else if (data[0] == 4) openPaperClassroom?.Invoke();
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

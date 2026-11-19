using System.IO.Pipes;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public sealed class IceClassPipeClient : IDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly SemaphoreSlim writing = new(1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly TaskCompletionSource finished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Func<JsonElement, Task>? handler;
    private readonly HashSet<string> requestIds = new(StringComparer.Ordinal);
    public CancellationToken Disconnected => lifetime.Token;
    private IceClassPipeClient(NamedPipeClientStream pipe) => this.pipe = pipe;

    public static async Task<IceClassPipeClient> Connect(string pipeName)
    {
        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 200 || pipeName.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '.' and not '-' and not '_'))
            throw new ArgumentException("展台连接名称无效。", nameof(pipeName));
        var stream = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await stream.ConnectAsync(10000).ConfigureAwait(false);
            var client = new IceClassPipeClient(stream);
            await client.Send("hello", new { pluginId = "iceclass.video-booth", processId = Environment.ProcessId }).ConfigureAwait(false);
            _ = client.Receive();
            return client;
        }
        catch { stream.Dispose(); throw; }
    }

    public async Task Send(string type, object payload, string? requestId = null)
    {
        var frame = IceClassProtocol.Encode(type, payload, requestId ?? Guid.NewGuid().ToString("N"));
        await writing.WaitAsync(lifetime.Token).ConfigureAwait(false);
        try { await pipe.WriteAsync(frame, lifetime.Token).ConfigureAwait(false); await pipe.FlushAsync(lifetime.Token).ConfigureAwait(false); }
        catch { lifetime.Cancel(); throw; }
        finally { writing.Release(); }
    }

    public async Task Run(Func<JsonElement, Task> handle, Action disconnected)
    {
        if (Interlocked.CompareExchange(ref handler, handle, null) is not null) throw new InvalidOperationException("展台管道只能绑定一次。");
        await finished.Task.ConfigureAwait(false);
        disconnected();
    }

    private async Task Receive()
    {
        try
        {
            while (!lifetime.IsCancellationRequested && await IceClassProtocol.ReadAsync(pipe, lifetime.Token).ConfigureAwait(false) is { } message)
            {
                var id = message.GetProperty("requestId").GetString()!;
                if (!requestIds.Add(id))
                {
                    await Send("error", new { message = "重复的展台请求。" }, id).ConfigureAwait(false);
                    continue;
                }
                if (Volatile.Read(ref handler) is { } handle) await handle(message).ConfigureAwait(false);
                else if (message.GetProperty("type").GetString() == "exit")
                {
                    await Send("ack", new { }, id).ConfigureAwait(false);
                    lifetime.Cancel();
                    break;
                }
                else await Send("error", new { message = "展台正在启动，请稍后重试。" }, id).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or JsonException or OperationCanceledException or ObjectDisposedException) { }
        finally { lifetime.Cancel(); finished.TrySetResult(); }
    }

    public void Dispose() { lifetime.Cancel(); pipe.Dispose(); /* Pending sends release their own semaphore. */ }
}

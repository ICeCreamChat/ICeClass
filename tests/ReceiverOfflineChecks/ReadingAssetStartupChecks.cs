#if READING_ASSET_STARTUP_CHECKS
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using ICeClass.Receiver;

// Compile the production extractor with the same embedded reading resources.
// A unique test version isolates all file writes from installed client caches.
var output = Path.GetFullPath(args.FirstOrDefault() ?? ".tools/banban-voice-window/reading-assets");
Directory.CreateDirectory(output);
using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(30));
var context = new HeldUiContext();
var pending = new TaskCompletionSource<Task<string>>(TaskCreationOptions.RunContinuationsAsynchronously);
var elapsed = Stopwatch.StartNew();
double initialCallMs = 0;
var ui = new Thread(() =>
{
    SynchronizationContext.SetSynchronizationContext(context);
    var call = Stopwatch.StartNew();
    var task = ReadingLocalAssets.EnsureAsync(lifetime.Token);
    initialCallMs = call.Elapsed.TotalMilliseconds;
    pending.SetResult(task);
});
ui.Start();
var preparation = await pending.Task.WaitAsync(TimeSpan.FromSeconds(15));
ui.Join();
var first = await Task.WhenAny(preparation, context.FirstPost).WaitAsync(TimeSpan.FromSeconds(15));
var independent = ReferenceEquals(first, preparation);
var queuedUiContinuations = context.Count;
Console.WriteLine((independent ? "PASS " : "FAIL ") + "cold resource preparation completes while the UI context is busy");
// Drain only after observing the failure so the original extractor can finish
// and its output integrity can still be checked; no installed data is removed.
while (!preparation.IsCompleted)
{
    while (context.TryRun()) { }
    await Task.Delay(5, lifetime.Token);
}
var folder = await preparation;
var coldMs = elapsed.Elapsed.TotalMilliseconds;
var files = Directory.GetFiles(folder, "*", SearchOption.AllDirectories);
var published = File.Exists(Path.Combine(folder, ".complete")) && File.Exists(Path.Combine(folder, "reading", "index.html"));
Console.WriteLine((published ? "PASS " : "FAIL ") + "all resources are published with a complete reading homepage");
var warm = Stopwatch.StartNew();
var same = await ReadingLocalAssets.EnsureAsync(lifetime.Token) == folder;
var warmMs = warm.Elapsed.TotalMilliseconds;
Console.WriteLine((same ? "PASS " : "FAIL ") + "a warm open reuses the completed cache");
using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
var respectedCancellation = false;
try { await ReadingLocalAssets.EnsureAsync(cancelled.Token); }
catch (OperationCanceledException) { respectedCancellation = true; }
Console.WriteLine((respectedCancellation ? "PASS " : "FAIL ") + "a cancelled startup does not consume or overwrite the cache");
var metrics = new { independent, published, same, respectedCancellation, initialCallMs, coldMs, warmMs,
    queuedUiContinuations, resourceFiles = files.Length, bytes = files.Sum(file => new FileInfo(file).Length), folder };
Console.WriteLine(JsonSerializer.Serialize(metrics));
File.WriteAllText(Path.Combine(output, "metrics.json"), JsonSerializer.Serialize(metrics, new JsonSerializerOptions { WriteIndented = true }));
Environment.ExitCode = independent && published && same && respectedCancellation ? 0 : 1;

internal sealed class HeldUiContext : SynchronizationContext
{
    private readonly ConcurrentQueue<(SendOrPostCallback Callback, object? State)> _queue = new();
    private readonly TaskCompletionSource _firstPost = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task FirstPost => _firstPost.Task;
    public int Count => _queue.Count;
    public override void Post(SendOrPostCallback callback, object? state)
    {
        _queue.Enqueue((callback, state)); _firstPost.TrySetResult();
    }
    public bool TryRun()
    {
        if (!_queue.TryDequeue(out var work)) return false;
        work.Callback(work.State); return true;
    }
}
namespace ICeClass.Receiver
{
    internal static class ReceiverUpdateService
    {
        internal static readonly string CurrentVersionText = "reading-startup-check-" + Guid.NewGuid().ToString("N");
    }
}
#endif

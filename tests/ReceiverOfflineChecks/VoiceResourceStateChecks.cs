using System.Collections.Concurrent;
using System.Reflection;
using ICeClass.Receiver;

internal static class VoiceResourceStateChecks
{
    internal static async Task Run()
    {
        if (VoiceResourceFiles.Resources.Ready) throw new Exception("Missing-resource checks require the isolated core build.");
        using var voice = new BanbanVoiceService(enabled: true);
        var events = new ConcurrentQueue<BanbanVoiceEvent>();
        voice.Changed += events.Enqueue;
        async Task Flush()
        {
            var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            typeof(BanbanVoiceService).GetMethod("Post", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(voice, [new Action(() => complete.SetResult())]);
            await complete.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        var count = 0;
        void ResourceState(string label)
        {
            var state = events.Last(item => item.Kind == "state");
            if (state.State != "resources" || !voice.Status.Contains("语音资源") || voice.Busy)
                throw new Exception(label + ": " + state.State + ": " + voice.Status);
            count++; Console.WriteLine("PASS " + label);
        }
        voice.SetReady(true); await Flush(); ResourceState("enabling voice without models reports resource preparation");
        voice.StartConversation(); await Flush(); ResourceState("starting a conversation without models never reports microphone recovery");
        voice.Standby(); await Flush(); ResourceState("standby without models never promises wake listening");
        typeof(BanbanVoiceService).GetField("_active", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(voice, true);
        voice.Leave(0); await Flush(); ResourceState("leaving a session without models preserves the resource preparation state");
        if (events.Any(item => item.State == "error")) throw new Exception("Missing models emitted a microphone error.");
        Console.WriteLine($"{count} missing voice resource state checks passed.");
    }
}

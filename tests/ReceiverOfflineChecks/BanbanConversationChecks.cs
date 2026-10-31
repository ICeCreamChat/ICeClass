using System.Reflection;
using System.Text.Json;
using ICeClass.Receiver;

internal static class BanbanConversationChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;


    internal static void Run(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        var failures = new List<string>();
        void Check(bool passed, string name)
        {
            checks.Add(new { name, passed });
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) failures.Add(name);
        }
        using var voice = new BanbanVoiceService();
        // Exercise the real idle transition on its owning thread without
        // opening hardware or waiting three minutes in a regression test.
        void OnVoice(Action action)
        {
            var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            typeof(BanbanVoiceService).GetMethod("Post", Private)!.Invoke(voice, [new Action(() => {
                try { action(); complete.SetResult(); } catch (Exception error) { complete.SetException(error); }
            })]);
            complete.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
        }
        void Set(string field, object value) => typeof(BanbanVoiceService).GetField(field, Private)!.SetValue(voice, value);
        bool Active() => (bool)typeof(BanbanVoiceService).GetField("_active", Private)!.GetValue(voice)!;
        void Tick() => typeof(BanbanVoiceService).GetMethod("Tick", Private)!.Invoke(voice, null);
        foreach (var phrase in new[] { "退下吧", "班班，你先离开吧", "斑斑，请先退下吧", "你先休息吧", "再见班班", "结束对话" })
        {
            Check(BanbanVoiceService.Intent(phrase) == "leave", "explicit departure intent: " + phrase);
            Check(BanbanVoiceService.SpeechControl(phrase) == "再见班班", "departure can interrupt playback: " + phrase);
            Check(BanbanVoiceService.SpeechControl(BanbanVoiceService.SpeechText(phrase)) is null,
                "assistant playback cannot dismiss itself: " + phrase);
        }
        foreach (var phrase in new[] { "不要退下吧", "退下吧是什么意思", "如果我说退下吧会怎样", "班班不要离开" })
            Check(BanbanVoiceService.Intent(phrase) == "transcript" && BanbanVoiceService.SpeechControl(phrase) is null,
                "discussion or negation does not dismiss: " + phrase);
        var captured = new List<BanbanSpeechResult>();
        using (var audio = new BanbanLocalAudio(_ => { }, (result, _) => captured.Add(result), _ => { }, error => throw error))
        {
            // Construct the real pipeline without starting microphone capture.
            audio.SetConversation(true, DateTime.MinValue, controlsOnly: true);
            void Recognized(string text, bool final)
            {
                var job = new BanbanSpeechJob(new BanbanSpeechAudio([], final, DuringPlayback: true), 1, true);
                typeof(BanbanLocalAudio).GetMethod("Recognized", Private)!
                    .Invoke(audio, [job, new BanbanSpeechResult(text, final, DuringPlayback: true), 0d]);
            }
            Recognized("退下吧", false);
            Check(captured.Count == 0, "a playback preview cannot turn the beginning of a question into dismissal");
            Recognized("退下吧是什么意思", true);
            Check(captured.Count == 0, "the completed discussion question never becomes a departure control");
            Recognized("退下吧", true);
            Check(captured.Count == 1 && captured[0].Text == "再见班班" && captured[0].Final,
                "a completed explicit departure still crosses the playback control boundary");
        }
        var events = new List<BanbanVoiceEvent>();
        voice.Changed += events.Add;
        OnVoice(() => {
            Set("_enabled", true); Set("_ready", true); Set("_active", true); Set("_speaking", true);
            typeof(BanbanVoiceService).GetMethod("Heard", Private)!.Invoke(voice, ["退下吧", "speech-control"]);
            Check(!Active() && voice.Enabled && voice.Status.Contains("等候") && events.Any(e => e.Kind == "leave")
                && !events.Any(e => e.Kind == "transcript"), "spoken departure stops the session while preserving wake standby");
            Set("_enabled", false); Set("_ready", false); Set("_active", false); Set("_speaking", false);
        });
        long previousConversation = 0, currentConversation = 0;
        OnVoice(() => {
            Set("_enabled", true); Set("_ready", true);
            var begin = typeof(BanbanVoiceService).GetMethod("BeginConversation", Private)!;
            begin.Invoke(voice, ["第一轮", false]); previousConversation = events.Last(e => e.Kind == "wake").Conversation;
            begin.Invoke(voice, ["重新唤醒", false]); currentConversation = events.Last(e => e.Kind == "wake").Conversation;
        });
        voice.Leave(previousConversation);
        OnVoice(() => Check(Active() && currentConversation != previousConversation,
            "a delayed bridge dismissal cannot stop a newer native conversation"));
        voice.Leave(currentConversation);
        OnVoice(() => {
            Check(!Active() && events.Last(e => e.Kind == "leave").Conversation == currentConversation,
                "a current bridge dismissal emits the same conversation identity");
            Set("_enabled", false); Set("_ready", false);
        });
        OnVoice(() => {
            Set("_active", true);
            Set("_lastActivity", DateTime.UtcNow.AddSeconds(-100));
            Tick();
            Check(Active(), "native conversation still accepts follow-ups after 100 seconds of silence");
            Set("_active", true);
            Set("_lastActivity", DateTime.UtcNow.AddSeconds(-179));
            Tick();
            Check(Active(), "native conversation remains open until its three-minute idle wait expires");
            Set("_lastActivity", DateTime.UtcNow.AddSeconds(-181));
            Tick();
            Check(!Active() && voice.Status.Contains("等候"), "three minutes of silence returns to wake standby");
            Set("_active", true); Set("_workState", "thinking");
            Tick();
            Check(Active(), "waiting for a task response does not consume the conversation idle wait");
            Set("_workState", "listening"); Set("_speaking", true);
            Tick();
            Check(Active(), "playing an answer does not consume the conversation idle wait");
            Set("_active", false); Set("_speaking", false);
        });
        File.WriteAllText(Path.Combine(output, "conversation-checks.json"), JsonSerializer.Serialize(checks, new JsonSerializerOptions { WriteIndented = true }));
        if (failures.Count > 0) throw new InvalidOperationException(string.Join("\n", failures));
    }
}

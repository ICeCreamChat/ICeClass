using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ICeClass.Receiver;

internal sealed record BanbanVoiceEvent(string Kind, string Text = "", string State = "", bool Enabled = false, int Level = 0);

/// <summary>Local neural wake, recognition and speech. Microphone audio stays on this computer.</summary>
internal sealed class BanbanVoiceService : IDisposable
{
    internal static readonly string[] WakeWords = ["你好班班", "你好斑斑", "你好班伴", "班班你好"];
    private static readonly string[] Names = ["班班", "斑斑", "班伴", "斑班"];
    private static readonly string[] InterruptPhrases = ["停一下", "停止播报", "别说了", "等一下", "先停一下", "暂停播报", "别念了"];
    private readonly BlockingCollection<Action> _queue = new();
    private readonly Thread _thread;
    private readonly Timer _timer;
    private BanbanLocalAudio? _audio;
    private BanbanSpeechPlayer? _speaker;
    private long _speechGeneration;
    private string _streamId = "";
    private int _streamSequence;
    private bool _streamEnded;
    private readonly HashSet<string> _blockedStreams = [];
    private bool _bargeUtterance;
    private bool _enabled, _ready, _active, _speaking, _disposed;
    private string _workState = "listening", _lastText = "";
    private DateTime _lastActivity = DateTime.UtcNow, _lastHeard, _ignoreUntil, _retryAfter, _speechRetryAfter, _speechProgress;
    internal event Action<BanbanVoiceEvent>? Changed;
    internal event Action<BanbanSpeechResult>? Recognition;
    internal event Action<BanbanAudioObservation>? AudioObservation;
    internal bool Enabled => _enabled;
    internal string Microphone => _audio?.Microphone ?? "";
    internal bool EchoCancellation => _audio?.EchoCancellation == true;
    internal bool NaturalInterruption => _audio?.NaturalInterruption == true;
    internal bool NeuralVoiceReady => _speaker?.Ready == true;
    internal string Status { get; private set; } = "语音已关闭";

    internal BanbanVoiceService(bool enabled = false)
    {
        _enabled = enabled;
        _thread = new Thread(Run) { IsBackground = true, Name = "ICeClass.BanbanVoice" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _timer = new Timer(_ => Post(Tick), null, 1000, 1000);
    }

    internal static string Normalize(string text) => new string(text.Where(c => !char.IsWhiteSpace(c) && !char.IsPunctuation(c) && !char.IsSymbol(c)).ToArray()).ToLowerInvariant();
    internal static bool HasUnrecognizedSpeech(string text) => Regex.IsMatch(text,
        @"(?:<|\[)\s*(?:unk|unknown)\s*(?:>|\])|\uFFFD", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    internal static string? WakeRemainder(string text)
    {
        var normalized = Normalize(text);
        foreach (var wake in WakeWords)
            if (normalized.StartsWith(wake, StringComparison.Ordinal))
            {
                var count = 0; var position = 0;
                foreach (var character in text)
                {
                    position++; if (!char.IsWhiteSpace(character) && !char.IsPunctuation(character) && !char.IsSymbol(character)) count++;
                    if (count == wake.Length) break;
                }
                return text[position..].TrimStart(' ', '，', ',', '。', '！', '!', '：', ':');
            }
        return null;
    }
    internal static string Intent(string text)
    {
        var value = Normalize(text);
        foreach (var name in Names)
        {
            if (value.StartsWith(name, StringComparison.Ordinal)) value = "班班" + value[name.Length..];
            else if (value == "再见" + name) value = "再见班班";
        }
        if (value is "班班取消操作" or "取消操作" or "先别做了" or "算了" or "取消刚才的操作") return "cancel";
        if (InterruptPhrases.Any(phrase => value == phrase || value == "班班" + phrase)) return "interrupt";
        if (value is "再见班班" or "班班再见" or "结束对话") return "leave";
        return "transcript";
    }

    // Only these reversible controls may cross the speaking boundary. Match
    // suffixes because the local ASR stream may already contain speaker echo.
    internal static string? SpeechControl(string text)
    {
        if (HasUnrecognizedSpeech(text)) return null;
        var value = Normalize(text);
        foreach (var name in Names)
        {
            if (value.EndsWith(name + "听一下", StringComparison.Ordinal)
                || InterruptPhrases.Any(phrase => value.EndsWith(name + phrase, StringComparison.Ordinal))) return "班班停一下";
            if (value.EndsWith(name + "取消操作", StringComparison.Ordinal)) return "班班取消操作";
            if (value.EndsWith("再见" + name, StringComparison.Ordinal) || value.EndsWith(name + "再见", StringComparison.Ordinal)) return "再见班班";
        }
        if (InterruptPhrases.Any(phrase => value.EndsWith(phrase, StringComparison.Ordinal))) return "班班停一下";
        return null;
    }

    internal static string SpeechText(string text)
    {
        string Replace(string value, string phrase, string replacement) => Regex.Replace(value,
            string.Join(@"[\s\p{P}\p{S}]*", phrase.Select(c => Regex.Escape(c.ToString()))), replacement);
        foreach (var wake in WakeWords) text = Replace(text, wake, "唤醒词");
        foreach (var name in Names)
        {
            foreach (var suffix in new[] { "停一下", "听一下", "停止播报" }) text = Replace(text, name + suffix, "停止播报");
            text = Replace(text, name + "取消操作", "取消");
            foreach (var phrase in new[] { "再见" + name, name + "再见" }) text = Replace(text, phrase, "结束对话");
        }
        // A teacher can say these short interruptions during playback. Do not
        // play the same words into the microphone ourselves.
        foreach (var phrase in InterruptPhrases) text = Replace(text, phrase, "暂缓播报");
        return text[..Math.Min(text.Length, 1000)];
    }

    internal void SetReady(bool ready) => Post(() =>
    {
        _ready = ready;
        if (!ready) { StopEngine(); State(_enabled ? "login" : "off", _enabled ? "登录教师账号后启用语音" : "语音已关闭"); }
        else EnsureEngine();
    });
    internal void SetEnabled(bool enabled) => Post(() =>
    {
        _enabled = enabled;
        if (!enabled) { StopEngine(); State("off", "语音已关闭"); }
        else EnsureEngine();
    });
    internal void StartConversation() => Post(() =>
    {
        if (!_enabled || !_ready) return;
        EnsureEngine();
        if (_audio is null) return;
        _lastText = "";
        BeginConversation("");
    });
    internal void CancelTask() => Post(() =>
    {
        StopSpeech(); _audio?.DiscardUtterance(); _workState = "listening"; _lastActivity = DateTime.UtcNow;
        if (_enabled && _ready && _active) { UpdateListening(); State("listening", "您说，我在听"); }
        Emit("cancel");
    });
    internal void SetWorkState(string state) => Post(() =>
    {
        if (!_enabled || !_active) return;
        _workState = state is "thinking" or "confirming" ? state : "listening";
        _lastActivity = DateTime.UtcNow;
        if (!_speaking) State(_workState, StateText(_workState));
    });
    internal void Speak(string text) => Post(() => SpeakCore(text));
    internal void SpeechSegment(string id, int sequence, string text, bool end) => Post(() =>
    {
        if (!_enabled || !_ready || !_active || !Regex.IsMatch(id, "^[a-f0-9]{32}$") || _blockedStreams.Contains(id)) return;
        if (_streamId != id)
        {
            if (sequence != 0) return;
            StopSpeech(); _streamId = id; _streamSequence = 0; _streamEnded = false;
            if (!BeginSpeech()) { StopSpeech(); return; }
        }
        if (_streamEnded) return;
        if (sequence < _streamSequence) return;
        if (sequence != _streamSequence++) { StopSpeech(); State(_workState, StateText(_workState)); return; }
        _streamEnded = end; _speechProgress = DateTime.UtcNow;
        _speaker!.Enqueue(SpeechText(text), end);
    });
    internal void StopSpeaking() => Post(() => { StopSpeech(); _audio?.DiscardUtterance(); if (_active) State(_workState, StateText(_workState)); });
    internal void Standby() => Post(() => { StopSpeech(); _active = false; _workState = "listening"; UpdateListening(); State(_enabled && _ready ? "standby" : "off", _enabled && _ready ? "等候“你好班班”" : "语音已关闭"); });

    private void Post(Action action)
    {
        if (_disposed) return;
        try { _queue.Add(action); } catch (InvalidOperationException) { }
    }
    private void Run()
    {
        foreach (var action in _queue.GetConsumingEnumerable())
        {
            try { action(); }
            catch (Exception error)
            {
                AppLog.Error("Banban local voice failed", error);
                StopEngine(); _retryAfter = DateTime.UtcNow.AddSeconds(15);
                State("error", "本机语音未能启动，请检查麦克风后重新开启。");
            }
        }
        StopEngine();
    }

    private void EnsureEngine()
    {
        if (!_enabled) { State("off", "语音已关闭"); return; }
        if (!_ready) { State("login", "登录教师账号后启用语音"); return; }
        if (_audio is not null || DateTime.UtcNow < _retryAfter) return;
        State("connecting", "正在准备本机语音…");
        BanbanLocalAudio? audio = null;
        audio = new BanbanLocalAudio(
            keyword => Post(() => { if (ReferenceEquals(audio, _audio)) Heard(keyword, "keyword"); }),
            (result, generation) => Post(() =>
            {
                if (!ReferenceEquals(audio, _audio) || !audio!.IsCurrent(generation) || !_active) return;
                if (_speaking)
                {
                    var control = SpeechControl(result.Text);
                    if (control is not null) Heard(control, "speech-control");
                    return;
                }
                Recognized(result);
            }),
            level => Post(() => { if (ReferenceEquals(audio, _audio) && _enabled && _ready) Changed?.Invoke(new("audio-level", Enabled: true, Level: level)); }),
            error => Post(() => {
                if (!ReferenceEquals(audio, _audio)) return;
                AppLog.Error("Banban microphone capture failed", error);
                StopEngine(); _retryAfter = DateTime.UtcNow.AddSeconds(5);
                State("error", "麦克风输入已中断，正在重新连接…");
            }), observation => AudioObservation?.Invoke(observation), (generation, result) => Post(() =>
            {
                if (!ReferenceEquals(audio, _audio) || !audio!.IsCurrent(generation) || !_active || !audio.NaturalInterruption) return;
                _bargeUtterance = true;
                if (_speaking) StopSpeech(preserveUtterance: true);
                _lastActivity = DateTime.UtcNow; State("listening", "您说，我在听"); Emit("barge-in");
                // An endpoint may arrive before the UI thread processes promotion.
                // Preserve that completed result as well as partial acoustic context.
                Recognized(result);
            }));
        _audio = audio;
        audio.Start();
        EnsureSpeaker();
        _active = false; State("standby", "等候“你好班班”");
    }

    private void Recognized(BanbanSpeechResult result)
    {
        Recognition?.Invoke(result);
        if (!result.Final) { Emit("partial", HasUnrecognizedSpeech(result.Text) ? "" : result.Text); return; }
        Emit("partial");
        if (result.Unrecognized) { _bargeUtterance = false; AskToRepeat(); return; }
        var source = result.DuringPlayback || _bargeUtterance ? "barge-in" : "local-asr"; _bargeUtterance = false;
        if (!string.IsNullOrWhiteSpace(result.Text)) Heard(result.Text, source);
    }

    private void Heard(string text, string source)
    {
        if (!_enabled || !_ready || DateTime.UtcNow < _ignoreUntil) return;
        var value = Normalize(text);
        if (value.Length == 0 || value == _lastText && (DateTime.UtcNow - _lastHeard).TotalSeconds < 1.2) return;
        _lastText = value; _lastHeard = DateTime.UtcNow;
        var remainder = WakeRemainder(text);
        if (remainder is not null)
        {
            BeginConversation(remainder);
            return;
        }
        if (!_active) return;
        if (source == "barge-in" && Normalize(text) is "确认执行" or "确认这项操作")
        {
            State("confirming", "请在播报停止后再次确认"); return;
        }
        // Ordinary requests are accepted only after AEC/VAD has promoted the
        // recognizer into listening. Consent captured during promotion is rejected.
        if (_speaking && source is not ("keyword" or "speech-control")) return;
        if (HasUnrecognizedSpeech(text)) { AskToRepeat(); return; }
        var intent = Intent(text);
        _lastActivity = DateTime.UtcNow;
        StopSpeech();
        if (intent == "leave")
        {
            _active = false; UpdateListening(); State("standby", "等候“你好班班”"); Emit("leave"); return;
        }
        if (intent == "interrupt") { _audio?.DiscardUtterance(); _workState = "listening"; State("listening", "您说，我在听"); Emit("interrupt"); return; }
        if (intent == "cancel") { _audio?.DiscardUtterance(); _workState = "listening"; State("listening", "正在停止…"); Emit("cancel"); return; }
        State("thinking", "正在处理…"); Emit("transcript", text.Trim()[..Math.Min(text.Trim().Length, 2000)]);
    }

    private void BeginConversation(string remainder)
    {
        _audio?.DiscardUtterance();
        StopSpeech(); _active = true; _lastActivity = DateTime.UtcNow; _workState = "listening";
        UpdateListening(); Emit("wake");
        if (HasUnrecognizedSpeech(remainder)) AskToRepeat();
        else if (remainder.Length == 0) SpeakCore("我在，请说。");
        else { State("thinking", "正在处理…"); Emit("transcript", remainder); }
    }

    private void AskToRepeat()
    {
        _lastActivity = DateTime.UtcNow;
        Emit("partial"); Emit("unrecognized");
        // Keep any pending task and its confirmation state. Missing words must
        // never be stripped out and turned into a different executable request.
        SpeakCore(_workState == "confirming" ? "没听清，请重新说。待确认操作还未执行。" : "没听清，请完整再说一遍。");
    }

    private void SpeakCore(string text)
    {
        if (!_enabled || !_ready || !_active || string.IsNullOrWhiteSpace(text)) return;
        StopSpeech();
        if (!BeginSpeech()) return;
        _speaker!.Enqueue(SpeechText(text), true);
    }
    private bool EnsureSpeaker()
    {
        if (DateTime.UtcNow < _speechRetryAfter) return false;
        if (_speaker is null)
        {
            BanbanSpeechPlayer? player = null;
            player = new BanbanSpeechPlayer(generation => Post(() =>
            {
                if (!ReferenceEquals(player, _speaker) || generation != _speechGeneration) return;
                _speaking = false; _lastActivity = DateTime.UtcNow;
                BlockStream();
                // A user may start just before the last syllable finishes.
                // With AEC, carry that utterance through instead of clipping it.
                var preserve = _audio?.NaturalInterruption == true;
                _ignoreUntil = preserve ? DateTime.MinValue : DateTime.UtcNow.AddMilliseconds(250);
                UpdateListening(preserveUtterance: preserve);
                State(_workState, StateText(_workState));
            }), (generation, text) => {
                if (!ReferenceEquals(player, _speaker) || generation != _speechGeneration) return;
                _audio?.SetPlaybackText(text);
                Post(() =>
                {
                    if (!ReferenceEquals(player, _speaker) || generation != _speechGeneration) return;
                    _speechProgress = DateTime.UtcNow; Emit("caption", text);
                });
            },
            error => Post(() =>
            {
                if (!ReferenceEquals(player, _speaker)) return;
                AppLog.Error("Banban neural speech failed", error); StopSpeech();
                _speaker = null; player!.Dispose(); _speechRetryAfter = DateTime.UtcNow.AddSeconds(15);
                State(_workState, "自然语音暂不可用，文字结果已保留");
            }));
            _speaker = player;
        }
        return true;
    }
    private bool BeginSpeech()
    {
        if (!EnsureSpeaker()) { State(_workState, "自然语音正在恢复，文字结果已保留"); return false; }
        _speechGeneration = _speaker!.Generation; _speechProgress = DateTime.UtcNow;
        _speaking = true; UpdateListening(); State("speaking", "班班正在说…");
        return true;
    }

    private void BlockStream()
    {
        if (_streamId.Length == 0) return;
        if (_blockedStreams.Count >= 64) _blockedStreams.Clear();
        _blockedStreams.Add(_streamId); _streamId = "";
    }

    private void StopSpeech(bool preserveUtterance = false)
    {
        BlockStream();
        if (!preserveUtterance) _bargeUtterance = false;
        if (_speaking) _ignoreUntil = preserveUtterance ? DateTime.MinValue : DateTime.UtcNow.AddMilliseconds(250);
        _speaking = false; _speaker?.Stop();
        _audio?.SetConversation(_active, _ignoreUntil, controlsOnly: false, preserveUtterance: preserveUtterance);
    }
    private void UpdateListening(bool preserveUtterance = false)
    {
        _audio?.SetConversation(_active, _ignoreUntil, controlsOnly: _speaking, preserveUtterance: preserveUtterance);
        if (!_active || _speaking) Emit("partial");
    }
    private void StopEngine()
    {
        var audio = _audio; _audio = null;
        _active = false;
        audio?.Dispose();
        StopSpeech();
        _speaker?.Dispose(); _speaker = null;
    }
    private void Tick()
    {
        if (_enabled && _ready && _audio is null) { EnsureEngine(); return; }
        if (_enabled && _ready && _audio is not null)
        {
            if (_audio.AudioDevicesChanged())
            {
                Emit("audio-device-changed"); StopEngine(); EnsureEngine(); return;
            }
            if (_speaker is null) EnsureSpeaker();
            if (_speaking && (DateTime.UtcNow - _speechProgress).TotalSeconds > 45)
            {
                StopSpeech(); State(_workState, "播报已停止，文字结果已保留");
            }
        }
        if (!_active || _speaking || _workState == "thinking") return;
        if ((DateTime.UtcNow - _lastActivity).TotalSeconds < 90) return;
        StopSpeech(); _active = false; UpdateListening(); State("standby", "等候“你好班班”"); Emit("idle");
    }
    private static string StateText(string state) => state switch { "thinking" => "正在处理…", "confirming" => "等您确认", _ => "您说，我在听" };
    private void State(string state, string text) { Status = text; Changed?.Invoke(new("state", text, state, _enabled)); }
    private void Emit(string kind, string text = "") => Changed?.Invoke(new(kind, text, Enabled: _enabled));
    public void Dispose()
    {
        if (_disposed) return;
        _timer.Dispose(); _disposed = true; _queue.CompleteAdding();
        if (Thread.CurrentThread != _thread) _thread.Join(TimeSpan.FromSeconds(3));
    }
}

internal static class BanbanVoicePreferences
{
    private static string PathName => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "banban-voice.json");
    internal static bool Load()
    {
        try { return JsonSerializer.Deserialize<Preference>(File.ReadAllText(PathName))?.Enabled == true; }
        catch { return false; }
    }
    internal static void Save(bool enabled)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathName)!);
        var temporary = PathName + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(new Preference(enabled)), new UTF8Encoding(false));
        File.Move(temporary, PathName, true);
    }
    private sealed record Preference(bool Enabled);
}

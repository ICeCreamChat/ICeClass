using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Avalonia.Threading;
using Microsoft.Win32;

namespace ICeClass.Receiver;

/// <summary>Owns the microphone only during a fresh, authorized effective timetable session.</summary>
internal sealed class SelfStudyMonitor : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(25) };
    private static readonly SemaphoreSlim DecodeGate = new(1, 1);
    private readonly Func<CancellationToken, Task<bool>> _remind;
    private readonly Func<bool> _busy;
    private readonly Action _cancelWarning;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly SelfStudyCandidateBuffer _buffer = new();
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource _sessionLife = new();
    private ReceiverConfig? _binding;
    private SelfStudySnapshot? _snapshot;
    private SelfStudyAudio? _audio;
    private long _syncedAt, _nextSync, _lastStatus, _lastSpeech, _nextReview, _retryAfter;
    private string _scope = "", _session = "", _paused = "", _event = "";
    private string _eventAttention = "";
    private string _state = "inactive", _detail = "正在同步晚自习设置";
    private int _generation, _syncGeneration = -1;
    private bool _reviewing, _locked, _suspended, _disposed, _quietPending;
    private bool _analysisEnabled;
    private long _aiRetryAfter, _voiceSince, _lastVoiceAt, _stateAt;
    private int _meterQueued;
    private SelfStudySound _latestSound = new(0, false);
    private SelfStudyFeedback? _publishedFeedback;
    private SelfStudyPeriod? _period;
    internal event Action<string, string>? StateChanged;
    internal event Action<SelfStudyFeedback?>? FeedbackChanged;
    internal event Action<double>? SoundLevelChanged;
    private long Now => _snapshot is null ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        : _snapshot.ServerTime + Environment.TickCount64 - _syncedAt;
    internal SelfStudyMonitor(Func<CancellationToken, Task<bool>> remind, Func<bool> busy, Action cancelWarning)
    {
        _remind = remind; _busy = busy; _cancelWarning = cancelWarning;
        _timer.Tick += (_, _) => Tick();
        SystemEvents.SessionSwitch += SessionChanged;
        SystemEvents.PowerModeChanged += PowerChanged;
        _timer.Start();
    }
    internal void SetBinding(ReceiverConfig config)
    {
        var scope = config.Endpoint + "\n" + config.ClassId + "\n" + config.DeviceId + "\n" + config.DeviceToken;
        if (_scope == scope) return;
        _period = null;
        StopAudio(); _generation++; _scope = scope; _snapshot = null; _session = ""; _paused = "";
        _aiRetryAfter = _retryAfter = 0;
        _binding = new() { Endpoint = config.Endpoint, ClassId = config.ClassId, DeviceId = config.DeviceId,
            DeviceToken = config.DeviceToken };
        _nextSync = 0; Tick();
    }
    internal void Invalidate()
    {
        if (_disposed) return;
        StopAudio(); _snapshot = null; _generation++; _nextSync = 0; Tick();
    }
    internal object View() => new { state = _state, detail = _detail, config = _snapshot?.Config,
        schedule = _snapshot?.Schedule ?? [], usage = _snapshot?.Usage, serverTime = Now,
        inPeriod = _snapshot?.Session(Now) is not null, paused = _session.Length > 0 && _paused == _session };
    internal object Pause()
    {
        _paused = _snapshot?.Session(Now)?.Key ?? "";
        StopAudio(); SetState("paused", "本节已暂停，下次晚自习自动恢复"); return View();
    }
    private void Tick()
    {
        if (_disposed || _binding is null) return;
        var clock = Environment.TickCount64;
        var session = _snapshot?.Session(Now);
        if (_snapshot is not null) _period = session;
        var key = session?.Key ?? "";
        if (_session != key) { StopAudio(); _session = key; _nextReview = 0; }
        if (clock >= _nextSync && _syncGeneration != _generation) _ = SyncAsync();
        string? reason = null;
        if (_locked || _suspended) reason = "电脑已锁定或休眠，监测已停止";
        else if (_snapshot is null || clock - _syncedAt > 70000) reason = "尚未取得有效设置，等待联网同步";
        else if (!_snapshot.Config.Enabled) reason = "班主任尚未启用自习管理";
        else if (session is null) reason = _snapshot.Schedule.Count == 0
            ? "周课表近期没有安排第二节晚自习" : "等待周课表中的第二节晚自习";
        else if (_paused == key) reason = "本节已暂停，下次晚自习自动恢复";
        else if (_busy()) reason = "正在使用语音或早读，晚自习监测暂歇";
        if (reason is not null)
        {
            if (_audio is not null || _reviewing) StopAudio();
            SetState(_paused == key && key.Length > 0 ? "paused"
                : reason.Contains("预算") ? "budget" : "inactive", reason);
        }
        else if (_audio is null && clock >= _retryAfter)
        {
            try
            {
                var generation = _generation;
                var audio = new SelfStudyAudio(
                    segment => Dispatcher.UIThread.Post(() => Segment(segment, generation)),
                    () => Interlocked.Exchange(ref _lastSpeech, Environment.TickCount64),
                    () => Dispatcher.UIThread.Post(() => AudioFailed(generation)),
                    () => Dispatcher.UIThread.Post(() => { if (generation == _generation) { _buffer.Clear(); SoundLevelChanged?.Invoke(0); } }),
                    sound => QueueSound(sound, generation), () => Volatile.Read(ref _analysisEnabled), _snapshot!.Config.Sensitivity);
                _audio = audio; _lastSpeech = clock; audio.Start();
                SetState("listening", "正在感知教室声音，仅对有明确证据的疑似闲聊提醒");
            }
            catch { AudioFailed(_generation); }
        }
        var canAnalyze = reason is null && _snapshot is not null && clock >= _aiRetryAfter &&
            (_reviewing || _snapshot.AiReady && _snapshot.Config.CanReview(_snapshot.Usage));
        if (_analysisEnabled != canAnalyze) { Volatile.Write(ref _analysisEnabled, canAnalyze); _buffer.Clear(); }
        if (reason is null && _audio is not null && !_reviewing)
        {
            if (!canAnalyze)
            {
                var budget = _snapshot!.Config.AiEnabled && _snapshot.AiReady && clock >= _aiRetryAfter &&
                    !_snapshot.Config.CanReview(_snapshot.Usage);
                SetState(budget ? "budget" : "ai_paused", budget
                    ? "今日 AI 复核预算不足；本地声波继续，转写、提醒和上报已暂停"
                    : "AI 复核已暂停；本地声波继续，等待连接恢复或班主任配置");
            }
            else if (_state is "budget" or "ai_paused") SetState("listening", "AI 复核已恢复，继续感知教室声音");
        }
        if (_audio is not null && !_reviewing && _event.Length > 0 &&
            clock - Interlocked.Read(ref _lastSpeech) >= 120000 && !_quietPending)
        { _buffer.Clear(); _ = EndEpisodeAsync(); }
        if (_binding is not null && clock - _lastStatus > 60000) _ = ReportStatusAsync();
        PublishFeedback();
    }
    private void QueueSound(SelfStudySound sound, int generation)
    {
        Volatile.Write(ref _latestSound, sound);
        if (Interlocked.Exchange(ref _meterQueued, 1) != 0) return;
        Dispatcher.UIThread.Post(() =>
        {
            Interlocked.Exchange(ref _meterQueued, 0);
            if (_disposed || generation != _generation || _audio is null) return;
            var latest = Volatile.Read(ref _latestSound);
            SoundLevelChanged?.Invoke(latest.Level);
            var clock = Environment.TickCount64;
            // Normal syllables and brief pauses can fail the energy gate for
            // a few frames. Keep one observation span across gaps below 400 ms.
            if (latest.Speech)
            {
                if (_voiceSince == 0 || clock - _lastVoiceAt >= 400) _voiceSince = clock;
                _lastVoiceAt = clock;
            }
            else if (clock - _lastVoiceAt >= 400) _voiceSince = 0;
            if (!_analysisEnabled || _reviewing || _state is not ("listening" or "observing" or "teaching" or "warning") ||
                _state == "teaching" && clock - _stateAt < 8000) return;
            if (_voiceSince > 0 && clock - _voiceSince >= (_snapshot?.Config.VoiceTriggerMs ?? 600))
                SetState("observing", "检测到持续人声，正在观察；音量不代表闲聊");
            else if (clock - _lastVoiceAt >= 2000) SetState("listening", "正在感知教室声音");
        });
    }
    private async Task SyncAsync()
    {
        var generation = _generation; _syncGeneration = generation; _nextSync = Environment.TickCount64 + 30000;
        var binding = _binding!;
        try
        {
            var data = await SendAsync(binding, "config", null, _lifetime.Token);
            if (_disposed || generation != _generation) return;
            var snapshot = data.Deserialize<SelfStudySnapshot>(Json) ?? throw new JsonException();
            if (snapshot.ClassId != binding.ClassId) throw new InvalidDataException();
            if (_snapshot is not null && (_snapshot.Revision != snapshot.Revision ||
                _snapshot.Session(Now)?.Key != snapshot.Session(snapshot.ServerTime)?.Key))
            { _aiRetryAfter = 0; StopAudio(); }
            _snapshot = snapshot; _syncedAt = Environment.TickCount64;
            _nextSync = _syncedAt + (snapshot.Session(snapshot.ServerTime) is null ? 60000 : 20000);
        }
        catch (OperationCanceledException) { }
        catch { if (generation == _generation) { StopAudio(); _snapshot = null; SetState("error", "同步失败，监测已停止，联网后重新同步"); } }
        finally { if (_syncGeneration == generation) _syncGeneration = -1; }
    }
    private void Segment(BanbanSpeechAudio segment, int generation)
    {
        if (_disposed || generation != _generation || _audio is null || _reviewing || !_analysisEnabled) return;
        // Capture timestamps stay in one monotonic clock domain across config syncs.
        _buffer.Add(segment, segment.EndedAtTicks);
        if (Now < _nextReview) return;
        var candidate = _buffer.Take(Environment.TickCount64, _snapshot?.Config.ObservationSeconds ?? 10);
        if (candidate is not null) _ = ReviewAsync(candidate);
    }
    private async Task ReviewAsync(SelfStudyCandidate candidate)
    {
        var binding = _binding!; var snapshot = _snapshot!; var generation = _generation;
        candidate = candidate.AtServerTime(Now, Environment.TickCount64);
        var token = _sessionLife.Token; _reviewing = true; _nextReview = Now + 90000;
        SetState("analyzing", "正在本地转写并复核当前声音片段");
        try
        {
            var utterances = await Task.Run(() =>
            {
                if (!DecodeGate.Wait(0)) return [];
                try
                {
                    token.ThrowIfCancellationRequested();
                    var folder = BanbanVoiceModels.Extract("ICeClass.Voice.Asr.", "sensevoice-small-int8-2365baea");
                    using var recognizer = new SenseVoiceRecognizer(folder);
                    token.ThrowIfCancellationRequested();
                    return Transcribe(candidate, recognizer.Recognize, token);
                }
                finally { DecodeGate.Release(); }
            }, token);
            if (!Current(generation, token) || utterances.Length < 3) return;
            var result = await SendAsync(binding, "observe", new { id = Guid.NewGuid().ToString("N"),
                revision = snapshot.Revision, candidate.StartAt, candidate.EndAt,
                candidate.Segments, candidate.SpeechMs, candidate.LongestMs, candidate.Level, utterances }, token);
            utterances = [];
            if (!Current(generation, token)) return;
            var action = result.GetProperty("action").GetString();
            _nextReview = Now + (result.TryGetProperty("cooldownSeconds", out var cooldown) ? cooldown.GetInt32() : 90) * 1000;
            if (action == "remind")
            {
                _buffer.Clear();
                _event = result.GetProperty("eventId").GetString()!;
                var shown = await _remind(token);
                if (!Current(generation, token)) return;
                await SendAsync(binding, "events/" + _event + "/receipt", new { shown, revision = snapshot.Revision }, token);
                _buffer.Clear(); _nextReview = Now + snapshot.Config.ReminderWaitSeconds * 1000;
                _eventAttention = shown ? "warning" : "";
                SetState(shown ? "warning" : "observing", shown ? "已提醒，请保持安静" : "浮岛正忙，继续观察");
            }
            else if (action == "report")
            {
                _event = result.GetProperty("eventId").GetString()!;
                _eventAttention = "reported";
                SetState("reported", "持续疑似闲聊已通知班主任，等待核实");
                if (result.TryGetProperty("captureRequested", out var capture) && capture.GetBoolean())
                    await CaptureAsync(binding, _event, generation, token);
            }
            else if (action == "budget") { SetState("budget", "今日 AI 复核预算不足，已暂停"); _nextSync = 0; }
            else if (action == "unavailable") PauseAi("AI 复核暂不可用，本地声波继续；未拍照、未上报");
            else if (action == "inactive") Invalidate();
            else
            {
                var classification = result.TryGetProperty("classification", out var kind) ? kind.GetString() : null;
                if (classification is "teaching" or "study" or "unknown")
                {
                    // Only clear the visual alert. Episode IDs retain their existing
                    // lifetime and are still closed through the server's quiet path.
                    if (_eventAttention != "reported" || classification is "teaching" or "study") _eventAttention = "";
                }
                SetState(classification is "teaching" or "study" ? "teaching" : "observing",
                    result.TryGetProperty("detail", out var detail) ? detail.GetString()! : "继续观察，本次未取得明确闲聊证据");
            }
            _nextSync = 0;
        }
        catch (OperationCanceledException) { }
        catch
        {
            if (generation == _generation)
            {
                if (_state != "reported") PauseAi("本次复核未完成，本地声波继续；转写与新增提醒、上报已暂停");
                _nextSync = 0;
            }
        }
        finally
        {
            if (generation == _generation)
            {
                _reviewing = false;
                if (_state == "analyzing") SetState("listening", "本次未取得完整语义证据，继续感知声音");
                Tick();
            }
        }
    }
    private void PauseAi(string detail)
    {
        _aiRetryAfter = Environment.TickCount64 + 60000;
        Volatile.Write(ref _analysisEnabled, false); _buffer.Clear();
        SetState("ai_paused", detail);
    }
    internal static SelfStudyUtterance[] Transcribe(SelfStudyCandidate candidate, Func<float[], string> recognize,
        CancellationToken token)
    {
        var result = new List<SelfStudyUtterance>();
        var remaining = 120;
        foreach (var clip in candidate.Clips)
        {
            token.ThrowIfCancellationRequested();
            var text = new string(recognize(clip.Samples).Where(c => !char.IsControl(c)).ToArray()).Trim();
            token.ThrowIfCancellationRequested();
            // Truncation can remove a learning cue and change the meaning of the window.
            // Spend the shared limit on complete utterances, otherwise abstain.
            if (text.Length == 0 || text.Length > remaining) return [];
            remaining -= text.Length;
            result.Add(new(clip.StartAt, clip.EndAt, clip.SpeechMs, text));
        }
        return result.ToArray();
    }
    private bool Current(int generation, CancellationToken token) => !_disposed && !token.IsCancellationRequested &&
        generation == _generation && _snapshot?.Session(Now)?.Key == _session &&
        Environment.TickCount64 - _syncedAt <= 70000 && !_locked && !_suspended && !_busy();
    private async Task CaptureAsync(ReceiverConfig binding, string id, int generation, CancellationToken token)
    {
        var path = "events/" + id;
        var claim = await SendAsync(binding, path + "/capture", new { }, token);
        if (!Current(generation, token) || !claim.GetProperty("allowed").GetBoolean()) return;
        string? photo = null;
        try { photo = await SelfStudyCamera.CaptureAsync(token); }
        catch (OperationCanceledException) { return; }
        catch { /* A failed physical attempt is never repeated. */ }
        if (!Current(generation, token)) return;
        await SendAsync(binding, path + "/photo", photo is null ? (object)new { failed = true } : new { image = photo }, token);
    }
    private async Task EndEpisodeAsync()
    {
        _quietPending = true; var generation = _generation;
        try
        {
            await SendAsync(_binding!, "quiet", new { revision = _snapshot!.Revision, eventId = _event }, _sessionLife.Token);
            if (generation == _generation)
            {
                _event = "";
                _eventAttention = "";
                if (_analysisEnabled) SetState("listening", "已恢复安静，继续感知教室声音");
            }
        }
        catch { }
        finally { _quietPending = false; }
    }
    private void AudioFailed(int generation)
    {
        if (_disposed || generation != _generation) return;
        StopAudio(); _retryAfter = Environment.TickCount64 + 60000;
        SetState("error", "麦克风或本地语音资源不可用，请检查教室设置");
    }
    private void SetState(string state, string detail)
    {
        if (_state == state && _detail == detail) { PublishFeedback(); return; }
        var previous = _state;
        var wasRunning = previous is "observing" or "teaching" or "warning" or "reported";
        _state = state; _detail = detail; _ = ReportStatusAsync();
        _stateAt = Environment.TickCount64;
        PublishFeedback();
        // First warnings use the rendered-frame receipt path. Publish only
        // meaningful transitions here, not every classification or idle sync.
        if (state is "reported" or "paused" or "budget"
            || state == "error" && (wasRunning || _snapshot?.Session(Now) is not null)
            || state == "inactive" && wasRunning
            || state == "observing" && previous is "inactive" or "warning" or "reported" or "paused" or "budget" or "error")
            StateChanged?.Invoke(state, detail);
    }
    private void PublishFeedback()
    {
        var feedback = _period is null ? null : new SelfStudyFeedback(_state, _detail, _audio is not null, Alert: _eventAttention)
            { ObservationSeconds = _snapshot?.Config.ObservationSeconds ?? 10 };
        if (_publishedFeedback == feedback) return;
        _publishedFeedback = feedback; FeedbackChanged?.Invoke(feedback);
    }
    private async Task ReportStatusAsync()
    {
        _lastStatus = Environment.TickCount64;
        if (_binding is null) return;
        try { await SendAsync(_binding, "status", new { state = _state, detail = _detail }, _lifetime.Token); }
        catch { }
    }
    private static async Task<JsonElement> SendAsync(ReceiverConfig binding, string path, object? body, CancellationToken token)
    {
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post,
            binding.Endpoint.TrimEnd('/') + "/api/self-study/device/" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.DeviceToken);
        request.Headers.Add("X-ICeClass-Device", binding.DeviceId);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        using var response = await Http.SendAsync(request, token);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
        return json.RootElement.Clone();
    }
    private void StopAudio()
    {
        _cancelWarning();
        if (_event.Length > 0 && _binding is not null && _snapshot is not null)
            _ = EndStoppedEpisodeAsync(_binding, _snapshot.Revision, _event);
        _generation++; _audio?.Dispose(); _audio = null; _buffer.Clear(); _event = ""; _reviewing = false;
        _eventAttention = "";
        Volatile.Write(ref _analysisEnabled, false); _voiceSince = _lastVoiceAt = 0;
        SoundLevelChanged?.Invoke(0);
        _publishedFeedback = _period is null ? null : new("inactive", "声音采集已停止", false);
        FeedbackChanged?.Invoke(_publishedFeedback);
        _sessionLife.Cancel(); _sessionLife.Dispose(); _sessionLife = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
    }
    private async Task EndStoppedEpisodeAsync(ReceiverConfig binding, int revision, string eventId)
    {
        try { await SendAsync(binding, "quiet", new { revision, eventId }, _lifetime.Token); }
        catch { }
    }
    private void SessionChanged(object sender, SessionSwitchEventArgs e) => Dispatcher.UIThread.Post(() =>
    {
        if (_disposed) return;
        if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionLogoff) _locked = true;
        if (e.Reason is SessionSwitchReason.SessionUnlock or SessionSwitchReason.SessionLogon) _locked = false;
        if (_locked) StopAudio(); else Invalidate();
    });
    private void PowerChanged(object sender, PowerModeChangedEventArgs e) => Dispatcher.UIThread.Post(() =>
    {
        if (_disposed) return;
        _suspended = e.Mode == PowerModes.Suspend;
        if (_suspended) StopAudio(); else if (e.Mode == PowerModes.Resume) Invalidate();
    });
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true; _timer.Stop(); StopAudio(); _lifetime.Cancel();
        SystemEvents.SessionSwitch -= SessionChanged; SystemEvents.PowerModeChanged -= PowerChanged;
        _sessionLife.Dispose(); _lifetime.Dispose();
    }
}

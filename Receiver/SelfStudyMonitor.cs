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
    private string _state = "inactive", _detail = "正在同步晚自习设置";
    private int _generation, _syncGeneration = -1;
    private bool _reviewing, _locked, _suspended, _disposed, _quietPending;
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
        StopAudio(); _generation++; _scope = scope; _snapshot = null; _session = ""; _paused = "";
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
        var key = session?.Key ?? "";
        if (_session != key) { StopAudio(); _session = key; _nextReview = 0; }
        if (clock >= _nextSync && _syncGeneration != _generation) _ = SyncAsync();
        string? reason = null;
        if (_locked || _suspended) reason = "电脑已锁定或休眠，监测已停止";
        else if (_snapshot is null || clock - _syncedAt > 70000) reason = "尚未取得有效设置，等待联网同步";
        else if (!_snapshot.Config.Enabled) reason = "班主任尚未启用晚自习管理";
        else if (session is null) reason = _snapshot.Schedule.Count == 0
            ? "周课表近期没有安排第二节晚自习" : "等待周课表中的第二节晚自习";
        else if (_paused == key) reason = "本节已暂停，下次晚自习自动恢复";
        else if (!_snapshot.Config.AiEnabled || !_snapshot.AiReady) reason = "请由班主任启用文字复核并配置 AI 连接";
        // The running review already reserved its budget on the server.
        else if (!_reviewing && !_snapshot.Config.CanReview(_snapshot.Usage)) reason = "今日 AI 用量已达上限";
        else if (_busy()) reason = "正在使用语音或早读，晚自习监测暂歇";
        if (reason is not null)
        {
            if (_audio is not null || _reviewing) StopAudio();
            SetState(_paused == key && key.Length > 0 ? "paused"
                : reason.Contains("上限") ? "budget" : "inactive", reason);
        }
        else if (_audio is null && clock >= _retryAfter)
        {
            try
            {
                var generation = _generation;
                var audio = new SelfStudyAudio(
                    segment => Dispatcher.UIThread.Post(() => Segment(segment, generation)),
                    () => Interlocked.Exchange(ref _lastSpeech, Environment.TickCount64),
                    () => Dispatcher.UIThread.Post(() => AudioFailed(generation)));
                _audio = audio; _lastSpeech = clock; audio.Start();
                SetState("observing", "正在观察，先提醒，持续交谈再通知班主任");
            }
            catch { AudioFailed(_generation); }
        }
        if (_audio is not null && !_reviewing && _event.Length > 0 &&
            clock - Interlocked.Read(ref _lastSpeech) >= 120000 && !_quietPending)
        { _buffer.Clear(); _ = EndEpisodeAsync(); }
        if (_binding is not null && clock - _lastStatus > 60000) _ = ReportStatusAsync();
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
                _snapshot.Session(Now)?.Key != snapshot.Session(snapshot.ServerTime)?.Key)) StopAudio();
            _snapshot = snapshot; _syncedAt = Environment.TickCount64;
            _nextSync = _syncedAt + (snapshot.Session(snapshot.ServerTime) is null ? 60000 : 20000);
        }
        catch (OperationCanceledException) { }
        catch { if (generation == _generation) { StopAudio(); _snapshot = null; SetState("error", "同步失败，监测已停止，联网后重新同步"); } }
        finally { if (_syncGeneration == generation) _syncGeneration = -1; }
    }
    private void Segment(BanbanSpeechAudio segment, int generation)
    {
        if (_disposed || generation != _generation || _audio is null || _reviewing) return;
        if (segment.TooLong) { _buffer.Add(new float[12 * 16000], Now); SetState("teaching", "检测到连续发言，暂按讲题观察"); return; }
        _buffer.Add(segment.Samples, Now);
        if (Now < _nextReview) return;
        var candidate = _buffer.Take(Now);
        if (candidate is not null) _ = ReviewAsync(candidate);
    }
    private async Task ReviewAsync(SelfStudyCandidate candidate)
    {
        var binding = _binding!; var snapshot = _snapshot!; var generation = _generation;
        var token = _sessionLife.Token; _reviewing = true; _nextReview = Now + 90000;
        try
        {
            var text = await Task.Run(() =>
            {
                if (!DecodeGate.Wait(0)) return "";
                try
                {
                    token.ThrowIfCancellationRequested();
                    var folder = BanbanVoiceModels.Extract("ICeClass.Voice.Asr.", "sensevoice-small-int8-2365baea");
                    using var recognizer = new SenseVoiceRecognizer(folder);
                    token.ThrowIfCancellationRequested();
                    return recognizer.Recognize(candidate.Samples);
                }
                finally { DecodeGate.Release(); }
            }, token);
            if (!Current(generation, token) || string.IsNullOrWhiteSpace(text)) return;
            text = new string(text.Where(c => !char.IsControl(c)).Take(120).ToArray());
            var result = await SendAsync(binding, "observe", new { id = Guid.NewGuid().ToString("N"),
                revision = snapshot.Revision, candidate.StartAt, candidate.EndAt,
                candidate.Segments, candidate.SpeechMs, candidate.LongestMs, candidate.Level, text }, token);
            text = "";
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
                _buffer.Clear(); _nextReview = Now + 90000;
                SetState(shown ? "warning" : "observing", shown ? "已提醒，请保持安静" : "浮岛正忙，继续观察");
            }
            else if (action == "report")
            {
                _event = result.GetProperty("eventId").GetString()!;
                SetState("reported", "持续交谈已通知班主任");
                if (result.TryGetProperty("captureRequested", out var capture) && capture.GetBoolean())
                    await CaptureAsync(binding, _event, generation, token);
            }
            else if (action == "budget") { SetState("budget", "今日 AI 用量已达上限"); _nextSync = 0; }
            else if (action == "unavailable") SetState("error", "AI 复核暂不可用，未拍照、未上报");
            else if (action == "inactive") Invalidate();
            else SetState(result.TryGetProperty("classification", out var kind) && kind.GetString() is "teaching" or "study"
                ? "teaching" : "observing", "继续观察，学习问答和不明确的片段不触发上报");
            _nextSync = 0;
        }
        catch (OperationCanceledException) { }
        catch
        {
            if (generation == _generation)
            { SetState("error", "本次复核未完成，未新增拍摄；稍后继续观察"); _nextSync = 0; }
        }
        finally { if (generation == _generation) _reviewing = false; }
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
            if (generation == _generation) { _event = ""; SetState("observing", "已恢复安静，继续观察"); }
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
        if (_state == state && _detail == detail) return;
        _state = state; _detail = detail; _ = ReportStatusAsync();
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

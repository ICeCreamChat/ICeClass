using System.Diagnostics;
using System.Text.Json.Nodes;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ClassroomIslandService : IDisposable, IShoutPresenter
{
    private readonly ClassroomIslandState _state = new();
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly ClassroomIslandWindow _window;
    private ReceiverConfig? _binding;
    private ReadingOfflineService? _offline;
    private ClassroomIslandPreferencesStore? _store;
    private string? _preferencesPath;
    private ClassroomIslandPreferences _preferences = new();
    private ReceiverConnectionState _connection = new(false, "正在连接…");
    private JsonObject? _snapshot;
    private long _snapshotAt;
    private bool _disposed;
    private IslandSyncService? _islandSync;
    private IslandEventLedger? _ledger;
    private IslandLocalSettings _local = new();
    private readonly IslandActionRunner _actions;
    private IslandSettingsWindow? _settingsWindow;
    private IslandDemoPlayback? _demo;
    private IslandDemoWindow? _demoWindow;
    private readonly DispatcherTimer _demoTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
    private DateTimeOffset? _lastTick;
    private long _autoUntil, _manualShowUntil;
    private bool _actionsRunning;
    private readonly Queue<(IslandDueEvent Event, IslandProfile Profile, ReceiverConfig Binding, int Generation)> _pendingActions = new();
    private int _generation;
    private string _bindingScope = "";
    private QueuedShout? _activeShout;
    private readonly List<QueuedShout> _waitingShouts = [];
    private long _shoutOrder;
    internal int WaitingShouts => _waitingShouts.Count;
    public bool IsCurrent(ShoutData data) => ReferenceEquals(_activeShout?.Data, data);
    public bool Enabled => _preferences.Enabled;
    public event Action? PreferenceChanged;
    public event Action? ShoutPreviewRequested;

    public ClassroomIslandService(Func<ReceiverConfig, Task> openReading, Action openHome)
    {
        _actions = new(openReading, Notify);
        _window = new ClassroomIslandWindow(() => _binding is { } binding ? openReading(binding) : Task.CompletedTask,
            openHome, ToggleDim, () => SetEnabled(false), AcknowledgeNotice, ShowSettings, DismissNotice);
        _timer.Tick += (_, _) => { ExpireWaitingShouts(); Refresh(); };
        _demoTimer.Tick += (_, _) => RenderDemo();
        ReadingExperience.StateChanged += ReadingStateChanged;
    }

    public void SetBinding(ReceiverConfig binding)
    {
        if (_disposed) return;
        var scope = ReceiverConfig.NormalizeEndpoint(binding.Endpoint) + "\n" + binding.DeviceId + "\n" + binding.ClassId;
        if (_bindingScope.Length > 0 && _bindingScope != scope) { EndDemo(); CancelShouts(); }
        _bindingScope = scope;
        _binding = binding; _state.SetBinding(binding);
        _generation++; _islandSync?.Dispose(); _islandSync = new(binding); _lastTick = null; _pendingActions.Clear();
        _autoUntil = _manualShowUntil = 0;
        _settingsWindow?.Close(); _settingsWindow = null;
        try { _local = _islandSync.Store.Read<IslandLocalSettings>("local-settings.json") ?? new(); _local.Normalize(); _ledger = new(_islandSync.Store); }
        catch (Exception error) { _local = new(); _ledger = null; _islandSync.Report("本机事件记录异常，自动化暂停，请检查教室端日志"); AppLog.Error("Load island action ledger failed", error); }
        var path = ClassroomIslandPreferencesStore.PathFor(binding);
        if (_preferencesPath != path)
        {
            _preferencesPath = path; _store = new(path); _preferences = _store.Load(); PreferenceChanged?.Invoke();
        }
        _offline = ReadingOfflineService.For(binding);
        _snapshot = null; _snapshotAt = 0;
        Refresh(); _timer.Start();
    }

    public void SetConnection(ReceiverConnectionState connection) { _connection = connection; Refresh(); }
    public Task PresentAsync(ShoutData data, Action<bool> closed)
        => QueueAsync(data, reason => closed(reason is ShoutCloseReason.Acknowledged or ShoutCloseReason.Dismissed), () => { });

    public Task QueueAsync(ShoutData data, Action<ShoutCloseReason> closed, Action suspended, long expiresAt = 0)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        EndDemo();
        ExpireWaitingShouts();
        if (_waitingShouts.Count >= 50) return Task.FromException(new InvalidOperationException("教室待展示消息已满，请稍后重试。"));
        var request = new QueuedShout(data, closed, suspended, expiresAt > 0 ? expiresAt : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 120_000, ++_shoutOrder);
        _waitingShouts.Add(request);
        if (_activeShout is { } active && request.Priority > active.Priority)
        {
            active.Pause(); _activeShout = null;
            InvokeSafely(active.Suspended);
            _waitingShouts.Add(active); _state.DismissNotice();
        }
        StartNextShout(); Refresh(); _timer.Start();
        return request.Shown.Task;
    }

    public void Clear()
    {
        if (_disposed) return;
        CancelShouts(); Refresh();
    }

    public void CancelPreviewShouts()
    {
        if (_disposed) return;
        foreach (var item in _waitingShouts.Where(item => item.Data.IsPreview).ToArray())
        {
            _waitingShouts.Remove(item); item.Shown.TrySetCanceled(); InvokeSafely(() => item.Closed(ShoutCloseReason.Cancelled));
        }
        if (_activeShout?.Data.IsPreview == true) CompleteShout(ShoutCloseReason.Cancelled);
    }

    private void DismissNotice()
    {
        CompleteShout(ShoutCloseReason.Dismissed);
    }

    private void AcknowledgeNotice() => CompleteShout(ShoutCloseReason.Acknowledged);

    private void CompleteShout(ShoutCloseReason reason)
    {
        var active = _activeShout; _activeShout = null;
        _state.DismissNotice(); _autoUntil = 0;
        if (active is not null)
        {
            active.Shown.TrySetException(new InvalidOperationException("这条通知已收起。"));
            InvokeSafely(() => active.Closed(reason));
        }
        StartNextShout(); Refresh();
    }

    private void StartNextShout()
    {
        if (_disposed || _activeShout is not null) return;
        ExpireWaitingShouts();
        var next = _waitingShouts.OrderByDescending(item => item.Priority).ThenBy(item => item.Order).FirstOrDefault();
        if (next is null) { _timer.Interval = TimeSpan.FromSeconds(1); return; }
        _timer.Interval = TimeSpan.FromMilliseconds(100);
        _waitingShouts.Remove(next); _activeShout = next;
        _state.Receive(next.Resume());
        _autoUntil = Stopwatch.GetTimestamp() + (long)(Stopwatch.Frequency * next.Remaining);
        _actions.StopFeedback(); _window.SetExpanded(false);
        _ = ConfirmShoutVisible(next);
    }

    private async Task ConfirmShoutVisible(QueuedShout request)
    {
        // Refresh installs the new view before the next rendered frame.
        await Dispatcher.UIThread.InvokeAsync(() => { }, DispatcherPriority.Loaded);
        if (_activeShout != request) return;
        try { await _window.WaitForShoutAsync(); if (_activeShout == request) request.Shown.TrySetResult(); }
        catch (Exception error)
        {
            if (_activeShout != request) return;
            request.Shown.TrySetException(error); CompleteShout(ShoutCloseReason.Cancelled);
        }
    }

    private void ExpireWaitingShouts()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var item in _waitingShouts.Where(item => item.ExpiresAt <= now || item.Remaining <= 0).ToArray())
        {
            _waitingShouts.Remove(item);
            item.Shown.TrySetException(new InvalidOperationException("通知在等待展示时已过期。"));
            InvokeSafely(() => item.Closed(ShoutCloseReason.Expired));
        }
    }

    private void CancelShouts()
    {
        var requests = _waitingShouts.ToList(); if (_activeShout is { } active) requests.Add(active);
        _waitingShouts.Clear(); _activeShout = null; _state.DismissNotice(); _autoUntil = 0;
        _timer.Interval = TimeSpan.FromSeconds(1);
        foreach (var item in requests)
        {
            item.Shown.TrySetException(new InvalidOperationException("教室绑定或展示已结束。"));
            InvokeSafely(() => item.Closed(ShoutCloseReason.Cancelled));
        }
    }

    private static void InvokeSafely(Action callback)
    {
        try { callback(); }
        catch (Exception error) { AppLog.Error("Update island shout lifecycle failed", error); }
    }

    private void Notify(string title, string text, int seconds)
    {
        if (_disposed || _activeShout is not null) return;
        EndDemo();
        _state.LocalNotice(title, text, seconds);
        _autoUntil = Stopwatch.GetTimestamp() + (long)(Stopwatch.Frequency * seconds);
        Refresh();
    }

    public void SetEnabled(bool enabled)
    {
        if (_disposed) return;
        EndDemo();
        _preferences = _preferences with { Enabled = enabled };
        _store?.Save(_preferences); _window.SetExpanded(false); Refresh(); PreferenceChanged?.Invoke();
    }

    public void ShowControls()
    {
        if (_demo is not null)
        {
            _window.AllowInteraction(); _window.SetExpanded(true); _window.Activate(); return;
        }
        SetEnabled(true);
        if (_disposed || ReadingExperience.IsFullscreen) return;
        _manualShowUntil = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 120;
        _window.AllowInteraction(); Refresh();
        _window.SetExpanded(true); _window.Activate();
    }

    private void ShowSettings()
    {
        if (_disposed || _islandSync is null) return;
        if (_settingsWindow is not null) { _settingsWindow.Activate(); return; }
        _manualShowUntil = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 120;
        _settingsWindow = new(_local, _islandSync.Snapshot.Profile?.Appearance ?? new(), local =>
        {
            _islandSync.Store.Write("local-settings.json", local); _local = local; Refresh();
        }, () => Notify("提醒预览", "教室提醒会在顶部课表条显示，结束后自动恢复课表。", 8), PlayDemo, () => ShoutPreviewRequested?.Invoke());
        _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        _settingsWindow.Show(); _settingsWindow.Activate();
    }

    public void PlayDemo()
    {
        if (_disposed || ReadingExperience.IsFullscreen) return;
        if (_demoWindow is not null) { _demoWindow.Activate(); return; }
        _settingsWindow?.Close();
        var date = DateOnly.FromDateTime(DateTimeOffset.Now.ToOffset(TimeSpan.FromHours(8)).DateTime);
        _demo = new(date); _demo.Play();
        var controller = new IslandDemoWindow(() =>
        {
            if (_demo is null) return;
            if (_demo.Playing) _demo.Pause(); else _demo.Play();
            RenderDemo(); if (_demo.Playing) _demoTimer.Start();
        }, () =>
        {
            _demo?.Restart(); RenderDemo(); _demoTimer.Start();
        }, index =>
        {
            if (_demo is null) return;
            _demo.Pause(); _demo.Seek(IslandDemoPlayback.Stages[index].At); RenderDemo();
        });
        _demoWindow = controller;
        controller.Closed += (_, _) => { if (ReferenceEquals(_demoWindow, controller)) EndDemo(); };
        _window.SetExpanded(false); _window.AllowInteraction();
        RenderDemo(); controller.Show(); controller.Activate(); _demoTimer.Start();
    }

    private void RenderDemo()
    {
        if (_disposed || _demo is null) return;
        var scene = _demo.Scene();
        var source = _local.Appearance ?? _islandSync?.Snapshot.Profile?.Appearance ?? new();
        var appearance = new IslandAppearance { Position = source.Position, Width = source.Width,
            Theme = source.Theme, Opacity = source.Opacity, OffsetX = source.OffsetX, OffsetY = source.OffsetY,
            ClickThrough = false, HideFullscreen = false, HideDuringLessons = false };
        _window.Update(scene.View, false);
        _window.ApplyProfile(appearance, scene.Profile, scene.Now, "", scene.View.ConnectionText, _demo.Playing);
        if (!_window.IsVisible) _window.Show();
        _demoWindow?.Update(_demo, scene);
        if (!_demo.Playing) _demoTimer.Stop();
    }

    public void EndDemo()
    {
        if (_demo is null) return;
        _demoTimer.Stop(); _demo = null;
        var controller = _demoWindow; _demoWindow = null; controller?.Close();
        _window.SetExpanded(false);
        if (!_disposed)
        {
            if (_binding is null || _offline is null) _window.Hide();
            else Refresh();
        }
    }

    private void ToggleDim()
    {
        _preferences = _preferences with { Dimmed = !_preferences.Dimmed };
        _store?.Save(_preferences); Refresh();
    }

    private void ReadingStateChanged()
    {
        if (ReadingExperience.IsFullscreen) { EndDemo(); _window.SetExpanded(false); }
        Refresh();
    }

    private void Refresh()
    {
        if (_disposed) return;
        if (_binding is null || _offline is null)
        {
            if (_demo is not null) { RenderDemo(); return; }
            var unbound = _state.Present(null, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _connection, ReadingExperience.IsOpen);
            if (unbound.Notice is not { Category: "班级通知" } && _activeShout is not null) { CompleteShout(ShoutCloseReason.TimedOut); return; }
            _window.Update(unbound, false);
            _window.ApplyProfile(_local.Appearance ?? new(), null, DateTimeOffset.UtcNow, "", unbound.ConnectionText);
            if (unbound.Notice is { Category: "班级通知" }) { if (!_window.IsVisible) _window.Show(); PlatformTopmostService.Reassert(_window); }
            else _window.Hide();
            return;
        }
        if (_snapshotAt == 0 || Stopwatch.GetElapsedTime(_snapshotAt).TotalSeconds >= 15)
        {
            _snapshotAt = Stopwatch.GetTimestamp();
            try { _snapshot = _offline.Snapshot(); }
            catch (Exception error) { _snapshot = null; AppLog.Error("Read classroom island state failed", error); }
        }
        ClassroomIslandView view;
        try { view = _state.Present(_snapshot, _offline.Now, _connection, ReadingExperience.IsOpen); }
        catch (Exception error)
        {
            _snapshot = null;
            AppLog.Error("Invalid classroom island rule cache", error);
            view = _state.Present(null, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _connection, ReadingExperience.IsOpen);
        }
        var shouting = view.Notice is { Category: "班级通知" };
        if (!shouting && _activeShout is not null) { CompleteShout(ShoutCloseReason.TimedOut); return; }
        var island = _islandSync?.Snapshot;
        var profile = island?.Revoked == true ? null : island?.Profile;
        var now = DateTimeOffset.FromUnixTimeMilliseconds(_offline.Now);
        var localNow = now.ToOffset(TimeSpan.FromHours(8));
        var lessons = profile is not null ? IslandSchedule.On(profile, DateOnly.FromDateTime(localNow.DateTime)) : [];
        var current = lessons.FirstOrDefault(l => l.At(l.Slot.Start) <= now && now < l.At(l.Slot.End));
        if (profile is not null && profile.Enabled && _ledger is not null)
        {
            foreach (var e in IslandSchedule.Due(profile, _lastTick ?? now.AddMilliseconds(-1100), now))
            {
                try { if (_ledger.Claim(e, now.ToUnixTimeMilliseconds())) _pendingActions.Enqueue((e, profile, _binding, _generation)); }
                catch (Exception error) { _ledger = null; _islandSync?.Report("事件记录写入失败，自动化暂停"); AppLog.Error("Persist island action failed", error); break; }
            }
            if (!shouting && !_actionsRunning && _pendingActions.Count > 0)
                Dispatcher.UIThread.Post(() => { if (!_disposed && _activeShout is null && !_actionsRunning) _ = RunActions(); });
        }
        _lastTick = now;
        var component = "";
        if (profile is not null)
        {
            var components = profile.Components.Where(c => c.Enabled).ToArray();
            var items = components.Select(c => IslandSchedule.ComponentText(c, now)).ToList();
            component = items.Count > 0 ? items[(int)(now.ToUnixTimeSeconds() / profile.RotationSeconds % items.Count)] : "";
            if (profile.Slots.Count > 0)
            {
                var next = IslandSchedule.Next(profile, now);
                var status = IslandSchedule.Status(profile, now);
                items.Insert(0, status);
                var header = items[(int)(now.ToUnixTimeSeconds() / profile.RotationSeconds % items.Count)];
                view = view with { Status = view.Notice is null ? header : view.Status,
                    ReadingTitle = current is not null ? $"{current.Lesson.Subject} · 上课中" : next is not null ? $"下节 {next.Lesson.Subject}" : lessons.Count > 0 ? "今日课程已结束" : "今天没有课程",
                    ReadingDetail = current is not null ? current.Summary + (next is not null ? $" · 下节 {next.Lesson.Subject}" : "") : next is not null ? $"{next.Date:M月d日} {next.Summary}" : "查看今日课表，或打开早读活动。" };
            }
            else if (view.Notice is null && component.Length > 0) view = view with { Status = component };
        }
        if (island?.Revoked == true) view = view with { Status = "绑定已失效", CanOpenReading = false, ReadingTitle = "请重新绑定教室", ReadingDetail = "从教室首页打开绑定设置。" };
        if (_demo is not null) { RenderDemo(); return; }
        _window.Update(view, _preferences.Dimmed);
        var appearance = _local.Appearance ?? profile?.Appearance ?? new();
        _window.ApplyProfile(appearance, profile, now, component, (island?.Status ?? view.ConnectionText) + " · " + view.ConnectionText);
        var clock = Stopwatch.GetTimestamp();
        var attention = _autoUntil > clock;
        var manual = _manualShowUntil > clock || _settingsWindow is not null;
        if (!shouting && (!_preferences.Enabled || ReadingExperience.IsFullscreen || (!manual &&
            (profile?.Enabled == false || appearance.HideFullscreen && IslandPlatform.ForegroundFullscreen(_window) ||
                appearance.HideDuringLessons && current is not null && !attention))))
        { _window.Hide(); return; }
        _window.DockToPrimaryScreen();
        if (!_window.IsVisible) _window.Show();
        if (shouting) PlatformTopmostService.Reassert(_window);
    }

    private async Task RunActions()
    {
        _actionsRunning = true;
        try
        {
            while (!_disposed && _activeShout is null && _pendingActions.TryDequeue(out var item))
            {
                if (item.Generation != _generation || _islandSync?.Snapshot.Revoked == true) continue;
                var result = await _actions.Execute(item.Event, item.Profile, item.Binding, _local);
                if (_disposed || item.Generation != _generation) continue;
                var stamp = DateTimeOffset.Now.ToString("MM-dd HH:mm:ss") + " " + result;
                _local.RecentActions.Add(stamp); _local.RecentActions = _local.RecentActions.TakeLast(30).ToList();
                _islandSync?.Report(stamp);
                try { _islandSync?.Store.Write("local-settings.json", _local); }
                catch (Exception error) { AppLog.Error("Persist island action result failed", error); }
            }
        }
        finally { _actionsRunning = false; }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true; EndDemo(); CancelShouts(); _timer.Stop(); ReadingExperience.StateChanged -= ReadingStateChanged;
        _islandSync?.Dispose(); _actions.Dispose(); _settingsWindow?.Close();
        _window.DisposeWindow();
    }
}

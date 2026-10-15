using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ReadingReminderService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ReadingReminderHistory _history = new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "reading-reminders.json"));
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private CancellationTokenSource? _cancellation;
    private ReceiverConfig? _config;
    private ReadingSchedule? _schedule;
    private ReadingReminderWindow? _window;
    private long _synchronizedAt, _attemptedAt;
    private int _revision;
    private bool _busy;
    private string _lastError = "";

    public ReadingReminderService() => _timer.Tick += async (_, _) => await TickAsync();

    public void Start(ReceiverConfig config)
    {
        Stop(); _config = config; _cancellation = new CancellationTokenSource();
        _timer.Start(); _ = TickAsync();
    }

    public void Stop()
    {
        ++_revision; _timer.Stop(); _cancellation?.Cancel(); _cancellation?.Dispose(); _cancellation = null;
        _window?.Close(); _window = null; _config = null; _schedule = null; _busy = false; _attemptedAt = 0;
    }

    private long EstimatedServerTime => _schedule!.ServerTime + (long)Stopwatch.GetElapsedTime(_synchronizedAt).TotalMilliseconds;

    private ReadingWindow? Current() => _schedule is not null && Stopwatch.GetElapsedTime(_synchronizedAt).TotalSeconds < 45
        ? _schedule.CurrentWindow(EstimatedServerTime) : null;

    private bool IsCurrent(ReadingWindow period)
    {
        var current = Current();
        return current is not null && current.Day == period.Day && current.ClassId == period.ClassId && current.Start == period.Start && current.End == period.End;
    }

    private async Task<ReadingSchedule> FetchAsync(ReceiverConfig config, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, config.Endpoint.TrimEnd('/') + "/api/reading/schedule?deviceId=" + Uri.EscapeDataString(config.DeviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        using var response = await Http.SendAsync(request, token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("请确认网络、平台版本和教室绑定状态");
        var body = await response.Content.ReadAsStringAsync(token);
        return JsonSerializer.Deserialize<ReadingSchedule>(body, JsonOptions) ?? throw new InvalidOperationException("晨读时段暂时无法读取");
    }

    private async Task TickAsync()
    {
        if (_busy || _config is null || _cancellation is null) return;
        _busy = true;
        var revision = _revision; var token = _cancellation.Token; var config = _config;
        try
        {
            if (_attemptedAt == 0 || Stopwatch.GetElapsedTime(_attemptedAt).TotalSeconds >= 15)
            {
                _attemptedAt = Stopwatch.GetTimestamp();
                var schedule = await FetchAsync(config, token);
                if (revision != _revision) return;
                _schedule = schedule; _synchronizedAt = Stopwatch.GetTimestamp(); _lastError = "";
            }
            var current = Current();
            if (current is null || _window is not null) return;
            var scope = config.Endpoint.TrimEnd('/').ToLowerInvariant() + "/" + config.DeviceId + "/" + current.ClassId;
            if (_history.WasShown(scope, current)) return;
            // Persist before showing so a restart, reconnect, or dismissal cannot repeat this reminder.
            _history.Remember(scope, current);
            var dialogCancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
            var dialogToken = dialogCancellation.Token;
            ReadingReminderWindow? opened = null;
            opened = new ReadingReminderWindow(current, () => IsCurrent(current), async () =>
            {
                // Recheck the live schedule and device authorization before opening the reading window.
                var live = await FetchAsync(config, dialogToken);
                if (revision != _revision || !ReferenceEquals(_window, opened) || !opened!.IsVisible) return false;
                _schedule = live; _synchronizedAt = Stopwatch.GetTimestamp();
                if (!IsCurrent(current)) return false;
                await ClassroomControlService.OpenReadingAsync(config, dialogToken); return true;
            });
            _window = opened;
            opened.Closed += (_, _) => { dialogCancellation.Cancel(); dialogCancellation.Dispose(); if (ReferenceEquals(_window, opened)) _window = null; };
            opened.Show(); opened.Activate();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (revision == _revision)
            {
                // Do not start reminders from stale rules while offline or after device revocation.
                _schedule = null;
                if (_lastError != error.Message) { AppLog.Error("Reading reminder sync failed", error); _lastError = error.Message; }
            }
        }
        finally { if (revision == _revision) _busy = false; }
    }
}

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using Avalonia.Threading;

namespace ICeClass.Receiver;

internal sealed class ReadingReminderService
{
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

    private Task<ReadingSchedule> FetchAsync(ReceiverConfig config, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var snapshot = ReadingOfflineService.For(config).Snapshot();
        var value = snapshot["config"]!.DeepClone().AsObject();
        value["classId"] = snapshot["classId"]!.DeepClone(); value["className"] = snapshot["className"]!.DeepClone();
        value["serverTime"] = snapshot["serverTime"]!.DeepClone();
        if (snapshot["revoked"]?.GetValue<bool>() == true) value["enabled"] = false;
        return Task.FromResult(JsonSerializer.Deserialize<ReadingSchedule>(value.ToJsonString(), JsonOptions)!);
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
                // Use the latest locally saved rule; weak connectivity never blocks starting a lesson.
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
                // A damaged local cache must not produce a reminder with unknown rules.
                _schedule = null;
                if (_lastError != error.Message) { AppLog.Error("Reading reminder sync failed", error); _lastError = error.Message; }
            }
        }
        finally { if (revision == _revision) _busy = false; }
    }
}

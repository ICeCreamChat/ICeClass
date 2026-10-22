using System.Net.WebSockets;
using System.Net.Http.Headers;
using System.Text.Json;
using Avalonia.Threading;

namespace ICeClass.Receiver;

public sealed class CloudReceiverService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(45) };
    private readonly SpeechService _speech;
    private readonly AudioPlaybackService _audio = new();
    private readonly CancellationTokenSource _lifetime = new();
    private readonly HashSet<string> _recentIds = new(StringComparer.Ordinal);
    private readonly Queue<string> _recentOrder = new();
    private Task? _connectionTask;
    private CancellationTokenSource? _connectionCancellation;
    private AlertWindow? _currentAlert;
    private int _presentationGeneration;
    internal IShoutPresenter? NotificationPresenter { get; set; }

    public CloudReceiverService(SpeechService speech) => _speech = speech;
    public event EventHandler<ReceiverConnectionState>? ConnectionStateChanged;
    public event EventHandler<ReceiverConfig>? BindingChanged;
    public event EventHandler<ShoutData>? NotificationDisplayed;
    public event EventHandler<ShoutData>? NotificationAcknowledged;

    public Task StartAsync(ReceiverConfig config)
    {
        _connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _connectionTask = ConnectLoopAsync(config, _connectionCancellation.Token);
        return Task.CompletedTask;
    }

    public async Task RestartAsync(ReceiverConfig config)
    {
        await StopConnectionAsync();
        await Dispatcher.UIThread.InvokeAsync(() => NotificationPresenter?.Clear());
        await StartAsync(config);
    }

    public async Task StopAsync()
    {
        _lifetime.Cancel();
        await StopConnectionAsync();
        await Dispatcher.UIThread.InvokeAsync(() => { _presentationGeneration++; NotificationPresenter?.Clear(); _currentAlert?.Close(); _speech.Stop(); _audio.Stop(); });
        _audio.Dispose();
    }

    public Task ShowTestAsync(string alertLevel = "info")
    {
        var level = alertLevel is "info" or "warning" or "urgent" ? alertLevel : "info";
        var duration = level switch { "urgent" => 20, "warning" => 12, _ => 8 };
        return DisplayAsync(new ShoutPayload
        {
            Data = new ShoutData
            {
                SenderName = "本机测试",
                Text = $"这是{level switch { "urgent" => "紧急", "warning" => "重要", _ => "普通" }}通知的显示预览。",
                AlertLevel = level,
                DisplayDurationSec = duration,
            },
        }, null, CancellationToken.None);
    }

    public Task ShowShoutPreviewAsync(string alertLevel = "info", bool sound = false) => DisplayAsync(new ShoutPayload
    {
        Data = new ShoutData { SenderName = "本机预览", Text = alertLevel == "urgent" ? "请立即停止当前活动，留在座位上，听从老师安排。" : alertLevel == "warning"
                ? "第三节是实验课，请带好课本和练习册，提前到实验室集合，按学号就座。" : "同学们，请准备好课本和练习册，回到座位后保持安静。",
            AlertLevel = alertLevel is "warning" or "urgent" ? alertLevel : "info", DisplayDurationSec = 30, TtsVolume = sound && alertLevel != "info" ? .35 : 0, IsPreview = true }
    }, null, CancellationToken.None);

    public async Task PlayTestAudioAsync()
    {
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            _presentationGeneration++; NotificationPresenter?.Clear();
            _currentAlert?.Close();
            _currentAlert = null;
            _speech.Stop();
            _audio.Stop();
        });
        await _audio.PlayTestToneAsync(CancellationToken.None);
    }

    public async Task SendStudentVoiceAsync(ReceiverConfig config, byte[] audio, CancellationToken cancellationToken = default)
    {
        if (audio.Length < 44) throw new InvalidOperationException("录音内容为空。");
        var endpoint = new UriBuilder(config.Endpoint.TrimEnd('/') + "/api/classroom-voice")
        {
            Query = $"deviceId={Uri.EscapeDataString(config.DeviceId)}",
        }.Uri;
        using var content = new MultipartFormDataContent();
        var audioContent = new ByteArrayContent(audio);
        audioContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        content.Add(audioContent, "audio", "student.wav");
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        using var response = await Http.SendAsync(request, cancellationToken);
        if (response.IsSuccessStatusCode) return;
        var responseText = await response.Content.ReadAsStringAsync(cancellationToken);
        try
        {
            using var document = JsonDocument.Parse(responseText);
            var error = document.RootElement.TryGetProperty("error", out var value) ? value.GetString() : null;
            throw new InvalidOperationException(error ?? $"云端返回错误（{(int)response.StatusCode}）。");
        }
        catch (JsonException)
        {
            throw new InvalidOperationException($"云端返回错误（{(int)response.StatusCode}）。");
        }
    }

    private async Task ConnectLoopAsync(ReceiverConfig config, CancellationToken token)
    {
        var delaySeconds = 1;
        while (!token.IsCancellationRequested)
        {
            try
            {
                SetState(false, "正在连接云端");
                using var socket = new ClientWebSocket();
                using var sendLock = new SemaphoreSlim(1, 1);
                socket.Options.SetRequestHeader("Authorization", $"Bearer {config.DeviceToken}");
                var endpoint = new UriBuilder(config.Endpoint)
                {
                    Scheme = config.Endpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
                    Path = "/ws/device",
                    Query = $"deviceId={Uri.EscapeDataString(config.DeviceId)}",
                }.Uri;
                await socket.ConnectAsync(endpoint, token);
                delaySeconds = 1;
                AppLog.Info($"Connected for class {config.ClassName}");
                SetState(true, $"已连接：{config.ClassName}");
                using var connection = CancellationTokenSource.CreateLinkedTokenSource(token);
                var receive = ReceiveAsync(socket, sendLock, config, connection.Token);
                var heartbeat = HeartbeatAsync(socket, sendLock, connection.Token);
                await Task.WhenAny(receive, heartbeat);
                connection.Cancel();
                socket.Abort();
                try { await Task.WhenAll(receive, heartbeat); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception exception)
            {
                AppLog.Error("Cloud connection failed", exception);
                SetState(false, "连接中断，正在自动重连；持续失败请检查绑定");
            }
            if (token.IsCancellationRequested) break;
            SetState(false, $"断线，{delaySeconds} 秒后自动重连");
            try { await Task.Delay(TimeSpan.FromSeconds(delaySeconds), token); }
            catch (OperationCanceledException) { break; }
            delaySeconds = Math.Min(60, delaySeconds * 2);
        }
        SetState(false, "已停止连接");
    }

    private static async Task HeartbeatAsync(ClientWebSocket socket, SemaphoreSlim sendLock, CancellationToken token)
    {
        await SendDeviceStatusAsync(socket, sendLock, token);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
        while (await timer.WaitForNextTickAsync(token))
        {
            await SendAsync(socket, sendLock, new { type = "heartbeat" }, token);
            await SendDeviceStatusAsync(socket, sendLock, token);
        }
    }

    private static Task SendDeviceStatusAsync(ClientWebSocket socket, SemaphoreSlim sendLock, CancellationToken token) =>
        SendAsync(socket, sendLock, new { type = "device_status", outputVolume = ClassroomControlService.ReadVolume(),
            version = ReceiverUpdateService.CurrentVersionText, capabilities = new[] { "reading", "volume" }, computer = ComputerIdentity.Snapshot() }, token);

    private static async Task HandleCommandAsync(JsonElement command, ClientWebSocket socket, SemaphoreSlim sendLock, ReceiverConfig config, CancellationToken token)
    {
        if (!command.TryGetProperty("commandId", out var id) || id.ValueKind != JsonValueKind.String || id.GetString()?.Length > 100 ||
            !command.TryGetProperty("action", out var actionNode) || actionNode.ValueKind != JsonValueKind.String) return;
        var action = actionNode.GetString();
        if (action is not ("set_volume" or "open_reading")) return;
        try
        {
            if (action == "set_volume")
            {
                if (!command.TryGetProperty("volume", out var value) || !value.TryGetInt32(out var volume) || volume is < 0 or > 100) return;
                ClassroomControlService.SetVolume(volume);
            }
            else await ClassroomControlService.OpenReadingAsync(config, token);
            await SendAsync(socket, sendLock, new { type = "device_command_ack", commandId = id.GetString(), action, success = true, outputVolume = ClassroomControlService.ReadVolume() }, token);
        }
        catch (Exception error)
        {
            AppLog.Error("Classroom control failed", error);
            await SendAsync(socket, sendLock, new { type = "device_command_ack", commandId = id.GetString(), action, success = false, error = error.Message, outputVolume = ClassroomControlService.ReadVolume() }, token);
        }
    }

    private async Task ReceiveAsync(ClientWebSocket socket, SemaphoreSlim sendLock, ReceiverConfig config, CancellationToken token)
    {
        var buffer = new byte[8192];
        while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            using var message = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 256 * 1024) return;
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            try
            {
                using var command = JsonDocument.Parse(message.ToArray());
                if (command.RootElement.ValueKind == JsonValueKind.Object && command.RootElement.TryGetProperty("type", out var kind) && kind.GetString() is "connected" or "binding_updated")
                {
                    var binding = command.RootElement;
                    if (binding.TryGetProperty("classId", out var classId) && classId.ValueKind == JsonValueKind.String &&
                        binding.TryGetProperty("className", out var className) && className.ValueKind == JsonValueKind.String &&
                        !string.IsNullOrWhiteSpace(classId.GetString()) && classId.GetString()!.Length <= 80 &&
                        !string.IsNullOrWhiteSpace(className.GetString()) && className.GetString()!.Length <= 40)
                    {
                        var name = config.DeviceName;
                        if (binding.TryGetProperty("deviceName", out var deviceName) && deviceName.ValueKind == JsonValueKind.String &&
                            !string.IsNullOrWhiteSpace(deviceName.GetString()) && deviceName.GetString()!.Length <= 80) name = deviceName.GetString()!;
                        var changed = config.ClassId != classId.GetString() || config.ClassName != className.GetString() || config.DeviceName != name;
                        config.ClassId = classId.GetString()!; config.ClassName = className.GetString()!; config.DeviceName = name;
                        if (changed)
                        {
                            try { ReceiverConfig.Save(config, updateStartup: false); }
                            catch (Exception error) { AppLog.Error("Save updated classroom binding failed", error); }
                        }
                        BindingChanged?.Invoke(this, config);
                        SetState(true, $"已连接：{config.ClassName}");
                    }
                    continue;
                }
                if (command.RootElement.ValueKind == JsonValueKind.Object && command.RootElement.TryGetProperty("type", out kind) && kind.GetString() == "device_command")
                {
                    await HandleCommandAsync(command.RootElement, socket, sendLock, config, token);
                    continue;
                }
            }
            catch (JsonException) { continue; }
            ShoutPayload? payload;
            try { payload = JsonSerializer.Deserialize<ShoutPayload>(message.ToArray(), JsonOptions); }
            catch (JsonException) { continue; }
            if (!TryAccept(payload) || payload is null) continue;
            await AckAsync(socket, sendLock, payload.MessageId, "received", null, token);
            // A queued message must not block receiving a later emergency.
            _ = DisplayReceivedAsync(payload, config, socket, sendLock, token);
        }
    }

    private bool TryAccept(ShoutPayload? payload)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (payload is null || payload.Type != "shout" || payload.Version != "1.0" || payload.Action != "shout" || payload.Data is null) return false;
        if (string.IsNullOrWhiteSpace(payload.MessageId) || payload.MessageId.Length > 100 || payload.ExpiresAt <= now) return false;
        if (payload.Timestamp > now + 300_000 || payload.ExpiresAt > now + 300_000) return false;
        if (string.IsNullOrWhiteSpace(payload.Data.Text) || payload.Data.Text.Length > 500) return false;
        if (string.IsNullOrWhiteSpace(payload.Data.SenderName) || payload.Data.SenderName.Length > 80) return false;
        if (payload.Data.AlertLevel is not ("info" or "warning" or "urgent")) return false;
        if (!double.IsFinite(payload.Data.TtsVolume) || payload.Data.TtsVolume is < 0 or > 1 || payload.Data.TtsSpeed is < -10 or > 10) return false;
        if (payload.Data.DisplayDurationSec is < 5 or > 60 || !_recentIds.Add(payload.MessageId)) return false;
        if (payload.Data.ContentType == "audio")
        {
            if (string.IsNullOrWhiteSpace(payload.Data.AudioUrl) || !payload.Data.AudioUrl.StartsWith("/api/shouts/", StringComparison.Ordinal) ||
                payload.Data.AudioDurationMs is < 500 or > 30_000) return false;
        }
        else if (payload.Data.ContentType != "text") return false;
        _recentOrder.Enqueue(payload.MessageId);
        while (_recentOrder.Count > 50) _recentIds.Remove(_recentOrder.Dequeue());
        return true;
    }

    private async Task DisplayReceivedAsync(ShoutPayload payload, ReceiverConfig config, ClientWebSocket socket, SemaphoreSlim sendLock, CancellationToken token)
    {
        async Task Report(string status, string? detail = null)
        {
            try { if (!token.IsCancellationRequested && socket.State == WebSocketState.Open) await AckAsync(socket, sendLock, payload.MessageId, status, detail, token); }
            catch (Exception error) when (error is OperationCanceledException or WebSocketException or ObjectDisposedException) { }
        }
        try
        {
            var audioTask = await DisplayCoreAsync(payload, config, token, () => Report("acknowledged", "教室已点击“已知晓”"));
            if (audioTask is null) await Report("displayed", "已在教室展示；尚未人工确认");
            else await FinishAudioAsync(socket, sendLock, payload.MessageId, audioTask, token);
        }
        catch (Exception error)
        {
            if (!token.IsCancellationRequested) { AppLog.Error("Message display failed", error); await Report("failed", error.Message); }
        }
    }

    private Task<Task?> DisplayAsync(ShoutPayload payload, ReceiverConfig? config, CancellationToken token)
        => DisplayCoreAsync(payload, config, token, null);

    private async Task<Task?> DisplayCoreAsync(ShoutPayload payload, ReceiverConfig? config, CancellationToken token, Func<Task>? acknowledged)
    {
        Task? shown = null;
        var generation = 0;
        var closed = false;
        void StopCurrent(bool stopAudio)
        {
            if (generation == 0 || generation != _presentationGeneration) return;
            _presentationGeneration++; _speech.Stop(); if (stopAudio) _audio.Stop();
        }
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            if (NotificationPresenter is { } presenter)
            {
                shown = presenter.QueueAsync(payload.Data, reason =>
                {
                    closed = true;
                    StopCurrent(reason != ShoutCloseReason.TimedOut);
                    if (reason == ShoutCloseReason.Acknowledged)
                    {
                        NotificationAcknowledged?.Invoke(this, payload.Data);
                        if (acknowledged is not null) _ = acknowledged();
                    }
                }, () => StopCurrent(true), payload.ExpiresAt);
            }
            else
            {
                generation = ++_presentationGeneration;
                _speech.Stop(); _audio.Stop(); _currentAlert?.Close();
                var window = new AlertWindow(payload.Data);
                _currentAlert = window;
                window.Closed += (_, _) =>
                {
                    closed = true;
                    if (generation == _presentationGeneration)
                    {
                        if (window.StopSpeechOnClose) _speech.Stop();
                        if (window.StopAudioOnClose) _audio.Stop();
                    }
                    if (ReferenceEquals(_currentAlert, window)) _currentAlert = null;
                };
                window.Show(); shown = window.OpenedTask;
            }
        });
        if (shown is null) throw new InvalidOperationException("喊话窗口未能创建。");
        await shown;
        Task? playback = null;
        // Start playback on the same dispatcher as dismissal, so a message closed
        // during its first rendered frame cannot start speaking afterwards.
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            token.ThrowIfCancellationRequested();
            if (closed || NotificationPresenter is { } presenter && !presenter.IsCurrent(payload.Data)) return;
            generation = ++_presentationGeneration;
            _speech.Stop(); _audio.Stop();
            NotificationDisplayed?.Invoke(this, payload.Data);
            if (generation != _presentationGeneration || payload.Data.AlertLevel == "info") return;
            if (payload.Data.ContentType == "audio")
            {
                if (config is null) throw new InvalidOperationException("语音预览缺少设备配置。");
                var audioUri = new Uri(new Uri(config.Endpoint.TrimEnd('/') + "/", UriKind.Absolute), payload.Data.AudioUrl!.TrimStart('/'));
                var authenticatedAudioUri = new UriBuilder(audioUri)
                {
                    Query = $"deviceId={Uri.EscapeDataString(config.DeviceId)}",
                }.Uri;
                playback = _audio.PlayAsync(authenticatedAudioUri, config.DeviceToken, token);
            }
            else _speech.SpeakLatest(payload.Data.Text, payload.Data.TtsSpeed, payload.Data.TtsVolume);
        });
        return playback;
    }

    private async Task FinishAudioAsync(ClientWebSocket socket, SemaphoreSlim sendLock, string messageId, Task audioTask, CancellationToken token)
    {
        try
        {
            await audioTask;
            await AckAsync(socket, sendLock, messageId, "displayed", null, token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            await AckAsync(socket, sendLock, messageId, "failed", "语音播放被新通知中断", token);
        }
        catch (Exception exception)
        {
            AppLog.Error("Voice playback failed", exception);
            try { await AckAsync(socket, sendLock, messageId, "failed", "教室端无法播放语音", token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        }
    }

    private async Task StopConnectionAsync()
    {
        _connectionCancellation?.Cancel();
        if (_connectionTask is not null)
        {
            try { await _connectionTask; } catch (OperationCanceledException) { }
        }
        _connectionCancellation?.Dispose();
        _connectionCancellation = null;
        _connectionTask = null;
    }

    private static Task AckAsync(ClientWebSocket socket, SemaphoreSlim sendLock, string id, string status, string? detail, CancellationToken token) =>
        SendAsync(socket, sendLock, new { type = "ack", message_id = id, status, detail }, token);

    private static async Task SendAsync(ClientWebSocket socket, SemaphoreSlim sendLock, object value, CancellationToken token)
    {
        await sendLock.WaitAsync(token);
        try { await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions), WebSocketMessageType.Text, true, token); }
        finally { sendLock.Release(); }
    }

    private void SetState(bool connected, string text) => ConnectionStateChanged?.Invoke(this, new ReceiverConnectionState(connected, text));
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}

public sealed record ReceiverConnectionState(bool Connected, string Text);

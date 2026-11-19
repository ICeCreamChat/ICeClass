using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using Microsoft.Win32;

namespace ICeClass.Receiver;

/// <summary>Application-owned local plugin. Page navigation never owns its camera lifetime.</summary>
internal sealed class ClassroomWorkshopService : IAsyncDisposable
{
    private readonly ClassroomPluginPackage _package;
    private readonly string _boothData;
    private readonly SemaphoreSlim _operations = new(1, 1), _writes = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ClassroomPluginMessage>> _pending = new();
    private Process? _process;
    private NamedPipeServerStream? _pipe;
    private CancellationTokenSource? _run;
    private TaskCompletionSource? _hello;
    private ClassroomPluginInstallation? _installation;
    private string _message = "导入本机插件包，开始课堂展示。", _scope = "";
    private bool _starting, _ready, _busy, _stopping, _disposed, _damaged;
    internal event Action? Changed;
    internal event Action<string, JsonElement>? ActionRequested;
    internal event Action? ReviewInvalidated;
    internal bool IsRunning => _process is { HasExited: false };

    internal ClassroomWorkshopService(string? root = null, string? boothData = null)
    {
        _package = new(root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "Plugins"),
            RuntimeInformation.OSArchitecture == Architecture.X86 ? "win-x86" : "win-x64");
        _boothData = boothData ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "Receiver", "VideoBooth", "data");
        try { _installation = _package.Read(); _message = _installation is null ? _message : _installation.Enabled ? "已启用，可以打开视频展台。" : "已安装，启用后即可使用。"; }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException or KeyNotFoundException or InvalidOperationException) { _damaged = true; _message = "插件安装无法读取，请卸载后重新安装。"; }
        SystemEvents.SessionSwitch += SessionSwitch;
        SystemEvents.PowerModeChanged += PowerChanged;
    }

    internal object Snapshot() => new { installed = _installation is not null || _damaged, enabled = _installation?.Enabled == true,
        running = IsRunning, starting = _starting, busy = _busy, ready = _ready, message = _message,
        name = "视频展台", version = _installation?.Manifest.Version };

    internal async Task<object> HandleAsync(string operation, Window owner, ReceiverConfig binding, CancellationToken token)
    {
        if (operation is not ("status" or "install" or "enable" or "disable" or "open" or "stop" or "uninstall")) throw new ArgumentException("工坊操作无效。");
        if (_disposed) throw new InvalidOperationException("创意工坊已关闭。");
        if (operation == "status") return Snapshot();
        var stopping = operation is "stop" or "disable" or "uninstall";
        if (stopping) { _stopping = true; InvalidateReview(); if (_starting && _pipe?.IsConnected != true) _run?.Cancel(); }
        if (stopping) await _operations.WaitAsync(token);
        else if (!await _operations.WaitAsync(0, token)) throw new InvalidOperationException("正在处理插件，请稍候。停止操作仍可使用。");
        _busy = true; Publish();
        try
        {
            switch (operation)
            {
                case "install":
                {
                    if (_installation is not null || _damaged) throw new InvalidOperationException("请先卸载现有插件，再导入新包。展台资料会保留。");
                    var selected = await owner.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions {
                        Title = "选择视频展台插件包", AllowMultiple = false,
                        FileTypeFilter = [new FilePickerFileType("视频展台 ZIP 插件包") { Patterns = ["*.zip"] }] });
                    if (selected.Count == 0) break;
                    var path = selected[0].TryGetLocalPath() ?? throw new InvalidOperationException("请选择本机 ZIP 文件。");
                    using var candidate = ClassroomPluginPackage.Open(path);
                    var manifest = await Task.Run(() => _package.Inspect(candidate), token);
                    if (!await ConfirmInstall(owner, manifest, token)) break;
                    SetMessage("正在安装视频展台…");
                    await Task.Run(() => _package.InstallAsync(candidate, token), token);
                    _installation = _package.Read(); SetMessage("已安装，启用后即可使用。"); break;
                }
                case "enable":
                    _package.SetEnabled(true); _installation = _package.Read(); SetMessage("已启用，可以打开视频展台。"); break;
                case "disable":
                    _package.SetEnabled(false); _installation = _package.Read();
                    await StopCoreAsync(); SetMessage("已禁用，展示已停止。"); break;
                case "uninstall":
                    if (_installation is not null) { _package.SetEnabled(false); _installation = _package.Read(); }
                    await StopCoreAsync();
                    await Task.Run(_package.Uninstall, token); _installation = null; _damaged = false;
                    SetMessage("已卸载，展台配对和连接资料已保留。"); break;
                case "open": await StartCoreAsync(binding, token); break;
                case "stop": await StopCoreAsync(); SetMessage("展示已停止，可以重新打开。"); break;
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException) { SetMessage(error is OperationCanceledException ? "操作已取消，可重新尝试。" : error.Message); throw; }
        finally { _busy = false; if (stopping) _stopping = false; _operations.Release(); Publish(); }
        return Snapshot();
    }

    internal void SetBinding(ReceiverConfig binding)
    {
        var scope = Scope(binding);
        if (_scope.Length > 0 && _scope != scope) { InvalidateReview(); Suspend(); }
        _scope = scope;
    }
    private static string Scope(ReceiverConfig binding) => ReceiverConfig.NormalizeEndpoint(binding.Endpoint) + "\n" + binding.DeviceId + "\n" + binding.ClassId + "\n" + binding.DeviceToken;

    private async Task StartCoreAsync(ReceiverConfig binding, CancellationToken token)
    {
        if (_installation?.Enabled != true) throw new InvalidOperationException("请先启用视频展台插件。");
        if (string.IsNullOrWhiteSpace(binding.ClassId) || string.IsNullOrWhiteSpace(binding.DeviceToken)) throw new InvalidOperationException("请先完成教室绑定。");
        if (_scope.Length > 0 && _scope != Scope(binding)) throw new InvalidOperationException("教室绑定已变化，请重新打开工坊。");
        _scope = Scope(binding);
        if (IsRunning)
        {
            if (_ready) await CommandAsync("activate", new { }, token);
            return;
        }
        var entry = _package.EntryPoint();
        var name = "ICeClass.VideoBooth." + Guid.NewGuid().ToString("N");
        _pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        _run?.Dispose(); _run = new CancellationTokenSource();
        _hello = new(TaskCreationOptions.RunContinuationsAsynchronously);
        _starting = true; _ready = false; _stopping = false; SetMessage("正在打开视频展台…");
        var start = new ProcessStartInfo(entry) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(entry)!, WindowStyle = ProcessWindowStyle.Hidden };
        start.ArgumentList.Add("--iceclass-pipe"); start.ArgumentList.Add(name);
        start.ArgumentList.Add("--data"); start.ArgumentList.Add(_boothData);
        try
        {
            _process?.Dispose(); _process = Process.Start(start) ?? throw new InvalidOperationException("视频展台未能启动。");
            _ = ListenAsync(_pipe, _process, _hello, _run.Token);
            await _hello.Task.WaitAsync(TimeSpan.FromSeconds(15), token);
        }
        catch
        {
            _run.Cancel(); _pipe.Dispose();
            if (_process is { HasExited: false })
            {
                try { await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
                catch (TimeoutException) { SetMessage("视频展台尚未停止，请关闭展台后重试。"); }
            }
            _starting = false; throw;
        }
    }

    private async Task ListenAsync(NamedPipeServerStream pipe, Process process, TaskCompletionSource helloCompletion, CancellationToken token)
    {
        try
        {
            using var handshake = CancellationTokenSource.CreateLinkedTokenSource(token);
            handshake.CancelAfter(TimeSpan.FromSeconds(15));
            await pipe.WaitForConnectionAsync(handshake.Token);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) || pid != process.Id || process.HasExited)
                throw new InvalidDataException("插件连接与启动实例不匹配。");
            var hello = await ClassroomPluginProtocol.ReadAsync(pipe, handshake.Token);
            if (hello.Type != "hello" || hello.Payload.GetProperty("pluginId").GetString() != ClassroomPluginPackage.PluginId ||
                hello.Payload.GetProperty("processId").GetInt32() != process.Id) throw new InvalidDataException("视频展台插件握手失败。");
            helloCompletion.TrySetResult();
            while (!token.IsCancellationRequested)
            {
                var message = await ClassroomPluginProtocol.ReadAsync(pipe, token);
                if (!ReferenceEquals(_pipe, pipe)) return;
                if (_pending.TryRemove(message.RequestId, out var response))
                {
                    if (message.Type is not ("ack" or "frame" or "error")) throw new InvalidDataException("插件返回了错误的消息类型。");
                    response.TrySetResult(message); continue;
                }
                switch (message.Type)
                {
                    case "ready": Dispatcher.UIThread.Post(() => { if (!ReferenceEquals(_pipe, pipe)) return; _ready = true; _starting = false; SetMessage("视频展台已打开。"); }); break;
                    case "state":
                        var text = message.Payload.GetProperty("message").GetString();
                        if (text is not { Length: <= 200 }) throw new InvalidDataException("插件状态无效。");
                        Dispatcher.UIThread.Post(() => { if (ReferenceEquals(_pipe, pipe)) SetMessage(text); }); break;
                    case "review_requested": case "resume_requested": case "review_invalidated": case "question_requested": case "open_workshop":
                        Dispatcher.UIThread.Post(() => {
                            if (!ReferenceEquals(_pipe, pipe) || _stopping) return;
                            if (message.Type != "open_workshop" && _installation?.Enabled != true) return;
                            ActionRequested?.Invoke(message.Type, message.Payload);
                        }); break;
                    // A late reply belongs to a cancelled command and is deliberately discarded.
                    case "ack": case "frame": case "error": break;
                    default: throw new InvalidDataException("视频展台发送了未知消息。");
                }
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            helloCompletion.TrySetException(new InvalidOperationException("视频展台连接中断，请关闭展台后重新打开。"));
            foreach (var pending in _pending.Values) pending.TrySetException(new IOException("视频展台连接已结束。"));
            _pending.Clear();
            Dispatcher.UIThread.Post(() => {
                if (!ReferenceEquals(_pipe, pipe)) return;
                _ready = false; _starting = false; InvalidateReview();
                if (!_stopping) SetMessage(error is OperationCanceledException ? "视频展台连接已结束。" : "视频展台连接中断，请重新打开。");
            });
        }
        finally { pipe.Dispose(); }
    }

    internal async Task<ClassroomPluginMessage> CommandAsync(string type, object payload, CancellationToken token)
    {
        var pipe = _pipe;
        if (pipe is null || !pipe.IsConnected || !IsRunning) throw new InvalidOperationException("视频展台尚未就绪。");
        var id = Guid.NewGuid().ToString("N");
        var response = new TaskCompletionSource<ClassroomPluginMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = response;
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token, _run?.Token ?? CancellationToken.None);
        limit.CancelAfter(TimeSpan.FromSeconds(type == "freeze_frame" ? 8 : 5));
        try
        {
            await _writes.WaitAsync(limit.Token);
            try { await ClassroomPluginProtocol.WriteAsync(pipe, type, id, payload, limit.Token); }
            finally { _writes.Release(); }
            var result = await response.Task.WaitAsync(limit.Token);
            if (result.Type == "error") throw new InvalidOperationException(result.Payload.GetProperty("message").GetString() is { Length: <= 200 } text ? text : "展台未能完成此操作。");
            if ((type == "freeze_frame" && result.Type != "frame") || (type != "freeze_frame" && result.Type != "ack")) throw new InvalidDataException("插件响应类型不符。");
            return result;
        }
        finally { _pending.TryRemove(id, out _); }
    }

    internal void InvalidateReview() => ReviewInvalidated?.Invoke();
    internal async Task StopDisplayAsync()
    {
        InvalidateReview();
        if (_ready && IsRunning) { try { await CommandAsync("stop", new { }, CancellationToken.None); } catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException) { SetMessage("停止展示未完成，请关闭展台后重试。"); } }
    }
    internal async Task StopAsync()
    {
        InvalidateReview();
        // Interrupt an early handshake, but allow a connected plugin to stop cleanly.
        if (_starting && _pipe?.IsConnected != true) _run?.Cancel();
        await _operations.WaitAsync();
        try { await StopCoreAsync(); }
        finally { _operations.Release(); }
    }
    private async Task StopCoreAsync()
    {
        _stopping = true; InvalidateReview();
        if (_process is { HasExited: false } process)
        {
            SetMessage("正在停止视频展台…");
            try { await CommandAsync("exit", new { }, CancellationToken.None); }
            catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException or ObjectDisposedException) { }
            _run?.Cancel(); _pipe?.Dispose();
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TimeoutException) { _stopping = false; throw new InvalidOperationException("视频展台尚未停止，文件已保留。请关闭展台后重试。"); }
        }
        _run?.Cancel(); _pipe?.Dispose(); _pipe = null; _process?.Dispose(); _process = null;
        _starting = false; _ready = false; _stopping = false; Publish();
    }

    private void SessionSwitch(object sender, SessionSwitchEventArgs args) { if (args.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.SessionLogoff) Suspend(); }
    private void PowerChanged(object sender, PowerModeChangedEventArgs args) { if (args.Mode == PowerModes.Suspend) Suspend(); }
    internal void Suspend() => Dispatcher.UIThread.Post(async () => { try { await StopAsync(); SetMessage("展示已停止，需要时请重新打开。"); } catch (Exception error) when (error is not OutOfMemoryException) { SetMessage(error.Message); } });
    private void SetMessage(string text) { _message = text; Publish(); }
    private void Publish() => Changed?.Invoke();

    private static async Task<bool> ConfirmInstall(Window owner, ClassroomPluginManifest manifest, CancellationToken token)
    {
        var dialog = new Window { Title = "安装视频展台", Width = 460, MinHeight = 240, SizeToContent = SizeToContent.Height, CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = DesktopStyle.Brush("#E5F0F8") };
        ClassroomStyle.Apply(dialog);
        var install = ClassroomStyle.Button("安装", true); var cancel = ClassroomStyle.Button("取消");
        install.Click += (_, _) => dialog.Close(true); cancel.Click += (_, _) => dialog.Close(false);
        dialog.Content = new StackPanel { Margin = new Thickness(24), Spacing = 18, Children = {
            ClassroomStyle.SectionTitle("视频展台 " + manifest.Version),
            ClassroomStyle.Caption("仅安装到这台电脑。安装后需手动启用，打开摄像头仍由你操作。请只安装可信来源的插件包。"),
            new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Children = { cancel, install } } } };
        using var cancelled = token.Register(() => Dispatcher.UIThread.Post(() => dialog.Close(false)));
        return await dialog.ShowDialog<bool>(owner);
    }
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return; _disposed = true;
        SystemEvents.SessionSwitch -= SessionSwitch; SystemEvents.PowerModeChanged -= PowerChanged;
        await StopAsync(); _run?.Dispose();
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint processId);
}

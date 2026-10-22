using Avalonia.Controls;
using Avalonia.Threading;

namespace ICeClass.Receiver;

/// <summary>One reading window for home, tray, reminders, and remote commands.</summary>
internal static class ReadingExperience
{
    private static ReadingCompanionWindow? _window;
    public static bool IsOpen => _window is not null;
    public static bool IsFullscreen => _window is { IsVisible: true, WindowState: WindowState.FullScreen };
    public static event Action? Opened;
    public static event Action? StateChanged;
    private static Action? _returnHome;
    private static Action? _readingOpened;
    public static void Configure(Action returnHome, Action readingOpened) { _returnHome = returnHome; _readingOpened = readingOpened; }

    public static async Task OpenAsync(ReceiverConfig config, CancellationToken token = default)
    {
        await Dispatcher.UIThread.InvokeAsync(async () =>
        {
            token.ThrowIfCancellationRequested();
            if (_window is not null && _window.Matches(config)) { _window.BringForward(); return; }
            if (_window is not null) await _window.ReturnHomeAsync(false);
            var window = new ReadingCompanionWindow(config);
            _window = window;
            Opened?.Invoke();
            window.HomeRequested += () => _returnHome?.Invoke();
            window.PropertyChanged += (_, args) =>
            {
                if (args.Property == Window.WindowStateProperty || args.Property == Window.IsVisibleProperty) StateChanged?.Invoke();
            };
            window.Closed += (_, _) => { if (ReferenceEquals(_window, window)) { _window = null; StateChanged?.Invoke(); } };
            window.Show(); window.BringForward(); _readingOpened?.Invoke();
            StateChanged?.Invoke();
            try { await window.LoadAsync(token); }
            catch (OperationCanceledException) { await window.ReturnHomeAsync(false); throw; }
        });
    }

    public static void BindingChanged(ReceiverConfig binding)
    {
        if (_window is null) return;
        if (!_window.Matches(binding) || !_window.HasClass(binding.ClassId)) _ = _window.ReturnHomeAsync();
        else _window.SetClassName(binding.ClassName);
    }

    public static Task StopAsync() => _window?.ReturnHomeAsync(false) ?? Task.CompletedTask;
    public static bool ReturnToHomeIfOpen()
    {
        if (_window is null) return false;
        _ = _window.ReturnHomeAsync(); return true;
    }
}

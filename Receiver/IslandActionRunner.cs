using System.Diagnostics;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace ICeClass.Receiver;

internal sealed class IslandActionRunner(Func<ReceiverConfig, Task> openReading, Action<string, string, int> notify) : IDisposable
{
    private readonly SpeechService _speech = new();
    private WaveOutEvent? _sound;
    private bool _disposed;
    public async Task<string> Execute(IslandDueEvent e, IslandProfile p, ReceiverConfig binding, IslandLocalSettings local)
    {
        if (_disposed) return "";
        try
        {
            var rule = e.Automation;
            if (rule is null || rule.Action == "reminder")
            {
                notify(e.Title, e.Text, p.Reminders.DisplaySeconds);
                if (p.Reminders.Sound) PlayChime(p.Reminders.Volume);
                if (p.Reminders.Speech) _speech.SpeakLatest(e.Text, 0, p.Reminders.Volume / 100.0);
            }
            else if (rule.Action == "reading") await openReading(binding);
            else if (rule.Action == "website")
            {
                if (!Uri.TryCreate(rule.Value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo))
                    throw new InvalidOperationException("网页地址无效");
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            }
            else if (rule.Action == "app")
            {
                if (!ApplicationAllowed(rule.Value, local.AllowedApplications))
                {
                    notify("自动化应用待允许", $"请在教室浮岛设置中允许 {Path.GetFileName(rule.Value)}。", p.Reminders.DisplaySeconds);
                    return $"{e.Title}：应用尚未在本机允许";
                }
                Process.Start(new ProcessStartInfo(Path.GetFullPath(rule.Value)) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(rule.Value)! });
            }
            return $"{e.Title}：已执行";
        }
        catch (Exception error)
        {
            AppLog.Error("Island automation action failed", error);
            notify("自动化未完成", $"{e.Title}：{error.Message}", p.Reminders.DisplaySeconds);
            return $"{e.Title}：{error.Message}";
        }
    }
    internal static bool ApplicationAllowed(string path, IEnumerable<string> allowed)
    {
        try
        {
            return Path.IsPathFullyQualified(path) && Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(path) && allowed.Any(a => string.Equals(Path.GetFullPath(a), Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase));
        }
        catch { return false; }
    }
    private void PlayChime(int volume)
    {
        _sound?.Dispose();
        _sound = new WaveOutEvent();
        var tone = new SignalGenerator(44100, 1) { Type = SignalGeneratorType.Sin, Frequency = 880, Gain = volume / 100.0 * .15 };
        var fade = new FadeInOutSampleProvider(tone); fade.BeginFadeOut(360);
        _sound.Init(fade.Take(TimeSpan.FromMilliseconds(380))); _sound.Play();
    }
    public void StopFeedback() { _speech.Stop(); _sound?.Stop(); }
    public void Dispose() { _disposed = true; _speech.Dispose(); _sound?.Dispose(); }
}

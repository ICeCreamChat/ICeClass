using System.Diagnostics;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Threading;
using ICeClass.Receiver;

// Exercises the production WebSocket receiver and Windows adapter against a
// harmless real window. Binding and computer policy stay in memory.
internal static class NativeComputerDialogueReview
{
    internal static void Run(string binding, string output) => AppBuilder.Configure<IslandCheckHost>()
        .UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Open(binding, Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Open(string bindingPath, string output)
    {
        Directory.CreateDirectory(output);
        var config = JsonSerializer.Deserialize<ReceiverConfig>(File.ReadAllText(bindingPath))!;
        if (config.Endpoint is not ("http://127.0.0.1:8860" or "http://127.0.0.1:8863" or "http://127.0.0.1:8864")) throw new InvalidOperationException("Review binding must be the isolated localhost service.");
        using var process = Process.GetCurrentProcess();
        var policy = new ClassroomAgentPolicy { AllowAllFolders = false, Applications = [process.MainModule!.FileName], Folders = [Path.Combine(output, "课件")] };
        Directory.CreateDirectory(policy.Folders[0]);
        using var speech = new SpeechService();
        var cloud = new CloudReceiverService(speech, new ClassroomAgentService(() => policy));
        var text = new TextBox { Text = "等待班班通过对话修改", MinHeight = 44 };
        AutomationProperties.SetName(text, "验收文字");
        var toggle = new CheckBox { Content = "上课准备", MinHeight = 40 };
        var volume = new Slider { Minimum = 0, Maximum = 100, Value = 25 };
        AutomationProperties.SetName(volume, "课堂音量");
        var status = new TextBlock { Text = "正在连接", TextWrapping = Avalonia.Media.TextWrapping.Wrap };
        var content = new StackPanel { Margin = new Thickness(24), Spacing = 14, Children = {
            new TextBlock { Text = "班班对话验收", FontSize = 22, FontWeight = Avalonia.Media.FontWeight.SemiBold },
            text, toggle, volume, status } };
        var tabs = new TabControl { SelectedIndex = 0, ItemsSource = new[] {
            new TabItem { Header = "课堂安排", Content = content },
            new TabItem { Header = "资料设置", Content = new TextBlock { Text = "资料设置已打开" } } } };
        var window = new Window { Title = "班班对话验收窗口", Width = 560, Height = 400,
            MinWidth = 360, MinHeight = 240, FontFamily = "Microsoft YaHei UI",
            Content = tabs };
        void Save() => File.WriteAllText(Path.Combine(output, "actual-state.json"), JsonSerializer.Serialize(new {
            text = text.Text, ready = toggle.IsChecked, volume = volume.Value, tab = tabs.SelectedIndex, window = window.Title,
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), pid = Environment.ProcessId
        }));
        text.TextChanged += (_, _) => Save();
        toggle.IsCheckedChanged += (_, _) => Save();
        volume.PropertyChanged += (_, e) => { if (e.Property == Slider.ValueProperty) Save(); };
        tabs.SelectionChanged += (_, _) => Save();
        cloud.ConnectionStateChanged += (_, value) => Dispatcher.UIThread.Post(() => status.Text = value.Text);
        cloud.ComputerAgent.StatusChanged += value => Dispatcher.UIThread.Post(() => {
            status.Text = value;
            File.AppendAllText(Path.Combine(output, "native-events.jsonl"), JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), status = value }) + "\n");
        });
        window.Closed += async (_, _) => {
            await cloud.StopAsync();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        };
        window.Show(); Save();
        await cloud.StartAsync(config);
    }
}

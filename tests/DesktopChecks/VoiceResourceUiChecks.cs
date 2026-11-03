using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Desktop;
using ICeClass.Receiver;
using ICeClass.Updates;

internal static class VoiceResourceUiChecks
{
    internal static string Output = "";
    internal static void Run(string output)
    {
        Output = Path.GetFullPath(output);
        var thread = new Thread(() => AppBuilder.Configure<VoiceResourceUiApp>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

public sealed class VoiceResourceUiApp : Application
{
    private readonly App _product = new();
    public override void Initialize()
    {
        _product.Initialize();
        foreach (var resource in _product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = _product.Styles.ToArray(); _product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted(); Dispatcher.UIThread.Post(() => _ = Check());
    }
    private async Task Check()
    {
        var checks = new List<string>();
        void Assert(bool value, string label) { if (!value) throw new Exception(label); checks.Add(label); }
        static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(owner)!;
        static void Set(object owner, string name, object value) => owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(owner, value);
        using var lifetime = new CancellationTokenSource();
        using var listener = new HttpListener();
        DesktopWindow? main = null; DesktopWindow? child = null; SettingsWindow? settings = null;
        try
        {
            Directory.CreateDirectory(VoiceResourceUiChecks.Output);
            using var port = new TcpListener(IPAddress.Loopback, 0); port.Start();
            var endpoint = "http://127.0.0.1:" + ((IPEndPoint)port.LocalEndpoint).Port; port.Stop();
            listener.Prefixes.Add(endpoint + "/"); listener.Start();
            _ = Task.Run(async () =>
            {
                try
                {
                    while (!lifetime.IsCancellationRequested)
                    {
                        var request = await listener.GetContextAsync().WaitAsync(lifetime.Token);
                        var html = Encoding.UTF8.GetBytes("<!doctype html><html lang=zh><meta charset=utf-8><title>本地界面检查</title><body style='font:16px Microsoft YaHei UI;padding:32px'>教师工作台 · 本地隔离验收</body></html>");
                        request.Response.ContentType = "text/html; charset=utf-8";
                        request.Response.ContentLength64 = html.Length;
                        await request.Response.OutputStream.WriteAsync(html, lifetime.Token); request.Response.Close();
                    }
                }
                catch (Exception error) when (error is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
            });
            typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!.GetProperty("Options", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, LaunchOptions.Parse(["--server", endpoint, "--data-dir", Path.Combine(VoiceResourceUiChecks.Output, "profile")]));
            Set(_product, "_desktop", ApplicationLifetime!);
            Set(_product, "<Settings>k__BackingField", new DesktopSettings { Endpoint = endpoint, CloseToTray = false });
            main = new DesktopWindow(_product, endpoint, true); Set(_product, "_window", main); main.Show();
            var preparation = Field<VoicePreparation>(main, "_voicePreparation");
            for (var attempt = 0; attempt < 200 && preparation.Current.Message == "正在检查语音资源…"; attempt++) await Task.Delay(50);
            Assert(preparation.Current.Message != "正在检查语音资源…", "the real teacher window finishes its initial resource inspection");
            Assert(!main.GetVisualDescendants().OfType<VoiceResourcesView>().Any(), "voice preparation stays inside desktop settings and leaves the workspace unobstructed");
            var editing = _product.ShowSettingsAsync();
            settings = ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Windows.OfType<SettingsWindow>().Single();
            var view = settings.GetVisualDescendants().OfType<VoiceResourcesView>().Single();
            Assert(view.GetVisualDescendants().OfType<Button>().Count() == 1, "desktop settings provide one action that prepares all required resources");
            var progress = new UpdateProgress(UpdateStage.Downloading, 37 * 1048576, 100 * 1048576);
            foreach (var width in new[] { 520, 380 })
            {
                settings.Width = width; view.SetState(new("正在下载语音资源 37%", true, Progress: progress));
                settings.RevealVoiceResources(); await Task.Delay(180);
                var actions = view.GetVisualDescendants().OfType<Button>().ToArray();
                var bar = view.GetVisualDescendants().OfType<ProgressBar>().Single();
                Assert(bar.Value == 37 && actions.Any(button => button.Content as string == "暂停下载"), $"{width}px desktop settings show progress and pause");
                Assert(actions.All(button => button.FontWeight == FontWeight.SemiBold && button.TranslatePoint(default, view) is { } point &&
                    point.X >= 0 && point.X + button.Bounds.Width <= view.Bounds.Width + 1), $"{width}px teacher resource buttons fit and retain shared SemiBold type");
                Assert(actions.All(button => button.Focus()), $"{width}px teacher resource actions support keyboard focus");
                using var image = new RenderTargetBitmap(PixelSize.FromSize(settings.ClientSize, 1), new Vector(96, 96));
                image.Render(settings); image.Save(Path.Combine(VoiceResourceUiChecks.Output, $"teacher-voice-settings-{width}.png"));
            }
            view.SetState(new("语音资源下载未完成，请检查网络后重试", Progress: progress));
            Assert(view.GetVisualDescendants().OfType<Button>().Single().IsEnabled, "teacher errors keep the resume action available");
            view.SetState(new("语音资源已就绪", Ready: true));
            Assert(!view.GetVisualDescendants().OfType<Button>().Any(button => button.IsVisible), "ready teacher resources need no additional package download");

            // Force only in-memory readiness to missing, then block on actual recording.
            // This exercises the real child-to-main handler without downloading any model.
            Set(ClassroomVoiceTranscriber.Resources, "_ready", false);
            Field<HashSet<Guid>>(main, "_recordingFrames").Add(Guid.NewGuid());
            view.SetState(new("语音资源待准备"));
            view.GetVisualDescendants().OfType<Button>().Single().RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Task.Delay(100);
            Assert(preparation.Current.Message.Contains("活动") && view.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text?.Contains("活动") == true),
                "the settings download action reaches the live preparation controller and respects recording");
            settings.Close(null); await editing;
            editing = _product.ShowSettingsAsync();
            settings = ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Windows.OfType<SettingsWindow>().Single();
            Assert(settings.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text?.Contains("活动") == true),
                "closing and reopening settings retains the preparation state");
            await _product.ShowSettingsAsync();
            Assert(((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Windows.OfType<SettingsWindow>().Count() == 1,
                "repeated settings requests reuse the open window");
            settings.Close(null); await editing;
            child = new DesktopWindow(_product, endpoint, false); child.Show(); main.Hide();
            typeof(DesktopWindow).GetMethod("StartVoiceDownload", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(child, null);
            await Task.Delay(100);
            settings = ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Windows.OfType<SettingsWindow>().Single();
            Assert(main.IsVisible && preparation.Current.Message.Contains("活动") && !preparation.IsDownloading && settings.IsVisible &&
                ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Windows.OfType<SettingsWindow>().Count() == 1,
                "a child request opens settings while recording still blocks transfer");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            lifetime.Cancel(); listener.Close(); settings?.Close(null); child?.Close(); main?.DisposePage();
            File.WriteAllText(Path.Combine(VoiceResourceUiChecks.Output, "teacher-voice-ui.json"), JsonSerializer.Serialize(new { passed = Environment.ExitCode == 0, checks }));
            Console.WriteLine($"{checks.Count} teacher voice UI checks passed; exit={Environment.ExitCode}.");
            ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

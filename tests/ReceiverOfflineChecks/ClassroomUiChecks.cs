using System.Text.Json;
using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

// Render only isolated test windows. Opacity=0 and ShowActivated=false keep the
// user's desktop and focus intact; no microphone, binding or real API is used.
internal static class ClassroomUiChecks
{
    internal static void Run(string output)
    {
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(Path.GetFullPath(output))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Check(string output)
    {
        var checks = new List<string>();
        var failures = new List<string>();
        var presentationChecks = 0;
        var windows = new List<Window>();
        void Assert(bool condition, string label) { (condition ? checks : failures).Add(label); }
        async Task Render(Window window, string name, double width, double height)
        {
            window.Width = width; window.Height = height;
            window.Opacity = 0; window.ShowActivated = false; window.ShowInTaskbar = false;
            window.PropertyChanged += (_, change) => { if (change.Property == Window.OpacityProperty && window.Opacity != 0) window.Opacity = 0; };
            windows.Add(window); window.Show(); await Task.Delay(100); window.UpdateLayout();
            var root = (Control)window.Content!;
            if (Environment.GetEnvironmentVariable("ICECLASS_CAPTURE_UI") == "1")
                foreach (var scale in new[] {1d, 1.5})
                {
                    using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width * scale),
                        (int)Math.Ceiling(root.Bounds.Height * scale)), new Vector(96 * scale, 96 * scale));
                    bitmap.Render(root); bitmap.Save(Path.Combine(output, $"{name}-{width:0}-{scale * 100:0}.png"));
                }
            foreach (var button in window.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible && b.Content is string {Length:>0}))
            {
                var label = (string)button.Content!;
                var text = button.GetVisualDescendants().OfType<TextBlock>().FirstOrDefault(t => t.Text == label);
                if (text is not null)
                    Assert(text.TextLayout.WidthIncludingTrailingWhitespace <= text.Bounds.Width + 1,
                        $"{name}/{width}: action “{label}” is not clipped");
            }
        }
        try
        {
            Directory.CreateDirectory(output);
            presentationChecks = IslandRibbonChecks.Run() + IslandSpringChecks.Run()
                + IslandHoldingArmChecks.Run() + IslandDemoChecks.Run();
            var binding = new ReceiverConfig {Endpoint="http://127.0.0.1:1",DeviceId="isolated-ui-test",DeviceToken="fixture",ClassId="test",ClassName="高一（1）班",DeviceName="隔离界面检查"};
            var home = new StudentVoiceWindow(binding, _ => Task.CompletedTask);
            Assert(!((Control)home.Content!).GetVisualDescendants().OfType<ReadingBrowser>().Single().IsVisible, "Home browser stays hidden until the ready handshake");
            await Render(home,"home-loading",1280,850);
            var homeBrowser = home.GetVisualDescendants().OfType<ReadingBrowser>().Single();
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (!homeBrowser.IsVisible && DateTime.UtcNow < deadline) await Task.Delay(50);
            Assert(homeBrowser.IsVisible && homeBrowser.Core?.Source.Contains("/homework/classroom/index.html") == true,
                "The real local WebView initializes while hidden and becomes visible after ready");
            home.Close();
            var ideas = new CreativeIdeasWindow(binding);
            Assert(!((Control)ideas.Content!).GetVisualDescendants().OfType<ReadingBrowser>().Single().IsVisible, "Ideas browser stays hidden until navigation succeeds");
            await Render(ideas,"ideas-loading",720,620);
            await ideas.LoadAsync();
            Assert(!ideas.GetVisualDescendants().OfType<ReadingBrowser>().Single().IsVisible
                && ideas.GetVisualDescendants().OfType<Button>().Any(b => b.Content as string == "重新打开" && b.IsVisible),
                "A real failed navigation keeps its native error and retry action exposed");
            ideas.CloseWithoutPrompt();
            using var agent = new ClassroomAgentService();
            foreach (var width in new[] {700d, 440d})
            {
                var settings = new ComputerControlSettingsWindow(agent, null, new());
                await Render(settings, "computer-settings", width, 600);
                foreach (var checkbox in settings.GetVisualDescendants().OfType<CheckBox>().Where(c => c.IsEffectivelyVisible))
                {
                    var text = checkbox.GetVisualDescendants().OfType<TextBlock>().FirstOrDefault();
                    if (text is not null) Assert(text.TextLayout.WidthIncludingTrailingWhitespace <= text.Bounds.Width + 1,
                        $"Computer settings/{width}: permission label fits “{text.Text}”");
                }
                settings.Close();
                var island = new IslandSettingsWindow(new() {Appearance=new() {Width=560,Theme="light"},
                    AllowedApplications=[@"C:\Classroom Apps\教学工具与课程演示\TeachingTools.exe"]}, new(), _ => {}, () => {});
                await Render(island,"island-settings",width,600); island.Close();
            }
            foreach (var width in new[] {760d,640d})
            {
                var enrollment = new EnrollmentWindow(binding);
                await Render(enrollment,"enrollment",width,600); enrollment.Close();
            }
            var about = new AboutWindow(_ => Task.FromResult("隔离诊断"), acknowledgementsEndpoint:"http://127.0.0.1:1");
            await Render(about,"about",600,500); about.Close();
            var reminder = new ReadingReminderWindow(new ReadingWindow("2026-11-07",450,480,"test","高一（1）班"), () => true, () => Task.FromResult(false));
            await Render(reminder,"reading-reminder",600,400); reminder.Close();
            var alert = new AlertWindow(new ShoutData {SenderName="界面检查",Text="隔离通知",AlertLevel="info",DisplayDurationSec=30});
            var fade = typeof(AlertWindow).GetMethod("FadeTo",BindingFlags.NonPublic | BindingFlags.Instance)!;
            var completed = 0;
            fade.Invoke(alert,[1d,(Action)(() => completed++)]);
            Assert(DesktopStyle.AnimationsEnabled() ? completed == 0 : completed == 1,
                "Notification fade follows the current Windows animation preference");
            deadline = DateTime.UtcNow.AddSeconds(2);
            while (completed == 0 && DateTime.UtcNow < deadline) await Task.Delay(30);
            Assert(completed == 1 && alert.Opacity == 1, "Notification fade finishes exactly once");
            var timer = (DispatcherTimer)typeof(AlertWindow).GetField("_fadeTimer",BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(alert)!;
            Assert(!timer.IsEnabled,"Completed notification fades stop their timer");
            alert.Close();
        }
        catch (Exception error) { failures.Add(error.ToString()); }
        finally
        {
            foreach (var window in windows.Where(w => w.IsVisible)) window.Close();
            await File.WriteAllTextAsync(Path.Combine(output,"checks.json"),JsonSerializer.Serialize(new {passed=checks.Count,checks,presentationChecks,windowsAnimations=DesktopStyle.AnimationsEnabled(),failures},new JsonSerializerOptions {WriteIndented=true}));
            Console.WriteLine($"{checks.Count} native UI checks and {presentationChecks} island presentation checks passed; {failures.Count} failed.");
            foreach (var failure in failures) Console.Error.WriteLine(failure);
            Environment.ExitCode = failures.Count == 0 ? 0 : 1;
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

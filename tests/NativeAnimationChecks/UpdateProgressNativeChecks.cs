using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using ICeClass.Updates;

// Exercise the production settings and shared teacher/classroom progress control
// without loading a real device binding, connecting to a school or installing an update.
internal static class UpdateProgressNativeChecks
{
    private static readonly UpdateProgress Downloading = new(UpdateStage.Downloading, 37 * 1048576, 100 * 1048576);
    private static UpdateProgressView UpdateView(Window window) => window.GetVisualDescendants().OfType<UpdateProgressView>()
        .Single(view => view.GetVisualDescendants().OfType<ProgressBar>().Any(bar => AutomationProperties.GetName(bar) == "客户端更新下载进度"));
    private static EnrollmentWindow CreateWindow(string endpoint = "http://127.0.0.1:8870") => new(new ReceiverConfig
    {
        Endpoint = endpoint, DeviceId = "update-progress-preview", DeviceToken = "unused",
        ClassId = "preview", ClassName = "本地预览班级", DeviceName = "更新进度预览", StartWithWindows = false
    }) { Title = "教室设置 · 更新进度本地预览（示例，不下载）" };

    internal static async Task RunAsync(string output, Action<bool, string> check)
    {
        var window = CreateWindow();
        Window? teacher = null;
        try
        {
            window.Show();
            await Task.Delay(180);
            var view = UpdateView(window);
            var bar = view.GetVisualDescendants().OfType<ProgressBar>().Single();
            var button = window.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "检查更新");
            check(!bar.IsVisible, "idle settings do not show an empty download bar");

            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            window.SetUpdateState("正在检查更新…", true, progress: new(UpdateStage.Checking));
            await Task.Delay(100);
            check(bar.IsVisible && bar.IsIndeterminate == DesktopStyle.AnimationsEnabled() && !button.IsEnabled,
                "checking shows activity while preventing a duplicate update request");
            await Capture(window, output, "checking");

            foreach (var width in new[] { 760, 640 })
            {
                window.Width = width;
                window.SetUpdateState(Downloading.Message, true, progress: Downloading);
                await Task.Delay(100);
                if (width == 640) { view.BringIntoView(); await Task.Delay(100); }
                var words = view.GetVisualDescendants().OfType<TextBlock>().ToList();
                check(bar.IsVisible && !bar.IsIndeterminate && bar.Value == 37 &&
                      words.Any(t => t.Text == "正在下载更新 37%") &&
                      words.Any(t => t.Text == Downloading.Detail),
                    $"{width}px settings show a determinate percentage and actual downloaded/total MB");
                var barPosition = bar.TranslatePoint(default, window)!.Value;
                var buttonPosition = button.TranslatePoint(default, window)!.Value;
                check(bar.Bounds.Width > 200 && barPosition.X + bar.Bounds.Width + 10 <= buttonPosition.X &&
                      words.All(t => t.DesiredSize.Width <= view.Bounds.Width + 1),
                    $"{width}px settings keep progress, labels and update button aligned without overlap");
                var scroll = window.GetVisualDescendants().OfType<ScrollViewer>().First();
                var viewPosition = view.TranslatePoint(default, scroll)!.Value;
                check(viewPosition.Y >= 0 && viewPosition.Y + view.Bounds.Height <= scroll.Viewport.Height + 1,
                    $"{width}px settings reveal the full download progress above the fixed footer");
                await Capture(window, output, "downloading-" + width);
            }

            window.SetUpdateState("更新已暂停，课间空闲时继续下载。", false, progress: Downloading);
            view.BringIntoView(); await Task.Delay(100);
            check(bar.Value == 37 && !bar.IsIndeterminate && bar.IsVisible && button.IsEnabled,
                "paused downloads retain their percentage and allow a retry");
            await Capture(window, output, "paused");
            window.SetUpdateState("更新失败：请检查网络后重试。", false, progress: Downloading);
            check(bar.Value == 37 && bar.IsVisible && button.IsEnabled,
                "a connection error keeps the last download progress visible");

            var verifying = new UpdateProgress(UpdateStage.Verifying, 100 * 1048576, 100 * 1048576);
            window.SetUpdateState(verifying.Message, true, progress: verifying);
            check(bar.IsVisible && bar.IsIndeterminate == DesktopStyle.AnimationsEnabled() && !button.IsEnabled,
                "verification is labelled separately from a completed download");
            window.SetUpdateState("新版已就绪，下次启动安装。", false, true, verifying);
            view.BringIntoView(); await Task.Delay(100);
            check(bar.Value == 100 && !bar.IsIndeterminate && button.Content as string == "立即更新" && button.IsEnabled,
                "only a verified ready update presents a full bar and the install action");
            var requests = 0;
            window.UpdateRequested += (_, _) => requests++;
            check(button.Focus(), "the update action remains keyboard focusable");
            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            check(requests == 1, "the update action still reaches the existing update request handler");
            check(AutomationProperties.GetName(bar) == "客户端更新下载进度" &&
                  AutomationProperties.GetHelpText(bar)?.Contains(verifying.Detail) == true,
                "assistive technology receives the download label and byte totals");
            await Capture(window, output, "ready");

            window.SetUpdateState("正在更新，完成后自动重新打开…", true, true, verifying);
            view.BringIntoView(); await Task.Delay(100);
            check(!button.IsEnabled && button.Content as string == "正在更新…" && bar.Value == 100,
                "installing clearly labels the restart in progress and prevents repeated installation requests");
            await Capture(window, output, "installing");

            var teacherProgress = new UpdateProgressView();
            teacher = new Window { Title = "教师端更新进度 · 隔离检查", Width = 760, Height = 180,
                Content = new Border { Padding = new Thickness(16, 8), Child = teacherProgress } };
            teacherProgress.SetState(Downloading.Message, true, progress: Downloading);
            teacher.Show(); await Task.Delay(100);
            var teacherBar = teacherProgress.GetVisualDescendants().OfType<ProgressBar>().Single();
            check(teacherBar.Value == 37 && teacherBar.Bounds.Width > 600,
                "the shared teacher update strip displays the same full-width progress");
            await Capture(teacher, output, "teacher-progress");
            await CheckVoiceResources(window, output, check);
        }
        finally { teacher?.Close(); window.Close(); }
    }

    private static async Task CheckVoiceResources(EnrollmentWindow window, string output, Action<bool, string> check)
    {
        var voice = window.GetVisualDescendants().OfType<VoiceResourcesView>().Single();
        var actions = voice.GetVisualDescendants().OfType<Button>().ToArray();
        check(actions.Length == 1, "classroom settings offer one action to download every required voice resource");
        var download = actions.Single(button => button.Content as string == "下载语音资源");
        var requests = 0;
        window.VoiceDownloadRequested += () => requests++;
        window.SetVoiceResourceState(new("语音资源待准备，课间空闲时自动下载"));
        check(download.Focus(), "the voice resource action supports keyboard focus");
        download.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        check(requests == 1, "manual preparation reaches the product handler");
        foreach (var width in new[] { 760, 640 })
        {
            window.Width = width;
            window.SetVoiceResourceState(new("正在下载语音资源 37%", true, Progress: Downloading));
            voice.BringIntoView(); await Task.Delay(120);
            var bar = voice.GetVisualDescendants().OfType<ProgressBar>().Single();
            check(bar.Value == 37 && download.Content as string == "暂停下载" && bar.Bounds.Width > 150,
                $"{width}px classroom resource preparation shows byte progress and a pause action");
            await Capture(window, output, "voice-downloading-" + width);
            check(actions.All(button => button.Bounds.Width >= button.DesiredSize.Width - button.Margin.Left - button.Margin.Right - 1 &&
                button.TranslatePoint(default, voice) is { } point && point.X >= 0 && point.X + button.Bounds.Width <= voice.Bounds.Width + 1),
                $"{width}px classroom resource buttons fit inside their panel");
            check(voice.GetVisualDescendants().OfType<TextBlock>().All(text => text.DesiredSize.Width <= voice.Bounds.Width + 1),
                $"{width}px voice status labels remain within the resource panel");
        }
        window.SetVoiceResourceState(new("下载已暂停，可继续下载", Progress: Downloading));
        check(download.Content as string == "继续下载", "a paused voice transfer keeps an explicit resume action");
        await Capture(window, output, "voice-paused");
        window.SetVoiceResourceState(new("语音资源下载未完成，请检查网络后重试", Progress: Downloading));
        check(download.IsEnabled, "a failed voice transfer leaves retry available");
        window.SetVoiceResourceState(new("语音资源已就绪", Ready: true));
        check(!download.IsVisible, "ready voice resources need no additional package download");
        check(AutomationProperties.GetName(download) == "下载语音资源", "the download action has a descriptive accessible name");
        await Capture(window, output, "voice-ready");
    }

    private static async Task Capture(Window window, string output, string name)
    {
        Directory.CreateDirectory(output);
        await Task.Delay(60);
        using var image = new RenderTargetBitmap(PixelSize.FromSize(window.ClientSize, 1), new Vector(96, 96));
        image.Render(window);
        image.Save(Path.Combine(output, name + ".png"));
    }

    internal static void Preview(string endpoint)
    {
        var window = CreateWindow(endpoint);
        window.Title = "教室设置 · 更新流程本地验收（示例，不安装）";
        var preparation = new VoicePreparation(VoiceResourceFiles.Resources, () => new Uri(endpoint.TrimEnd('/') + "/"),
            (automatic, _) => Task.FromResult(!automatic));
        preparation.Changed += window.SetVoiceResourceState;
        window.VoiceDownloadRequested += async () => await preparation.DownloadAsync();
        var verified = new UpdateProgress(UpdateStage.Verifying, 100 * 1048576, 100 * 1048576);
        window.SetUpdateState("本地预览：更新已下载就绪。", false, true, verified);
        window.UpdateRequested += async (_, _) =>
        {
            window.SetUpdateState("正在更新，完成后自动重新打开…", true, true, verified);
            await Task.Delay(1800);
            window.SetUpdateState("预览完成。正式更新会安装并自动重新打开新版。", false, true, verified);
        };
        window.Opened += async (_, _) =>
        {
            await Task.Delay(100);
            UpdateView(window).BringIntoView();
        };
        window.Closed += (_, _) =>
        {
            preparation.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        };
        window.Show(); preparation.Start();
    }
}

using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

// Exercise the production island without a binding, sound, network or persisted settings.
internal static class NativeIslandLayoutReview
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Capture(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;

    private static async Task Capture(string output)
    {
        Directory.CreateDirectory(output);
        var records = new List<object>();
        var failures = new List<string>();
        var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
        const string message = "第三节是实验课，请带好课本和练习册，提前到实验室集合，按学号就座。";
        var longMessage = string.Join("\n", Enumerable.Repeat(message + "Please bring your workbook. 📚", 10));
        var states = new[] { "timetable-before", "timetable-break", "timetable-lesson", "timetable-after", "details", "details-timetable", "details-long", "details-notice", "empty-offline",
            "details-dimmed", "details-reading-unavailable", "details-reading-demo", "details-reading-loading",
            "info-short", "info-long", "warning-short", "warning-long", "urgent-short", "urgent-long", "urgent-multiline", "urgent-unbroken", "full-info", "full-urgent", "full-long-label" };
        var sequence = 0L;
        ClassroomIslandWindow? window = null;
        try
        {
            foreach (var theme in new[] { "light", "dark" })
            foreach (var width in new[] { 380, 560, 1000 })
            foreach (var state in states)
            {
                var key = $"{theme}-{width}-{state}";
                var level = state.Contains("warning") ? "warning" : state.Contains("urgent") ? "urgent" : "info";
                var hasShout = state.Contains('-') && (state.StartsWith("info-") || state.StartsWith("warning-") || state.StartsWith("urgent-") || state.StartsWith("full-"));
                var text = state.EndsWith("short") ? "请带好练习册。" : state.StartsWith("full-") ? longMessage
                    : state.EndsWith("multiline") ? "请立即停止当前活动。\n听从老师安排，有序离开教室。"
                    : state.EndsWith("unbroken") ? "ClassroomNotice" + new string('W', 200) : message;
                var notice = hasShout ? new ClassroomIslandNotice(state == "full-long-label" ? "高一年级实验课程教研组与班主任联合通知" : "本机预览", text, level, Sequence: ++sequence, Progress: .65, AgeSeconds: 5, DurationSeconds: 30) : null;
                if (state == "details-notice") notice = new("实验课程教研组与班主任联合通知", message, "warning", "教室提醒", ++sequence);
                var view = IslandRibbonChecks.View(notice);
                if (state is "details-long" or "full-long-label") view = view with { ClassName = "高一年级（十一）班 · 实验课程联合活动教室", ReadingTitle = "早读活动课程安排与班级同步状态", ReadingDetail = message };
                if (state == "empty-offline") view = view with { Connected = false, ReadingDetail = "网络恢复后同步设置，仍可打开本机早读活动。" };
                if (state == "details-reading-unavailable") view = view with { CanOpenReading = false, ReadingTitle = "请重新绑定教室", ReadingDetail = "从教室首页打开绑定设置。" };
                if (state == "details-reading-demo") view = view with { CanOpenReading = false, ReadingTitle = "下节 历史", ReadingUnavailableReason = "本机演示不启动早读，可退出演示后打开。" };
                var now = state.EndsWith("before") ? IslandRibbonChecks.At(7, 0) : state.EndsWith("lesson") ? IslandRibbonChecks.At(10, 40)
                    : state.EndsWith("after") ? IslandRibbonChecks.At(20, 0) : IslandRibbonChecks.At(10, 38);
                var opened = 0; var acknowledged = 0;
                var opening = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                window = new ClassroomIslandWindow(() => { opened++; return state == "details-reading-loading" ? opening.Task : Task.CompletedTask; }, () => { }, () => { }, () => { }, () => acknowledged++);
                var ribbon = Field<ClassroomIslandRibbon>(window, "_ribbon"); ribbon.Animate = false; ribbon.ReviewPhase = 1;
                var mascot = Field<IslandBanbanMascot>(window, "_mascot"); mascot.Animate = false;
                var companion = Field<IslandShoutCompanion>(window, "_companion"); companion.ReviewSeconds = 2.5;
                window.Update(view, state == "details-dimmed");
                companion.SetActive(hasShout, false);
                window.ApplyProfile(new() { Width = width, Theme = theme, HideFullscreen = false, Opacity = state == "details-dimmed" ? 40 : 100 }, state == "empty-offline" ? null : profile, now,
                    state.StartsWith("details") ? "距运动会 8 天 · 校园活动安排已同步" : "", "已连接", false);
                if (state.StartsWith("full-")) window.SetShoutExpanded(true);
                if (state.StartsWith("details") || state == "empty-offline") window.SetExpanded(true);
                if (state == "details-timetable") Field<Border>(window, "_lessonPanel").IsVisible = true;
                window.Show();
                await Task.Delay(40);
                Field<ClassroomIslandReveal>(window, "_importantReveal").SetExpanded(ribbon.ImportantExpanded, false);
                Field<ClassroomIslandReveal>(window, "_shoutReveal").SetExpanded(window.IsShoutExpanded, false);
                Field<ClassroomIslandReveal>(window, "_reveal").SetExpanded(window.IsExpanded, false);
                window.UpdateLayout(); await Task.Delay(20); window.UpdateLayout();
                var reading = Field<Button>(window, "_reading");
                if (state == "details-reading-loading")
                {
                    reading.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    reading.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    if (opened != 1 || reading.IsEnabled || reading.Content?.ToString() != "正在打开…") failures.Add(key + ": pending reading action permits repeated activation");
                    window.UpdateLayout();
                }
                if (state == "details-dimmed" && Field<Border>(window, "_surface").Opacity != 1)
                    failures.Add(key + ": expanded reading surface stays translucent while dimmed");
                if (state is "details-reading-unavailable" or "details-reading-demo")
                {
                    reading.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    if (opened != 0 || reading.IsEnabled || !Field<TextBlock>(window, "_readingUnavailable").IsEffectivelyVisible)
                        failures.Add(key + ": unavailable reading action lacks a visible explanation or still executes");
                }
                var controls = window.GetVisualDescendants().OfType<Control>()
                    .Where(c => c.IsEffectivelyVisible && (c is Button || c is ScrollViewer || c is IslandImportantMessage || c is ClassroomIslandRibbon || c is IslandShoutCard))
                    .Select(c => { var point = c.TranslatePoint(default, window)!.Value; return new { type = c.GetType().Name,
                        label = (c as Button)?.Content is string label ? label : "", x = point.X, y = point.Y, width = c.Bounds.Width, height = c.Bounds.Height }; }).ToArray();
                foreach (var c in controls.Where(c => c.type == nameof(Button)))
                    if (c.x < -.5 || c.y < -.5 || c.x + c.width > window.Bounds.Width + .5 || c.y + c.height > window.Bounds.Height + .5)
                        failures.Add($"{key}: button {c.label} escapes the visible island");
                foreach (var scale in new[] { 1d, 1.25, 1.5, 2 })
                {
                    using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(window.Bounds.Width * scale), (int)Math.Ceiling(window.Bounds.Height * scale)), new Vector(96 * scale, 96 * scale));
                    bitmap.Render(window); bitmap.Save(Path.Combine(output, $"{key}-{scale * 100:0}.png"));
                }
                records.Add(new { key, width = window.Bounds.Width, height = window.Bounds.Height, controls });
                if (ribbon.ImportantExpanded)
                {
                    var expand = window.GetVisualDescendants().OfType<Button>().SingleOrDefault(b => b.Content is IslandImportantMessage);
                    if (expand is null || !expand.IsEffectivelyVisible || !expand.Focusable) failures.Add(key + ": message body has no keyboard-accessible full text action");
                    else
                    {
                        expand.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                        if (!window.IsShoutExpanded || !ribbon.FullTextExpanded || ribbon.ImportantExpanded) failures.Add(key + ": clicking the message body does not switch to a full text summary");
                    }
                }
                if (state == "details")
                {
                    window.GetVisualDescendants().OfType<Button>().Single(b => b.Content?.ToString() == "打开早读").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    if (opened != 1 || window.IsExpanded) failures.Add(key + ": reading action does not open once and collapse");
                }
                if (state == "details-reading-loading")
                {
                    opening.SetResult(); await Task.Delay(10);
                    if (window.IsExpanded || !reading.IsEnabled) failures.Add(key + ": completed reading action does not restore the button and collapse");
                }
                if (state.StartsWith("full-"))
                {
                    var scroll = Field<ScrollViewer>(Field<IslandShoutCard>(window, "_shoutCard"), "_scroll");
                    scroll.Offset = new Vector(0, scroll.Extent.Height); window.UpdateLayout();
                    if (scroll.Extent.Height <= scroll.Viewport.Height || scroll.Offset.Y <= 0) failures.Add(key + ": long message cannot scroll");
                    Field<IslandShoutCard>(window, "_shoutCard").DismissButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    if (acknowledged != 1) failures.Add(key + ": full text acknowledgement does not invoke its action once");
                }
                window.DisposeWindow(); window = null;
            }
            File.WriteAllText(Path.Combine(output, "layout.json"), JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllLines(Path.Combine(output, "failures.txt"), failures);
            Console.WriteLine($"Rendered {records.Count} native states at 100/125/150/200% DPI; {failures.Count} layout or interaction failures. {output}");
            if (failures.Count > 0) { Console.Error.WriteLine(string.Join("\n", failures)); Environment.ExitCode = 1; }
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            window?.DisposeWindow();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

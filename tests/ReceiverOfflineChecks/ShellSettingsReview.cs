using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class ShellSettingsReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(output)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check(string output)
    {
        var checks = new List<string>();
        var windows = new List<Window>();
        void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        try
        {
            foreach (var (width, height) in new[] { (740d, 660d), (600d, 500d) })
            {
                var about = new AboutWindow { Width = width, Height = height }; windows.Add(about); about.Show();
                await Task.Delay(100); about.UpdateLayout();
                var text = about.GetVisualDescendants().OfType<TextBlock>().Where(t => t.IsEffectivelyVisible).Select(t => t.Text).ToArray();
                Assert(text.Contains(AboutContent.GroupAcknowledgement), $"{width}: AI建模社 acknowledgement is visible on the initial page");
                Assert(AboutContent.Acknowledgements.All(p => text.Contains(p.Name)), $"{width}: all six supplied people remain in the acknowledgement list");
                var mascot = about.GetVisualDescendants().OfType<AboutThankYouMascot>().Single();
                mascot.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Task.Delay(1100);
                Assert(DesktopStyle.AnimationsEnabled() ? mascot.IsPlaying && mascot.CurrentFrame == 7 : !mascot.IsPlaying && mascot.CurrentFrame == 0,
                    $"{width}: the thank-you mascot bows on replay and respects reduced motion");
                var licenses = about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "许可与说明");
                licenses.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                await Task.Delay(50); about.UpdateLayout();
                Assert(!mascot.IsPlaying && mascot.CurrentFrame == 0, $"{width}: switching to licences stops the hidden mascot");
                var document = about.GetVisualDescendants().OfType<SelectableTextBlock>().Single();
                Assert(document.IsEffectivelyVisible && document.Text!.Contains("Copyright"), $"{width}: the original application licence remains available");
                foreach (var notice in AboutContent.Notices)
                {
                    var button = about.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == notice.Title);
                    button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    await Task.Delay(20); about.UpdateLayout();
                    Assert(!string.IsNullOrWhiteSpace(document.Text), $"{width}: {notice.Title} loads embedded text");
                    Assert(button.Bounds.Width >= 100 && button.Bounds.Height >= 40, $"{width}: {notice.Title} keeps a readable keyboard target");
                }
                about.Close();
                Assert(!mascot.IsPlaying, $"{width}: closing About releases its animation timer");
            }
            using var agent = new ClassroomAgentService();
            var pending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var called = 0;
            var settings = new ComputerControlSettingsWindow(agent, null, new(), async () =>
            {
                called++; agent.BeginTaskStop(); await pending.Task; agent.CompleteTaskStop(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), true);
            });
            windows.Add(settings); settings.Show(); await Task.Delay(100);
            var stop = settings.GetVisualDescendants().OfType<Button>().Single(b => b.Content as string == "立即停止电脑操作");
            stop.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert(called == 1 && !stop.IsEnabled && stop.Content as string == "正在停止…", "the stop button invokes whole-task cancellation and displays its pending state");
            pending.SetResult(); await Task.Delay(100);
            Assert(stop.IsEnabled && settings.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "本轮任务已停止；已完成的操作不会撤销"), "the stop button displays the completed result and can be used again");
            settings.Width = 440; settings.Height = 600; settings.UpdateLayout();
            Assert(stop.Bounds.Width >= 200 && stop.Bounds.Height >= 40, "the stop action remains readable at the narrow settings width");
            settings.Close();
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "shell-checks.json"), JsonSerializer.Serialize(new { passed = checks.Count, checks }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} shell interaction checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            foreach (var window in windows.Where(w => w.IsVisible)) window.Close();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class GeneralComputerControlReview
{
    internal static void Run(string output)
    {
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            var thread = new Thread(() => Run(output));
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start(); thread.Join(); return;
        }
        AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Capture(Path.GetFullPath(output))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
    }

    private static async Task Capture(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var worker = new ClassroomAgentWorker();
        Window? window = null;
        void Check(bool condition, string label) { if (!condition) throw new Exception(label); checks.Add(label); }
        JsonElement Args(object value) => JsonSerializer.SerializeToElement(value);
        try
        {
            var title = new TextBox { Text = "原来的标题" }; AutomationProperties.SetName(title, "课程标题");
            var password = new TextBox { Text = "fixture-private-password", PasswordChar = '*' }; AutomationProperties.SetName(password, "验收密码");
            var enabled = new CheckBox { Content = "开启课堂提醒", IsChecked = false };
            var volume = new Slider { Minimum = 0, Maximum = 100, Value = 25 }; AutomationProperties.SetName(volume, "朗读音量");
            var subject = new ComboBox { ItemsSource = new[] { "数学", "英语" }, SelectedIndex = 0 };
            AutomationProperties.SetName(subject, "任教学科");
            var status = new TextBlock { Text = "尚未保存" };
            var save = new Button { Content = "保存课程" };
            save.Click += (_, _) => status.Text = "已保存课程：" + title.Text;
            var branch = new TreeViewItem { Header = "教学资料", ItemsSource = new[] { "数学", "英语" } };
            AutomationProperties.SetName(branch, "教学资料");
            var tree = new TreeView { ItemsSource = new[] { branch }, Height = 90 };
            var scroll = new ScrollViewer { Height = 110, Content = new StackPanel { Children =
                { new TextBlock { Text = string.Join('\n', Enumerable.Range(1, 60).Select(n => "第" + n + "条课堂记录")) } } } };
            AutomationProperties.SetName(scroll, "课堂记录");
            var first = new TabItem { Header = "课堂安排", Content = new StackPanel { Spacing = 8, Children =
                { new TextBlock { Text = "本周课堂安排" }, title, password, enabled, volume, subject, tree, scroll, save, status } } };
            Window? popup = null;
            var openPopup = new Button { Content = "打开结果窗口" };
            openPopup.Click += (_, _) => {
                var closePopup = new Button { Content = "关闭结果窗口" };
                popup = new Window { Title = "班班通用临时结果", Width = 320, Height = 180, Content = closePopup };
                closePopup.Click += (_, _) => popup.Close();
                popup.Show(window!);
            };
            var second = new TabItem { Header = "资料设置", Content = new StackPanel { Children = {
                new TextBlock { Text = "资料设置已打开" }, openPopup,
                new TextBlock { Text = new string('课', 140) + "资料检查已经完成" },
                new TextBox { Text = new string('例', 650) + "完整课程资料已就绪", Name = "longCourseText" } } } };
            var tabs = new TabControl { ItemsSource = new[] { first, second }, SelectedIndex = 0 };
            window = new Window { Title = "班班通用操作验收", Width = 700, Height = 760, Content = tabs };
            window.Show();
            await Task.Delay(200);
            using var process = Process.GetCurrentProcess();
            IReadOnlyList<AgentApplication> apps = [new("general-fixture", "通用验收", "application", process.MainModule!.FileName)];
            async Task<JsonObject> Send(string action, object args)
            {
                using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(18));
                return await worker.OperateAsync(action, Args(args), apps, limit.Token);
            }
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var desktop = await worker.InspectAsync(apps, startup.Token);
            var id = desktop["windows"]!.AsArray().Single(w => w?["title"]?.GetValue<string>() == window.Title)!["id"]!.GetValue<string>();
            var snapshot = await Send("inspect_controls", new { targetId = id });
            File.WriteAllText(Path.Combine(output, "initial-controls.json"), snapshot.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            JsonNode Find(JsonObject state, string name) => state["controls"]!.AsArray().First(c => c?["name"]?.GetValue<string>() == name)!;
            string Control(JsonObject state, string name) => Find(state, name)["id"]!.GetValue<string>();
            Check(snapshot["controls"]!.AsArray().Any(c => c?["name"]?.GetValue<string>() == "本周课堂安排"), "read-only page text is available for reasoning");
            Check(Find(snapshot, "课程标题")["value"]?.GetValue<string>() == "原来的标题", "current input value is observed");
            Check(!snapshot.ToJsonString().Contains("fixture-private-password") && !snapshot["controls"]!.AsArray().Any(c => c?["name"]?.GetValue<string>() == "验收密码"), "password fields and values are excluded");

            var changed = await Send("set_control_value", new { targetId = id, controlId = Control(snapshot, "课程标题"), text = "今天开始上课" });
            Check(title.Text == "今天开始上课" && changed["verified"]?.GetValue<bool>() == true,
                $"generic text field is filled and read back (actual={title.Text}; verified={changed["verified"]})");
            Check(Find(changed, "课程标题")["value"]?.GetValue<string>() == title.Text, "action receipt includes the fresh interface");
            var toggled = await Send("set_control_toggle", new { targetId = id, controlId = Control(changed, "开启课堂提醒"), @checked = true });
            Check(enabled.IsChecked == true && toggled["verified"]?.GetValue<bool>() == true, "checkbox reaches the requested state");
            var repeated = await Send("set_control_toggle", new { targetId = id, controlId = Control(toggled, "开启课堂提醒"), @checked = true });
            Check(enabled.IsChecked == true && repeated["verified"]?.GetValue<bool>() == true, "setting a checkbox twice does not reverse the state");
            var ranged = await Send("set_control_range", new { targetId = id, controlId = Control(repeated, "朗读音量"), value = 65 });
            Check(volume.Value == 65 && ranged["verified"]?.GetValue<bool>() == true, "generic slider is set within its reported range");
            var expanded = await Send("expand_control", new { targetId = id, controlId = Control(ranged, "任教学科") });
            File.WriteAllText(Path.Combine(output, "dropdown-state.json"), JsonSerializer.Serialize(new { open = subject.IsDropDownOpen,
                receipt = expanded["verified"]?.GetValue<bool>(), state = Find(expanded, "任教学科")["expandState"]?.GetValue<string>() }));
            Check(subject.IsDropDownOpen && expanded["verified"]?.GetValue<bool>() == true,
                $"generic dropdown expands with observed state (open={subject.IsDropDownOpen}; verified={expanded["verified"]})");
            var collapsed = await Send("collapse_control", new { targetId = id, controlId = Control(expanded, "任教学科") });
            Check(!subject.IsDropDownOpen && collapsed["verified"]?.GetValue<bool>() == true, "generic dropdown collapses with observed state");
            var keyboard = await Send("press_control_key", new { targetId = id, controlId = Control(collapsed, "教学资料"), key = "right" });
            Check(branch.IsExpanded, "standard navigation keys operate a control without an expansion provider");
            Check(keyboard["verified"]?.GetValue<bool>() == false, "a navigation key alone does not invent an application result");
            collapsed = await Send("press_control_key", new { targetId = id, controlId = Control(keyboard, "教学资料"), key = "left" });
            Check(!branch.IsExpanded, "keyboard navigation remains bound to the selected control");
            var scrolled = await Send("scroll_control", new { targetId = id, controlId = Control(collapsed, "课堂记录"), direction = "down" });
            Check(scroll.Offset.Y > 0 && scrolled["verified"]?.GetValue<bool>() == true, "scroll uses the selected region and checks movement");
            var before = scroll.Offset.Y;
            await Send("scroll_control", new { targetId = id, controlId = Control(scrolled, "课堂记录"), direction = "down" });
            Check(scroll.Offset.Y > before, "a second deliberate scroll executes again");
            snapshot = await Send("inspect_controls", new { targetId = id });
            var invoked = await Send("invoke_control", new { targetId = id, controlId = Control(snapshot, "保存课程") });
            Check(status.Text == "已保存课程：今天开始上课", "generic button executes the application handler");
            Check(invoked["verified"]?.GetValue<bool>() == false, "button dispatch alone is not claimed as business success");
            Check(invoked["controls"]!.AsArray().Any(c => c?["name"]?.GetValue<string>() == status.Text), "button receipt contains the application's actual result text");
            var waited = await Send("wait_for_control", new { targetId = id, query = "已保存课程" });
            Check(waited["verified"]?.GetValue<bool>() == true, "an explicit condition verifies the observed result");
            snapshot = await Send("inspect_controls", new { targetId = id });
            var confirmed = await Send("invoke_control", new { targetId = id, controlId = Control(snapshot, "保存课程"), query = "已保存课程：今天开始上课" });
            Check(confirmed["verified"]?.GetValue<bool>() == true, "a button with an explicit application result is verified against that text");
            snapshot = await Send("inspect_controls", new { targetId = id });
            var selected = await Send("select_control", new { targetId = id, controlId = Control(snapshot, "资料设置") });
            Check(tabs.SelectedIndex == 1 && selected["verified"]?.GetValue<bool>() == true, "generic tab selection is observed");
            Check(selected["controls"]!.AsArray().Any(c => c?["name"]?.GetValue<string>() == "资料设置已打开"), "new tab contents are immediately available");
            var longResult = await Send("wait_for_control", new { targetId = id, query = "资料检查已经完成" });
            Check(longResult["verified"]?.GetValue<bool>() == true && longResult["controls"]!.AsArray().Any(c => c?["name"]?.GetValue<string>()?.Contains("资料检查已经完成") == true), "a result beyond the initial text excerpt is searchable and visible in its receipt");
            var longValue = await Send("inspect_controls", new { targetId = id, query = "完整课程资料已就绪" });
            Check(longValue["controls"]!.AsArray().Any(c => c?["value"]?.GetValue<string>()?.Contains("完整课程资料已就绪") == true), "long field values remain searchable without sending the entire value");
            selected = await Send("inspect_controls", new { targetId = id });
            var rejected = false;
            try { await Send("set_control_value", new { targetId = id, controlId = Control(invoked, "课程标题"), text = "不应写入" }); }
            catch (InvalidOperationException) { rejected = true; }
            Check(rejected && title.Text == "今天开始上课", "a field from the previous page cannot receive stale input");
            var opened = await Send("invoke_control", new { targetId = id, controlId = Control(selected, "打开结果窗口") });
            var popupState = opened["windows"]!.AsArray().Single(w => w?["title"]?.GetValue<string>() == "班班通用临时结果")!;
            Check(popup?.IsVisible == true, "a generic button's new owned window is returned to the planner");
            var popupId = popupState["id"]!.GetValue<string>();
            var popupControls = await Send("inspect_controls", new { targetId = popupId });
            var popupClosed = await Send("invoke_control", new { targetId = popupId, controlId = Control(popupControls, "关闭结果窗口") });
            Check(popup?.IsVisible == false && popupClosed["performed"]?.GetValue<bool>() == true, "a button that closes its own dialog returns an observation rather than a false failure");
            Check(popupClosed["windows"]!.AsArray().All(w => w?["id"]?.GetValue<string>() != popupId), "dialog disappearance is reflected in the returned windows");
            var missing = await Send("wait_for_control", new { targetId = id, query = "不会出现的验收结果" });
            Check(missing["verified"]?.GetValue<bool>() == false, "an absent condition never reports success");
            File.WriteAllText(Path.Combine(output, "general-checks.json"), JsonSerializer.Serialize(checks, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"{checks.Count} general computer-control checks passed.");
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally
        {
            window?.Close(); worker.Reset();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

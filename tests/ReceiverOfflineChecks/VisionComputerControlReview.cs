using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class VisionComputerControlReview
{
    internal static void Run(string output, string? binding = null) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output), binding)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private sealed class LessonCanvas : Control
    {
        internal string Lesson = "原来的课程";
        internal string Saved = "";
        internal int SaveCount, ScrollCount, DragPosition = 60;
        internal bool Reminder;
        private bool _editing, _selected, _dragging;
        internal event Action? Changed;
        internal static readonly Rect Field = new(40, 110, 660, 58);
        internal static readonly Rect Save = new(40, 230, 160, 52);
        internal LessonCanvas() { Focusable = true; MinWidth = 740; MinHeight = 480; }
        private void Update() { InvalidateVisual(); Changed?.Invoke(); }
        private static void Text(DrawingContext context, string value, double x, double y, double size = 20, IBrush? color = null) =>
            context.DrawText(new FormattedText(value, CultureInfo.GetCultureInfo("zh-CN"), FlowDirection.LeftToRight,
                new Typeface("Microsoft YaHei UI"), size, color ?? Brushes.Black), new Point(x, y));
        public override void Render(DrawingContext context)
        {
            base.Render(context);
            context.DrawRectangle(Brushes.White, null, Bounds.WithX(0).WithY(0));
            Text(context, "课堂安排 · 视觉验收", 40, 24, 28);
            Text(context, "课程标题", 40, 77, 17);
            context.DrawRectangle(_selected ? Brushes.LightBlue : Brushes.WhiteSmoke, new Pen(Brushes.Gray), Field);
            Text(context, Lesson, 54, 125, 22);
            context.DrawRectangle(Brushes.DodgerBlue, null, Save);
            Text(context, "保存课程", 62, 241, 21, Brushes.White);
            context.DrawRectangle(Reminder ? Brushes.DodgerBlue : Brushes.White, new Pen(Brushes.Gray), new Rect(260, 242, 24, 24));
            if (Reminder)
            {
                var check = new Pen(Brushes.White, 3);
                context.DrawLine(check, new Point(265, 253), new Point(270, 258));
                context.DrawLine(check, new Point(270, 258), new Point(279, 248));
            }
            Text(context, "开启课堂提醒", 297, 240, 19);
            Text(context, Saved.Length > 0 ? "已保存：" + Saved : "尚未保存", 40, 302, 20, Brushes.DarkGreen);
            context.DrawRectangle(Brushes.LightGray, null, new Rect(40, 366, 600, 8));
            context.DrawEllipse(Brushes.DodgerBlue, null, new Point(DragPosition, 370), 12, 12);
            Text(context, "滚动计数：" + ScrollCount, 40, 420, 17);
        }
        protected override void OnPointerPressed(PointerPressedEventArgs e)
        {
            base.OnPointerPressed(e);
            var point = e.GetPosition(this); Focus(); _selected = false;
            _editing = Field.Contains(point);
            if (Save.Contains(point)) { Saved = Lesson; SaveCount++; }
            if (new Rect(250, 230, 260, 52).Contains(point)) Reminder = !Reminder;
            if (new Rect(40, 350, 600, 40).Contains(point)) { _dragging = true; e.Pointer.Capture(this); }
            Update();
        }
        protected override void OnPointerMoved(PointerEventArgs e)
        {
            base.OnPointerMoved(e);
            if (_dragging) { DragPosition = (int)Math.Clamp(e.GetPosition(this).X, 40, 640); Update(); }
        }
        protected override void OnPointerReleased(PointerReleasedEventArgs e)
        { base.OnPointerReleased(e); _dragging = false; e.Pointer.Capture(null); }
        protected override void OnPointerWheelChanged(PointerWheelEventArgs e)
        { base.OnPointerWheelChanged(e); ScrollCount += (int)-e.Delta.Y; Update(); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (_editing && e.Key == Key.A && e.KeyModifiers.HasFlag(KeyModifiers.Control)) { _selected = true; e.Handled = true; Update(); }
        }
        protected override void OnTextInput(TextInputEventArgs e)
        {
            base.OnTextInput(e);
            if (!_editing) return;
            Lesson = (_selected ? "" : Lesson) + e.Text; _selected = false; e.Handled = true; Update();
        }
    }

    private static async Task Review(string output, string? bindingPath)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        var worker = new ClassroomAgentWorker();
        Window? window = null;
        CloudReceiverService? receiver = null;
        SpeechService? speech = null;
        void Check(bool value, string name) { if (!value) throw new Exception(name); checks.Add(name); }
        try
        {
            var canvas = new LessonCanvas();
            window = new Window { Title = "班班视觉验收窗口", Width = 820, Height = 580, Content = canvas };
            ClassroomStyle.Apply(window);
            void State() => File.WriteAllText(Path.Combine(output, "actual-state.json"), JsonSerializer.Serialize(new
                { text = canvas.Lesson, saved = canvas.Saved, saves = canvas.SaveCount, reminder = canvas.Reminder,
                  scroll = canvas.ScrollCount, drag = canvas.DragPosition, pid = Environment.ProcessId }));
            canvas.Changed += State;
            window.Show(); State(); await Task.Delay(400);
            using var process = Process.GetCurrentProcess();
            var application = new AgentApplication(ClassroomAgentPolicy.Identity(process.MainModule!.FileName), "班班视觉验收", "application", process.MainModule.FileName);
            AgentApplication[] apps = [application];
            if (bindingPath is not null)
            {
                var binding = JsonSerializer.Deserialize<ReceiverConfig>(File.ReadAllText(bindingPath))!;
                if (binding.Endpoint != "http://127.0.0.1:8866") throw new Exception("Vision live review is limited to isolated localhost:8866.");
                speech = new SpeechService();
                receiver = new CloudReceiverService(speech, new ClassroomAgentService(() => new ClassroomAgentPolicy { AllowAllFolders = false, Applications = [application.Path] }));
                await receiver.StartAsync(binding);
                File.WriteAllText(Path.Combine(output, "ready.json"), JsonSerializer.Serialize(new { pid = Environment.ProcessId, title = window.Title }));
                var until = Stopwatch.StartNew(); var closed = false; window.Closed += (_, _) => closed = true;
                while (!closed && until.Elapsed.TotalMinutes < 12 && !File.Exists(Path.Combine(output, "shutdown"))) await Task.Delay(250);
            }
            else
            {
                var inspected = await worker.InspectAsync(apps, CancellationToken.None);
                var id = inspected["windows"]!.AsArray().Single(w => w!["title"]!.GetValue<string>() == window.Title)!["id"]!.GetValue<string>();
                Task<JsonObject> Capture() => worker.OperateAsync("capture_window", JsonSerializer.SerializeToElement(new { targetId = id }), apps, CancellationToken.None);
                JsonObject Input(JsonObject frame, object fields)
                {
                    var value = JsonSerializer.SerializeToNode(fields)!.AsObject();
                    value["targetId"] = id; value["screenshotId"] = frame["screenshot"]!["id"]!.GetValue<string>(); return value;
                }
                Task<JsonObject> Send(string action, JsonObject frame, object fields) => worker.OperateAsync(action,
                    JsonSerializer.SerializeToElement(Input(frame, fields)), apps, CancellationToken.None);
                (int X, int Y) Point(JsonObject frame, double x, double y)
                {
                    var screen = canvas.PointToScreen(new Point(x, y));
                    GetWindowRect(window.TryGetPlatformHandle()!.Handle, out var rect);
                    return ((int)((screen.X - rect.left) * (double)frame["screenshot"]!["width"]!.GetValue<int>() / (rect.right - rect.left)),
                            (int)((screen.Y - rect.top) * (double)frame["screenshot"]!["height"]!.GetValue<int>() / (rect.bottom - rect.top)));
                }
                async Task Reject(Func<Task> action, string name)
                {
                    try { await action(); throw new Exception("Unexpected acceptance: " + name); }
                    catch (InvalidOperationException) { checks.Add(name); }
                }
                var frame = await Capture(); var screenshot = frame["screenshot"]!;
                var bytes = Convert.FromBase64String(screenshot["dataUrl"]!.GetValue<string>().Split(',', 2)[1]);
                Check(bytes.Length <= 512 * 1024 && bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }), "actual selected window produces a bounded PNG");
                Check(screenshot["width"]!.GetValue<int>() <= 1280 && screenshot["height"]!.GetValue<int>() <= 1280, "image dimensions are bounded");
                File.WriteAllBytes(Path.Combine(output, "fixture-window.png"), bytes);
                var field = Point(frame, 230, 136);
                var clicked = await Send("click_window", frame, new { x = field.X, y = field.Y });
                await Reject(() => Send("click_window", frame, new { x = field.X, y = field.Y }), "a screenshot cannot authorize repeated input");
                Check(clicked["screenshot"]?["dataUrl"] is not null && clicked["textInputReady"]?.GetValue<bool>() == true,
                    "click returns a fresh image and actual preserved input focus");
                frame = await Send("press_window_key", clicked, new { key = "ctrl_a" });
                // The selected text must stay selected during this input.
                frame = await Send("type_window_text", frame, new { text = "视觉课程" });
                Check(canvas.Lesson == "视觉课程", "screenshot-relative text input replaces the actual canvas field");
                var save = Point(frame, 120, 256);
                await Send("click_window", frame, new { x = save.X, y = save.Y });
                Check(canvas.Saved == "视觉课程" && canvas.SaveCount == 1, "actual custom canvas save button executes once");
                frame = await Capture(); var toggle = Point(frame, 272, 254);
                var beforeToggle = frame["screenshot"]!["dataUrl"]!.GetValue<string>();
                var toggled = await Send("click_window", frame, new { x = toggle.X, y = toggle.Y });
                Check(canvas.Reminder, "coordinate click operates a custom canvas checkbox");
                var afterToggle = toggled["screenshot"]!["dataUrl"]!.GetValue<string>();
                File.WriteAllBytes(Path.Combine(output, "fixture-after.png"), Convert.FromBase64String(afterToggle.Split(',', 2)[1]));
                Check(beforeToggle != afterToggle, "post-action screenshot contains the changed canvas pixels");
                frame = await Capture(); var scroll = Point(frame, 400, 420);
                await Send("scroll_window", frame, new { x = scroll.X, y = scroll.Y, amount = 360 });
                Check(canvas.ScrollCount > 0, "scroll is delivered inside the selected window");
                frame = await Capture(); var start = Point(frame, 60, 370); var end = Point(frame, 360, 370);
                await Send("drag_window", frame, new { x = start.X, y = start.Y, toX = end.X, toY = end.Y });
                Check(canvas.DragPosition >= 350, "drag moves the actual canvas handle");
                frame = await Capture();
                await Reject(() => Send("click_window", frame, new { x = -1, y = 50 }), "negative coordinates are rejected");
                await Reject(() => Send("press_window_key", frame, new { key = "win_r" }), "arbitrary global key chords are rejected");
                window.Width += 70; await Task.Delay(150);
                await Reject(() => Send("click_window", frame, new { x = save.X, y = save.Y }), "resized windows invalidate coordinates");
                using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
                try { await worker.OperateAsync("capture_window", JsonSerializer.SerializeToElement(new { targetId = id }), apps, cancelled.Token); throw new Exception("Cancellation was ignored."); }
                catch (OperationCanceledException) { checks.Add("cancellation stops observation before further input"); }
                State();
            }
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} vision checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            worker.Reset(); if (receiver is not null) await receiver.StopAsync(); speech?.Dispose(); window?.Close();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint handle, out RECT rect);
}

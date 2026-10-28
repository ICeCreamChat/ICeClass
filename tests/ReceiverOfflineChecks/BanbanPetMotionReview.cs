using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;
using SkiaSharp;

internal static class BanbanPetMotionReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static double Distance(Point a, Point b) => ((Vector)(a - b)).Length;
    private static bool Finite(BanbanPetPose pose) => typeof(BanbanPetPose).GetFields(BindingFlags.Instance | BindingFlags.NonPublic)
        .All(field => double.IsFinite((double)field.GetValue(pose)!));

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? window = null; BanbanPetMascot? mascot = null;
        void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks.Add(name); }
        try
        {
            foreach (var action in BanbanPetMotion.Actions)
            {
                var motion = new BanbanPetMotion(); motion.Play(action.Id);
                var finite = true; var maximumStep = 0d; var previous = BanbanPetMotion.RightWrist(motion.Pose);
                for (var i = 0; i < (action.Seconds + 1) * 60; i++)
                {
                    var p = motion.Advance(1d / 60); var wrist = BanbanPetMotion.RightWrist(p);
                    maximumStep = Math.Max(maximumStep, Distance(previous, wrist)); previous = wrist; finite &= Finite(p);
                }
                Check(finite && maximumStep < 42 && motion.Gesture == "" && Math.Abs(motion.Pose.Think) < .002,
                    action.Id + " has a bounded continuous wrist path and finishes without a held pose");
            }
            var interrupted = new BanbanPetMotion(); interrupted.SetState("thinking");
            for (var i = 0; i < 50; i++) interrupted.Advance(1d / 60);
            var before = interrupted.Pose; interrupted.SetState("speaking"); interrupted.Play("stop");
            Check(Distance(BanbanPetMotion.RightWrist(before), BanbanPetMotion.RightWrist(interrupted.Pose)) == 0,
                "interrupting a thought preserves the current painted hand position");
            var interruptionStep = 0d; var wristBefore = BanbanPetMotion.RightWrist(before);
            for (var i = 0; i < 150; i++)
            {
                var pose = interrupted.Advance(1d / 60); var wrist = BanbanPetMotion.RightWrist(pose);
                interruptionStep = Math.Max(interruptionStep, Distance(wristBefore, wrist)); wristBefore = wrist;
            }
            Check(interruptionStep < 42 && interrupted.Pose.Think < .002,
                "the hand lowers from thought into a new action without a threshold jump");
            var frozen = interrupted.Advance(.03, reduced: true);
            Check(Enumerable.Range(0, 120).All(_ => interrupted.Advance(.03, reduced: true).Equals(frozen)),
                "reduced motion keeps the expression while stopping spatial and looping movement");
            var slow = new BanbanPetMotion(); slow.Play("stretch");
            Check(Finite(slow.Advance(12)), "a delayed frame cannot destabilize the springs");
            var leftWake = new BanbanPetMotion(); var rightWake = new BanbanPetMotion();
            leftWake.Play("wake", false); rightWake.Play("wake", true);
            var lp = leftWake.Advance(.05); var rp = rightWake.Advance(.05);
            Check(Math.Abs(lp.OffsetX + rp.OffsetX) < .001 && lp.Hop == rp.Hop,
                "waking from either screen edge retains the same vertical timing");
            Check(!slow.Play("missing-action"), "an unknown gesture leaves the current action intact");

            mascot = new BanbanPetMascot { Width = 256, Height = 288, Animate = false };
            window = new Window { Width = 256, Height = 288, Content = mascot, ShowActivated = false,
                ShowInTaskbar = false, SystemDecorations = SystemDecorations.None, Background = Brushes.Transparent };
            window.Show(); await Task.Delay(80);
            Check(mascot.AssetsLoaded, "all painted body, eye and arm resources load from the existing receiver");
            int[] InspectFace(double width, double height, double dpi, bool wink = false)
            {
                mascot.Width = width; mascot.Height = height;
                mascot.Measure(new Size(width, height)); mascot.Arrange(new Rect(0, 0, width, height));
                var pose = BanbanPetPose.Rest; if (wink) pose.CloseLeft = 1;
                mascot.ReviewPose = pose;
                using var bitmap = new RenderTargetBitmap(new PixelSize((int)(width * dpi / 96), (int)(height * dpi / 96)), new Vector(dpi, dpi));
                bitmap.Render(mascot); bitmap.Save(Path.Combine(output, $"face-{width:0}-{dpi:0}{(wink ? "-wink" : "")}.png"));
                using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                using var pixels = SKBitmap.Decode(stream);
                var scale = Math.Min(width / 716, height / 800);
                Point Pixel(Point q) => new(((q.X + 28) * scale + (width - 716 * scale) / 2) * dpi / 96,
                    ((q.Y + 35) * scale + (height - 800 * scale) / 2) * dpi / 96);
                // The face must remain painted around both eyes. Loading an iris alone
                // does not detect a body texture rendered at a different scale.
                foreach (var (name, x, y) in new[] { ("left", 175d, 260d), ("right", 500d, 260d), ("lower", 440d, 460d) })
                {
                    var point = Pixel(new(x, y)); var color = pixels.GetPixel((int)point.X, (int)point.Y);
                    Check(color.Alpha > 240 && color.Red > 210 && color.Green > 190,
                        $"{width:0}px/{dpi:0}dpi {name} face landmark keeps the original opaque cream cover beneath the features");
                }
                var eyes = new List<int>();
                foreach (var rect in new[] { new Rect(187, 217, 106, 91), new Rect(378, 225, 106, 91) })
                {
                    var start = Pixel(rect.TopLeft); var end = Pixel(rect.BottomRight); var painted = 0;
                    for (var y = (int)start.Y; y < end.Y; y++) for (var x = (int)start.X; x < end.X; x++)
                    {
                        var c = pixels.GetPixel(x, y);
                        if (c.Alpha > 200 && c.Blue > c.Red * 1.12 && c.Blue > c.Green * .9 && c.Blue > 65) painted++;
                    }
                    eyes.Add(painted);
                }
                if (!wink) Check(eyes.All(count => count > 1300 * Math.Pow(scale * dpi / 96, 2)),
                    $"{width:0}px/{dpi:0}dpi both painted eyes remain visible at the actual pet size");
                return eyes.ToArray();
            }
            InspectFace(52, 62, 96); InspectFace(52, 62, 192); InspectFace(116, 130, 96); InspectFace(116, 130, 192);
            var openEyes = InspectFace(256, 288, 96); var winkEyes = InspectFace(256, 288, 96, wink: true);
            Check(winkEyes[0] < openEyes[0] * .5 && Math.Abs(winkEyes[1] - openEyes[1]) < 8,
                "a wink closes only the left painted iris and preserves the other eye");
            var renderTimes = new List<double>();
            foreach (var action in BanbanPetMotion.Actions)
            {
                var motion = new BanbanPetMotion(); motion.Play(action.Id);
                var folder = Path.Combine(output, action.Id); Directory.CreateDirectory(folder);
                var count = (int)Math.Ceiling((action.Seconds + .85) * 20);
                for (var i = 0; i < count; i++)
                {
                    mascot.ReviewPose = motion.Advance(.05); mascot.InvalidateVisual();
                    using var bitmap = new RenderTargetBitmap(new PixelSize(256, 288), new Vector(96, 96));
                    var timer = Stopwatch.StartNew(); bitmap.Render(mascot); timer.Stop(); renderTimes.Add(timer.Elapsed.TotalMilliseconds);
                    bitmap.Save(Path.Combine(folder, $"{i:D4}.png"));
                    if (i % 15 == 0) await Task.Delay(1);
                }
                Console.WriteLine("RENDERED " + action.Id);
            }
            // A real state sequence includes two interruptions, rather than only isolated loops.
            var chain = new BanbanPetMotion();
            var chainFolder = Path.Combine(output, "conversation"); Directory.CreateDirectory(chainFolder);
            var frame = 0;
            foreach (var (state, action, seconds) in new[] {
                ("listening", "wake", 1.1), ("listening", "listen", 1.5), ("thinking", "think", 1.6),
                ("speaking", "explain", 2d), ("listening", "stop", 1d), ("thinking", "think", 1.2),
                ("speaking", "nod", 1.4), ("listening", "wave", 2.8) })
            {
                chain.SetState(state); chain.Play(action);
                for (var i = 0; i < seconds * 20; i++)
                {
                    mascot.ReviewPose = chain.Advance(.05); mascot.InvalidateVisual();
                    using var bitmap = new RenderTargetBitmap(new PixelSize(256, 288), new Vector(96, 96));
                    bitmap.Render(mascot); bitmap.Save(Path.Combine(chainFolder, $"{frame++:D4}.png"));
                }
            }
            renderTimes.Sort();
            var report = new { passed = true, checks, actions = BanbanPetMotion.Actions,
                renderMillisecondsMedian = renderTimes[renderTimes.Count / 2], renderMillisecondsP95 = renderTimes[(int)(renderTimes.Count * .95)],
                frames = renderTimes.Count + frame, note = "Production native renderer at 256 x 288; microphone and task execution are not exercised." };
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"PASS {checks.Count} continuous motion checks; {report.frames} native frames");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            window?.Close(); mascot?.Dispose();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }

    internal static void Playground() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(_ => Dispatcher.UIThread.Post(() =>
        {
            var motion = new BanbanPetMotion();
            var mascot = new BanbanPetMascot { Width = 300, Height = 336, Animate = false };
            var select = new ComboBox { ItemsSource = BanbanPetMotion.Actions.Select(action => action.Title).ToArray(),
                HorizontalAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetName(select, "选择班班动作");
            var replay = new Button { Content = "再播放一次", HorizontalAlignment = HorizontalAlignment.Stretch };
            var auto = new CheckBox { Content = "连续播放", IsChecked = true };
            var status = ClassroomStyle.Text("", 14); var phase = 0d;
            void Play() { var action = BanbanPetMotion.Actions[Math.Max(0, select.SelectedIndex)]; motion.Play(action.Id); phase = 0; status.Text = action.Title; }
            select.SelectionChanged += (_, _) => Play(); replay.Click += (_, _) => Play(); select.SelectedIndex = 0;
            var reduced = !ClassroomIslandReveal.AnimationsEnabled();
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
            var last = Stopwatch.GetTimestamp();
            timer.Tick += (_, _) =>
            {
                var now = Stopwatch.GetTimestamp(); var dt = Math.Min(.08, Stopwatch.GetElapsedTime(last, now).TotalSeconds); last = now;
                phase += dt; mascot.ReviewPose = motion.Advance(dt); mascot.InvalidateVisual();
                if (auto.IsChecked == true && phase > BanbanPetMotion.Actions[Math.Max(0, select.SelectedIndex)].Seconds + .75)
                    select.SelectedIndex = (select.SelectedIndex + 1) % BanbanPetMotion.Actions.Length;
            };
            if (!reduced) timer.Start();
            else { mascot.ReviewPose = motion.Advance(0, true); status.Text = "已遵循系统减少动画设置"; }
            var stage = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(16), Padding = new Thickness(20),
                Child = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, Children = { mascot, status } } };
            var window = new Window { Title = "班班 · 连续动作预览", Width = 460, Height = 650,
                MinWidth = 390, MinHeight = 600, Background = DesktopStyle.Brush("#F4F7FB"),
                Content = new StackPanel { Margin = new Thickness(24), Spacing = 16, Children = { stage, select, replay, auto } } };
            ClassroomStyle.Apply(window);
            window.Closed += (_, _) => { timer.Stop(); mascot.Dispose(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); };
            window.Show();
        }))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
}

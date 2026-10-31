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

    private static double Area(Point a, Point b, Point c)
        => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);

    private static List<(Point A, Point B, Point C)> PaintedRightArmTriangles()
    {
        using var stream = typeof(BanbanPetMascot).Assembly.GetManifestResourceStream("ICeClass.Island.banban.arm-right.webp")!;
        using var art = SKBitmap.Decode(stream);
        var triangles = new List<(Point, Point, Point)>();
        Point Vertex(int x, int y) => new(540 + 114d * x / 4, 410 + 170d * y / 12);
        void Add(Point a, Point b, Point c)
        {
            var x = (a.X + b.X + c.X) / 3; var y = (a.Y + b.Y + c.Y) / 3;
            var pixelX = Math.Clamp((int)((x - 540) / 114 * art.Width), 0, art.Width - 1);
            var pixelY = Math.Clamp((int)((y - 410) / 170 * art.Height), 0, art.Height - 1);
            if (art.GetPixel(pixelX, pixelY).Alpha > 128) triangles.Add((a, b, c));
        }
        for (var y = 0; y < 12; y++) for (var x = 0; x < 4; x++)
        {
            var a = Vertex(x, y); var b = Vertex(x + 1, y);
            var c = Vertex(x, y + 1); var d = Vertex(x + 1, y + 1);
            Add(a, b, d); Add(a, d, c);
        }
        return triangles;
    }

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? window = null; BanbanPetMascot? mascot = null;
        void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks.Add(name); }
        try
        {
            var armTriangles = PaintedRightArmTriangles();
            foreach (var action in BanbanPetMotion.Actions)
            {
                var motion = new BanbanPetMotion(); motion.Play(action.Id);
                var finite = true; var maximumStep = 0d; var previous = BanbanPetMascot.RightArm(motion.Pose).Wrist;
                var inspectArm = action.Id is "point-right" or "explain" or "shrug" or "hop" or "stretch" or "awaken";
                var minimumArea = 1d; var palmError = 0d;
                for (var i = 0; i < (action.Seconds + 1) * 60; i++)
                {
                    var p = motion.Advance(1d / 60); var arm = BanbanPetMascot.RightArm(p); var wrist = arm.Wrist;
                    maximumStep = Math.Max(maximumStep, Distance(previous, wrist)); previous = wrist; finite &= Finite(p);
                    if (!inspectArm) continue;
                    foreach (var (a, b, c) in armTriangles)
                        minimumArea = Math.Min(minimumArea, Area(BanbanPetMascot.SkinRight(a, arm),
                            BanbanPetMascot.SkinRight(b, arm), BanbanPetMascot.SkinRight(c, arm)) / Area(a, b, c));
                    var palmA = new Point(610, 540); var palmB = new Point(638, 552); var palmC = new Point(624, 568);
                    foreach (var (a, b) in new[] { (palmA, palmB), (palmB, palmC), (palmA, palmC) })
                        palmError = Math.Max(palmError, Math.Abs(Distance(BanbanPetMascot.SkinRight(a, arm),
                            BanbanPetMascot.SkinRight(b, arm)) - Distance(a, b)));
                }
                Check(finite && maximumStep < 42 && motion.Gesture == "" && Math.Abs(motion.Pose.Think) < .002,
                    action.Id + " has a bounded continuous wrist path and finishes without a held pose");
                if (inspectArm)
                {
                    Check(minimumArea > .1, $"{action.Id} painted elbow never folds over or collapses (minimum signed area {minimumArea:0.000})");
                    Check(palmError < .001, action.Id + " keeps the painted palm and thumb rigid throughout the gesture");
                }
            }
            var interrupted = new BanbanPetMotion(); interrupted.SetState("thinking");
            for (var i = 0; i < 50; i++) interrupted.Advance(1d / 60);
            var before = interrupted.Pose; interrupted.SetState("speaking"); interrupted.Play("stop");
            Check(Distance(BanbanPetMascot.RightArm(before).Wrist, BanbanPetMascot.RightArm(interrupted.Pose).Wrist) == 0,
                "interrupting a thought preserves the current painted hand position");
            var interruptionStep = 0d; var wristBefore = BanbanPetMascot.RightArm(before).Wrist;
            for (var i = 0; i < 150; i++)
            {
                var pose = interrupted.Advance(1d / 60); var wrist = BanbanPetMascot.RightArm(pose).Wrist;
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
            var greeting = new BanbanPetMotion(); greeting.SetState("listening"); greeting.Play("wake");
            for (var i = 0; i < 50; i++) greeting.Advance(1d / 60);
            Check(greeting.Gesture == "wave", "a real wake entrance continues into a greeting without a preview command");
            var idle = new BanbanPetMotion(); idle.SetState("listening");
            var idleActions = new HashSet<string>();
            for (var i = 0; i < 60 * 115; i++) { idle.Advance(1d / 60); idleActions.Add(idle.Gesture); }
            Check(new[] { "peek-left", "peek-right", "wink", "wave", "sway", "nod", "think", "listen", "stretch", "sleepy", "awaken" }.All(idleActions.Contains),
                "idle conversation uses the varied calm repertoire and naturally wakes from a short doze");
            var dozing = new BanbanPetMotion(); dozing.SetState("standby"); dozing.Play("sleepy");
            for (var i = 0; i < 222; i++) dozing.Advance(1d / 60);
            Check(dozing.Pose.CloseLeft > .95 && dozing.Pose.CloseRight > .95,
                "a docked doze keeps its eyes closed until the waking gesture takes over");
            for (var i = 0; i < 12; i++) dozing.Advance(1d / 60);
            Check(dozing.Gesture == "awaken" && dozing.Pose.CloseLeft > .9,
                "a docked doze continues into waking without reopening then closing its eyes");
            dozing.SetState("listening"); dozing.Play("wake", false);
            for (var i = 0; i < 50; i++) dozing.Advance(1d / 60);
            Check(dozing.Gesture == "wave", "a voice wake interrupts a docked doze and replaces its queued continuation");
            var speaking = new BanbanPetMotion(); var speakingActions = new HashSet<string>();
            speaking.SetState("speaking"); speaking.SetSpeechOpening(.65);
            for (var i = 0; i < 60 * 30; i++) { speaking.Advance(1d / 60); speakingActions.Add(speaking.Gesture); }
            Check(new[] { "explain", "point-left", "point-right", "nod", "double-nod" }.All(speakingActions.Contains),
                "one long spoken reply continues using varied explanatory gestures without extra state events");
            Check(speaking.Pose.MouthOpen == .65 && !speakingActions.Contains("happy") && !speakingActions.Contains("hop"),
                "spoken gestures preserve the audio envelope and cannot invent a successful task result");
            speaking.SetState("thinking");
            for (var i = 0; i < 60 * 12; i++) speaking.Advance(1d / 60);
            Check(speaking.Gesture is "" or "think", "leaving speech cancels its automatic explanatory gestures");

            var pointing = new BanbanPetMotion(); pointing.Play("point-right");
            var restArm = BanbanPetMascot.RightArm(BanbanPetPose.Rest);
            var boneLengthsPreserved = true; var handRaised = false;
            for (var i = 0; i < 190; i++)
            {
                var arm = BanbanPetMascot.RightArm(pointing.Advance(1d / 60));
                boneLengthsPreserved &= Math.Abs(Distance(arm.Shoulder, arm.Elbow) - Distance(restArm.Shoulder, restArm.Elbow)) < .001
                    && Math.Abs(Distance(arm.Elbow, arm.Wrist) - Distance(restArm.Elbow, restArm.Wrist)) < .001;
                handRaised |= arm.Wrist.Y < arm.Shoulder.Y;
            }
            Check(boneLengthsPreserved && handRaised,
                "the pointing hand rises above its shoulder without changing either painted arm segment's length");
            foreach (var at in new[] { .2, .4, .8, 1.8, 2.1 })
            {
                var gesture = new BanbanPetMotion(); gesture.SetState("speaking"); gesture.Play("point-right");
                for (var i = 0; i < at * 60; i++) gesture.Advance(1d / 60);
                var held = BanbanPetMascot.RightArm(gesture.Pose); gesture.SetState("listening");
                Check(held.Equals(BanbanPetMascot.RightArm(gesture.Pose)), $"interrupting pointing at {at:0.0}s preserves both joints");
                var maximumStep = 0d; var previous = held.Wrist;
                for (var i = 0; i < 150; i++)
                {
                    var arm = BanbanPetMascot.RightArm(gesture.Advance(1d / 60));
                    maximumStep = Math.Max(maximumStep, Distance(previous, arm.Wrist)); previous = arm.Wrist;
                }
                var lowered = BanbanPetMascot.RightArm(gesture.Pose);
                Check(maximumStep < 12 && Distance(lowered.Elbow, restArm.Elbow) < .05 && Distance(lowered.Wrist, restArm.Wrist) < .05,
                    $"interrupted pointing at {at:0.0}s lowers smoothly without a snap or held arm (wrist step {maximumStep:0.000}; "
                    + $"elbow return {Distance(lowered.Elbow, restArm.Elbow):0.000}; wrist return {Distance(lowered.Wrist, restArm.Wrist):0.000})");
            }

            mascot = new BanbanPetMascot { Width = 256, Height = 288, Animate = false };
            window = new Window { Width = 256, Height = 288, Content = mascot, ShowActivated = false, Opacity = 0,
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
            mascot.Width = 716; mascot.Height = 800;
            mascot.Measure(new Size(716, 800)); mascot.Arrange(new Rect(0, 0, 716, 800));
            void InspectBookEdge(BanbanPetPose pose, string filename, string message)
            {
                mascot.ReviewPose = pose;
                using var bitmap = new RenderTargetBitmap(new PixelSize(716, 800), new Vector(96, 96));
                bitmap.Render(mascot); bitmap.Save(Path.Combine(output, filename));
                using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                using var pixels = SKBitmap.Decode(stream);
                Check(new[] { new PixelPoint(558, 478), new PixelPoint(564, 484), new PixelPoint(560, 505) }.All(point =>
                {
                    var deformed = BanbanPetMascot.Deform(new Point(point.X, point.Y), pose);
                    var color = pixels.GetPixel((int)Math.Round(deformed.X + 28), (int)Math.Round(deformed.Y + 35));
                    return color.Alpha > 240 && color.Blue > color.Red * 1.08;
                }), message);
            }
            InspectBookEdge(BanbanPetPose.Rest, "resting-right-arm.png",
                "the lowered right forearm stays behind the continuous blue book edge instead of cutting across it");
            var raisedHand = new BanbanPetMotion(); raisedHand.Play("point-right");
            for (var i = 0; i < 48; i++) raisedHand.Advance(1d / 60);
            InspectBookEdge(raisedHand.Pose, "raised-right-arm.png",
                "the raised pointing arm emerges behind the blue book edge without a translucent wrist seam across the pages");
            InspectFace(52, 62, 96); InspectFace(52, 62, 192); InspectFace(116, 130, 96); InspectFace(116, 130, 144); InspectFace(116, 130, 192);
            InspectFace(150, 168, 96); InspectFace(150, 168, 144); InspectFace(150, 168, 192);
            var openEyes = InspectFace(256, 288, 96); var winkEyes = InspectFace(256, 288, 96, wink: true);
            Check(winkEyes[0] < openEyes[0] * .5 && Math.Abs(winkEyes[1] - openEyes[1]) < 8,
                "a wink closes only the left painted iris and preserves the other eye");
            var renderTimes = new List<double>();
            var handClipping = new List<(string Action, int Frames)>();
            foreach (var action in BanbanPetMotion.Actions)
            {
                var motion = new BanbanPetMotion(); motion.Play(action.Id);
                var folder = Path.Combine(output, action.Id); Directory.CreateDirectory(folder);
                var inspectHand = action.Id is "point-right" or "explain" or "shrug" or "hop" or "stretch" or "awaken" or "think";
                var framesPerSecond = inspectHand ? 60 : 20;
                var count = (int)Math.Ceiling((action.Seconds + .85) * framesPerSecond);
                var clippedHandFrames = 0;
                for (var i = 0; i < count; i++)
                {
                    mascot.ReviewPose = motion.Advance(1d / framesPerSecond); mascot.InvalidateVisual();
                    using var bitmap = new RenderTargetBitmap(new PixelSize(256, 288), new Vector(96, 96));
                    var timer = Stopwatch.StartNew(); bitmap.Render(mascot); timer.Stop(); renderTimes.Add(timer.Elapsed.TotalMilliseconds);
                    bitmap.Save(Path.Combine(folder, $"{i:D4}.png"));
                    if (action.Id == "point-right" && i is 11 or 23 or 35 or 47 or 83 or 113 or 125 or 137)
                    {
                        var detailFolder = Path.Combine(output, "point-right-detail"); Directory.CreateDirectory(detailFolder);
                        using var detail = new RenderTargetBitmap(new PixelSize(768, 864), new Vector(288, 288));
                        detail.Render(mascot); detail.Save(Path.Combine(detailFolder, $"{i:D4}.png"));
                    }
                    if (inspectHand)
                    {
                        using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                        using var pixels = SKBitmap.Decode(stream);
                        if (Enumerable.Range(0, pixels.Height).Any(y => pixels.GetPixel(pixels.Width - 1, y).Alpha > 100))
                            clippedHandFrames++;
                    }
                    if (i % 15 == 0) await Task.Delay(1);
                }
                if (inspectHand)
                    handClipping.Add((action.Id, clippedHandFrames));
                Console.WriteLine("RENDERED " + action.Id);
            }
            Check(handClipping.All(item => item.Frames == 0),
                "complete hands stay inside the canvas throughout raising and lowering: "
                + string.Join(", ", handClipping.Select(item => $"{item.Action}: {item.Frames} clipped frames")));
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

    internal static void Playground(bool speaking = false, string? actionId = null) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(_ => Dispatcher.UIThread.Post(() =>
        {
            var motion = new BanbanPetMotion();
            var actions = actionId is not null ? BanbanPetMotion.Actions.Where(action => action.Id == actionId).ToArray()
                : speaking ? new[] { "explain", "point-left", "nod", "point-right", "double-nod" }
                .Select(id => BanbanPetMotion.Actions.Single(action => action.Id == id)).ToArray() : BanbanPetMotion.Actions;
            string[] spokenExamples = ["我会先为你讲解。", "我们先看左边的内容。", "对，这一步就是这样。", "再看右边的部分。", "我明白了，接着往下说。"];
            var mascot = new BanbanPetMascot { Width = 300, Height = 336, Animate = false };
            var select = new ComboBox { ItemsSource = actions.Select(action => action.Title).ToArray(),
                HorizontalAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetName(select, "选择班班动作");
            var replay = new Button { Content = "再播放一次", HorizontalAlignment = HorizontalAlignment.Stretch };
            var auto = new CheckBox { Content = actionId is null ? "连续播放" : "循环播放", IsChecked = true };
            var slow = new CheckBox { Content = "四分之一速", IsChecked = false };
            var pause = new Button { Content = "暂停" };
            var step = new Button { Content = "下一帧" };
            var paused = false;
            var status = ClassroomStyle.Text("", 14); var phase = 0d; var completed = false; var closed = false;
            BanbanSpeechPlayer? player = null;
            if (speaking) player = new BanbanSpeechPlayer(
                generation => Dispatcher.UIThread.Post(() =>
                {
                    if (closed || player?.Generation != generation) return;
                    motion.SetState("standby"); completed = true; phase = 0;
                    Console.WriteLine("COMPLETED " + actions[Math.Max(0, select.SelectedIndex)].Id);
                }),
                (generation, _) => Dispatcher.UIThread.Post(() =>
                {
                    if (closed || player?.Generation != generation) return;
                    var action = actions[Math.Max(0, select.SelectedIndex)];
                    motion.SetState("speaking"); motion.Play(action.Id); phase = 0;
                    status.Text = action.Title;
                    Console.WriteLine("SPEAKING " + action.Id);
                }),
                error => Dispatcher.UIThread.Post(() =>
                {
                    if (closed) return;
                    auto.IsChecked = false; motion.SetState("standby");
                    status.Text = "演示声音未能播放，请点击再播放一次。";
                    Console.Error.WriteLine(error.Message);
                }));
            void Play()
            {
                var index = Math.Max(0, select.SelectedIndex); var action = actions[index];
                phase = 0; completed = false; paused = false; pause.Content = "暂停";
                if (player is null) { motion.Play(action.Id); status.Text = action.Title; }
                else
                {
                    player.Stop(); motion.SetState("standby"); status.Text = action.Title + " · 准备声音";
                    player.Enqueue(spokenExamples[index], end: true);
                }
            }
            select.SelectionChanged += (_, _) => Play(); replay.Click += (_, _) =>
            {
                if (speaking && !auto.IsChecked.GetValueOrDefault()) { auto.IsChecked = true; if (select.SelectedIndex != 0) { select.SelectedIndex = 0; return; } }
                Play();
            };
            void Advance(double seconds)
            {
                phase += seconds; motion.SetSpeechOpening(player?.MouthOpening ?? 0);
                mascot.ReviewPose = motion.Advance(seconds); mascot.InvalidateVisual();
                if (actionId is not null) status.Text = $"{actions[0].Title} · {phase:0.00} 秒";
            }
            pause.Click += (_, _) => { paused = !paused; pause.Content = paused ? "继续" : "暂停"; };
            step.Click += (_, _) => { paused = true; pause.Content = "继续"; Advance(1d / 60); };
            var reduced = !ClassroomIslandReveal.AnimationsEnabled();
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1000d / 30) };
            var last = Stopwatch.GetTimestamp();
            timer.Tick += (_, _) =>
            {
                var now = Stopwatch.GetTimestamp(); var dt = Math.Min(.08, Stopwatch.GetElapsedTime(last, now).TotalSeconds); last = now;
                if (paused) return;
                Advance(dt * (actionId is not null && slow.IsChecked == true ? .25 : 1));
                if (auto.IsChecked == true && (speaking ? completed && phase > 1.4 : phase > actions[Math.Max(0, select.SelectedIndex)].Seconds + .75))
                {
                    if (speaking && select.SelectedIndex == actions.Length - 1)
                    { auto.IsChecked = false; status.Text = "5 种回答动作已演示完，可以再次播放。"; Console.WriteLine("DEMO COMPLETE"); }
                    else if (actionId is not null) Play();
                    else select.SelectedIndex = (select.SelectedIndex + 1) % actions.Length;
                }
            };
            if (!reduced) timer.Start();
            else { mascot.ReviewPose = motion.Advance(0, true); status.Text = "已遵循系统减少动画设置"; }
            var stage = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(16), Padding = new Thickness(20),
                Child = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, Children = { mascot, status } } };
            var controls = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16, Children = { pause, step, slow } };
            var content = new StackPanel { Margin = new Thickness(24), Spacing = 16, Children = { stage } };
            if (actionId is null) content.Children.Add(select);
            content.Children.Add(replay);
            if (actionId is not null) content.Children.Add(controls);
            content.Children.Add(auto);
            var window = new Window { Title = actionId is not null ? "班班 · 向右指引分帧验收" : speaking ? "班班 · 回答动作演示" : "班班 · 连续动作预览", Width = 460, Height = 650,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                MinWidth = 390, MinHeight = 600, Background = DesktopStyle.Brush("#F4F7FB"),
                Content = new ScrollViewer { Content = content } };
            ClassroomStyle.Apply(window);
            window.Closed += (_, _) => { closed = true; timer.Stop(); player?.Dispose(); mascot.Dispose(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); };
            window.Show(); select.SelectedIndex = 0;
        }))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
}

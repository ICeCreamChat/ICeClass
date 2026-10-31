using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using SkiaSharp;

internal static class BanbanPetReview
{
    internal static void Playground(string output, bool demonstrate = false, bool speechBubble = false) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() =>
        {
            output = Path.GetFullPath(output); Directory.CreateDirectory(output);
            var talks = 0; var opens = 0; var stops = 0; var enabled = true;
            BanbanPetWindow? pet = null;
            void Save() => File.WriteAllText(Path.Combine(output, "interaction.json"), JsonSerializer.Serialize(new
                { talks, opens, stops, enabled, x = pet?.Position.X, y = pet?.Position.Y, visible = pet?.IsVisible }));
            pet = new BanbanPetWindow(() => { opens++; pet!.SetCaption("对话入口已触发", false); Save(); },
                () => { talks++; pet!.Present(new("state", State: "listening", Enabled: enabled)); Save(); },
                () => { stops++; pet!.Present(new("cancel")); Save(); },
                value => { enabled = value; pet!.Present(new("state", State: value ? "standby" : "off", Enabled: value)); Save(); },
                Path.Combine(output, "pet-preferences.json")) { Title = speechBubble ? "班班 · 气泡预览" : demonstrate ? "班班 · 贴边动作演示" : "班班 · 桌宠交互验收", ShowInTaskbar = true };
            // Only this fixture is discoverable in the taskbar; the production pet has no taskbar entry.
            pet.ShowPet(true); pet.Present(new("state", State: "standby", Enabled: true));
            pet.PositionChanged += (_, _) => Save();
            var button = pet.GetVisualDescendants().OfType<Button>().Single(b => b.Name == "BanbanPetTalk");
            var exit = new MenuItem { Header = demonstrate ? "结束演示" : "结束交互验收" };
            exit.Click += (_, _) => { pet.Shutdown(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); };
            button.ContextMenu!.Items.Add(exit); Save();
            if (speechBubble)
            {
                void Caption(string text)
                {
                    pet.Present(new("state", State: "listening", Enabled: true)); pet.SetCaption(text, false);
                    foreach (var name in new[] { "_captionTimer", "_idleTimer" })
                        ((DispatcherTimer)typeof(BanbanPetWindow).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(pet)!).Stop();
                }
                foreach (var (label, text) in new[] { ("短句气泡", "我在，请说。"), ("多行气泡", "等差数列的前 n 项和，等于首项与末项的和乘以项数，再除以二。") })
                {
                    var sample = new MenuItem { Header = label };
                    sample.Click += (_, _) => Caption(text); button.ContextMenu.Items.Insert(0, sample);
                }
                Caption("我在，请说。");
                var display = pet.Screens.ScreenFromWindow(pet) ?? pet.Screens.Primary;
                if (display is not null) pet.Position = new PixelPoint(pet.Position.X, display.WorkingArea.Y + (int)(100 * display.Scaling));
                Save(); return;
            }
            if (!demonstrate) return;
            var mascot = pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single();
            var screen = pet.Screens.ScreenFromPoint(pet.Position) ?? pet.Screens.Primary;
            if (screen is not null)
            {
                pet.Position = new PixelPoint(screen.WorkingArea.X, pet.Position.Y);
                typeof(BanbanPetWindow).GetMethod("Fit", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, [true]);
            }
            var idle = (DispatcherTimer)typeof(BanbanPetMascot).GetField("_idle", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(mascot)!;
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
            var observed = new List<string>(); var last = ""; var awakened = false;
            var animationsAllowed = mascot.Animate;
            void Record(bool complete = false) => File.WriteAllText(Path.Combine(output, "demo.json"), JsonSerializer.Serialize(new
                { complete, reducedMotion = !mascot.Animate, actions = observed, visible = pet.IsVisible, side = "left" }));
            pet.Closed += (_, _) => { timer.Stop(); ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(); };
            timer.Tick += (_, _) =>
            {
                if (!mascot.Animate || !pet.IsVisible) { Record(); pet.Shutdown(); return; }
                var gesture = mascot.Gesture;
                if (gesture.Length > 0 && gesture != last)
                {
                    observed.Add(gesture); awakened |= gesture == "awaken";
                    pet.Title = "班班演示 · " + BanbanPetMotion.Actions.Single(action => action.Id == gesture).Title;
                    Record();
                }
                last = gesture;
                if (awakened && !mascot.AnimationRunning)
                {
                    Record(true); timer.Stop(); mascot.Animate = false;
                    pet.Title = "班班 · 贴边动作演示（已播完）";
                    return;
                }
                // Keep the real production scheduler and motion speed; shorten only its quiet gaps for this one-off preview.
                if (mascot.IdleScheduled && idle.Interval.TotalSeconds > 2) idle.Interval = TimeSpan.FromMilliseconds(1600);
            };
            var replay = new MenuItem { Header = "再演示一遍", IsEnabled = animationsAllowed };
            replay.Click += (_, _) =>
            {
                observed.Clear(); last = ""; awakened = false; mascot.Animate = true;
                pet.Title = "班班 · 贴边动作演示"; Record(); timer.Start();
            };
            button.ContextMenu!.Items.Insert(button.ContextMenu.Items.Count - 1, replay);
            Record(); timer.Start();
        }))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        Window? pet = null;
        void Check(bool value, string name) { if (!value) throw new Exception(name); checks.Add(name); }
        try
        {
            var type = typeof(BanbanVoiceWindow).Assembly.GetType("ICeClass.Receiver.BanbanPetWindow");
            Check(type is not null, "a native desktop companion is provided by the existing receiver");
            var opens = 0; var talks = 0; var cancels = 0; bool? enabled = null;
            var preference = Path.Combine(output, "pet-preferences.json");
            pet = (Window)Activator.CreateInstance(type!, BindingFlags.Instance | BindingFlags.NonPublic, null,
                [new Action(() => opens++), new Action(() => talks++), new Action(() => cancels++),
                 new Action<bool>(value => enabled = value), preference], null)!;
            // Exercise layout and events without covering the user's desktop.
            pet.Opacity = 0;
            void Call(string method, params object[] args) => type!.GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, args);
            Call("ShowPet", true);
            await Task.Delay(150);
            Check(pet.IsVisible && !pet.ShowInTaskbar && pet.Topmost && !pet.ShowActivated, "pet stays visible without a taskbar entry or focus stealing");
            Check(pet.Width == BanbanPetWindow.DockedWidth && pet.Height == BanbanPetWindow.SurfaceHeight,
                "standby reserves a clear edge-peeking character instead of shrinking its entire body");
            Check(pet.SystemDecorations == SystemDecorations.None && pet.Background is ISolidColorBrush { Color.A: 0 }, "pet has transparent native chrome");
            var button = pet.GetVisualDescendants().OfType<Button>().Single(b => b.Name == "BanbanPetTalk");
            var mascot = pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single();
            bool NativePassesThrough(Point point)
            {
                var screenPoint = pet.PointToScreen(point);
                var packed = (long)(ushort)screenPoint.X | ((long)(ushort)screenPoint.Y << 16);
                object[] arguments = [IntPtr.Zero, 0x0084u, IntPtr.Zero, new IntPtr(packed), false];
                var result = (IntPtr)type!.GetMethod("HitTest", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, arguments)!;
                return (bool)arguments[4] && result == new IntPtr(-1);
            }
            int UnreachablePixels(SKBitmap pixels, double scale, out Point inwardPoint)
            {
                var count = 0; inwardPoint = default; var inwardX = double.NaN;
                var right = button.Bounds.Center.X >= pet.Width / 2;
                for (var y = 0; y < pixels.Height; y++) for (var x = 0; x < pixels.Width; x++)
                {
                    if (pixels.GetPixel(x, y).Alpha <= 200) continue;
                    var point = new Point((x + .5) / scale, (y + .5) / scale);
                    if (!button.Bounds.Contains(point)) count++;
                    if (double.IsNaN(inwardX) || (right ? point.X < inwardX : point.X > inwardX))
                    { inwardX = point.X; inwardPoint = point; }
                }
                return count;
            }
            var restingSize = mascot.Bounds.Size;
            Check(restingSize.Width <= 120 && restingSize.Height <= 135,
                "the resting character fits the newly requested compact footprint");
            Check(!mascot.AnimationRunning && !pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.IsEffectivelyVisible),
                "the docked companion has no persistent label or animation while voice is disabled");
            button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Check(talks == 1, "one click reaches the existing conversation callback once");
            Check(pet.Width > BanbanPetWindow.DockedWidth, "clicking the docked companion reveals its existing conversation state");
            await Task.Delay(700);
            Check(mascot.Bounds.Size == restingSize, "clicking to talk keeps the same compact character size");
            button.Focus();
            var beforeMove = pet.Position;
            button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Up });
            Check(pet.Position.Y < beforeMove.Y && talks == 1, "keyboard movement does not trigger conversation");
            var menu = button.ContextMenu!;
            var open = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "打开对话"));
            open.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(opens == 1, "the companion can open the existing chat");
            Call("Present", new BanbanVoiceEvent("state", "您说，我在听", "listening", true));
            Check(pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "我在听"), "listening has a concise visible state");
            Call("Present", new BanbanVoiceEvent("state", "正在处理…", "thinking", true));
            var stop = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "停止操作"));
            stop.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(cancels == 1, "stop reaches the existing operation cancellation callback");
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            Call("Present", new BanbanVoiceEvent("task-result", State: "failed"));
            Check(mascot.Gesture == "shake", "a failed real operation cannot trigger a success animation");
            Call("Present", new BanbanVoiceEvent("task-result", State: "succeeded"));
            Check(mascot.Gesture == "happy", "a verified operation result reaches the expanded companion");
            Call("Present", new BanbanVoiceEvent("task-result", State: "succeeded"));
            Check(mascot.Gesture == "hop", "success feedback can include the completed-task hop");
            Call("SetCaption", "已完成任务。", false);
            await Task.Delay(80);
            Check(pet.GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "已完成任务。"), "a committed answer can appear next to the companion");
            var bubble = pet.GetVisualDescendants().OfType<Button>().Single(b => b != button);
            void CaptureCaption(string name, int dpi = 144)
            {
                var pixels = new PixelSize((int)Math.Ceiling(pet.Width * dpi / 96d), (int)Math.Ceiling(pet.Height * dpi / 96d));
                using var render = new RenderTargetBitmap(pixels, new Vector(dpi, dpi));
                render.Render((Visual)pet.Content!);
                using var stream = new MemoryStream(); render.Save(stream); stream.Position = 0;
                using var source = SKBitmap.Decode(stream);
                using var paper = new SKBitmap(pixels.Width, pixels.Height);
                using (var canvas = new SKCanvas(paper)) { canvas.Clear(SKColors.White); canvas.DrawBitmap(source, 0, 0); }
                using var image = SKImage.FromBitmap(paper);
                using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
                using var file = File.Create(Path.Combine(output, name + ".png")); encoded.SaveTo(file);
            }
            var animated = mascot.Animate; mascot.Animate = false;
            Call("Present", new BanbanVoiceEvent("state", "您说，我在听", "listening", true));
            Call("SetCaption", "我在，请说。", false); await Task.Delay(80);
            CaptureCaption("caption-short-96", 96); CaptureCaption("caption-short-144");
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            Call("SetCaption", "等差数列的前 n 项和，等于首项与末项的和乘以项数，再除以二。", false);
            await Task.Delay(80); CaptureCaption("caption-long-144");
            pet.Width = 300; Call("ArrangeCompanion", false); await Task.Delay(80);
            CaptureCaption("caption-left-narrow-144");
            pet.Width = BanbanPetWindow.ExpandedWidth; Call("ArrangeCompanion", true);
            Call("SetCaption", "已完成任务。", false); mascot.Animate = animated;
            pet.Width = 300; Call("ArrangeCompanion", true);
            await Task.Delay(80);
            Check(bubble.Bounds.Right <= button.Bounds.X && button.Bounds.Right <= pet.ClientSize.Width,
                $"caption and character remain separate and visible in a narrow layout: {bubble.Bounds}, {button.Bounds}, {pet.ClientSize}");
            pet.Width = BanbanPetWindow.ExpandedWidth; Call("ArrangeCompanion", true);
            Check(mascot.AssetsLoaded && mascot.AnimationRunning == mascot.Animate, "the existing artwork follows the system motion preference");
            var speechOpening = .75;
            ((BanbanPetWindow)pet).SpeechOpening = () => speechOpening;
            mascot.Animate = true;
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            var mouthMotion = (BanbanPetMotion)typeof(BanbanPetMascot).GetField("_motion", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(mascot)!;
            await Task.Delay(120);
            Check(mouthMotion.Pose.MouthOpen == .75, "the real native frame timer reads the playing audio envelope");
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.ExpandedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, "speaking.png")); }
            speechOpening = 0; await Task.Delay(80);
            Check(mouthMotion.Pose.MouthOpen == 0, "a live audio pause closes the native pet mouth");
            speechOpening = .55; await Task.Delay(80);
            Check(mouthMotion.Pose.MouthOpen == .55, "the next live syllable reopens the mouth without restarting its body gesture");
            Call("Present", new BanbanVoiceEvent("state", "您说，我在听", "listening", true));
            Check(mouthMotion.Pose.MouthOpen == 0, "leaving speaking closes the native mouth before its next frame");
            mascot.Animate = false;
            Call("Present", new BanbanVoiceEvent("state", "班班正在说…", "speaking", true));
            Check(!mascot.AnimationRunning, "reduced motion stops the animation timer");
            await Task.Delay(100);
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.ExpandedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, "companion.png")); }
            var mute = menu.Items.OfType<MenuItem>().Single(item => Equals(item.Header, "暂停语音"));
            mute.RaiseEvent(new RoutedEventArgs(MenuItem.ClickEvent));
            Check(enabled == false, "microphone pause reaches the shared voice setting");
            Call("HidePet");
            Check(!pet.IsVisible && !mascot.AnimationRunning && !mascot.IdleScheduled && File.Exists(preference), "hiding persists the companion preference and stops all mascot timers without closing voice");
            Call("ShowPet", false);
            Check(!pet.IsVisible, "background events respect a user's hidden companion");
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(!pet.IsVisible, "voice wake respects a companion explicitly hidden by its user");
            Call("ShowPet", true);
            Check(pet.IsVisible, "tray recovery can restore a hidden companion");
            Call("Suspend", true);
            Check(!pet.IsVisible, "lock and sleep hide the companion without changing its preference");
            Call("Suspend", false);
            Check(pet.IsVisible, "unlock restores a companion that was not hidden by its user");
            mascot.Animate = true;
            Call("Present", new BanbanVoiceEvent("wake"));
            Call("Present", new BanbanVoiceEvent("state", "等候你好班班", "standby", true));
            Check(mascot.Gesture == "bow", "ending an active conversation bows before returning to the screen edge");
            await Task.Delay(3300);
            Check(pet.Width == BanbanPetWindow.DockedWidth && !mascot.AnimationRunning && mascot.IdleScheduled,
                "returning to standby leans behind the edge and schedules a sparse gesture without continuous drawing");
            var dockedBottom = pet.Position.Y + (int)Math.Ceiling(pet.Height * pet.RenderScaling);
            foreach (var side in new[] { Key.Left, Key.Right })
            {
                button.Focus();
                button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = side });
                await Task.Delay(80);
                var screen = pet.Screens.ScreenFromPoint(pet.Position)!;
                Check(side == Key.Left ? pet.Position.X == screen.WorkingArea.X
                    : pet.Position.X + (int)Math.Ceiling(pet.Width * screen.Scaling) == screen.WorkingArea.Right,
                    $"{side} docking meets the actual display working-area edge");
                var center = mascot.TranslatePoint(new Point(mascot.Bounds.Width / 2, mascot.Bounds.Height / 2), pet)!.Value;
                var behindEdge = side == Key.Right ? center.X - pet.ClientSize.Width : -center.X;
                Check(behindEdge is >= 2 and <= 10,
                    $"{side} resting character tucks its center just behind the display edge without changing size");
                foreach (var dpi in new[] { 96, 144, 192 })
                {
                    using var bitmap = new RenderTargetBitmap(new PixelSize((int)(BanbanPetWindow.DockedWidth * dpi / 96d), (int)(BanbanPetWindow.SurfaceHeight * dpi / 96d)), new Vector(dpi, dpi));
                    bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, $"docked-{side.ToString().ToLowerInvariant()}-{dpi}.png"));
                    using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                    using var pixels = SKBitmap.Decode(stream);
                    var paintedOutsideButton = UnreachablePixels(pixels, dpi / 96d, out var inwardPoint);
                    Check(paintedOutsideButton == 0,
                        $"{side}/{dpi}dpi the entire visible inward cover and hand remain inside the clickable companion ({paintedOutsideButton} unreachable pixels)");
                    var hit = pet.InputHitTest(inwardPoint) as Visual;
                    Check(!NativePassesThrough(inwardPoint) && (hit == button || hit?.GetVisualAncestors().Contains(button) == true),
                        $"{side}/{dpi}dpi the inward painted silhouette reaches the talk button through both native and Avalonia hit testing");
                    Check(NativePassesThrough(new Point(side == Key.Right ? 2 : pet.Width - 2, 2)),
                        $"{side}/{dpi}dpi clear desktop space still passes through to the application behind the pet");
                    Check(Enumerable.Range(0, pixels.Height).All(y => pixels.GetPixel(side == Key.Right ? 0 : pixels.Width - 1, y).Alpha < 10),
                        $"{side}/{dpi}dpi the inward silhouette has transparent breathing room instead of a cut corner");
                }
                var dockedMotion = new BanbanPetMotion(); dockedMotion.SetState("standby", side == Key.Right);
                for (var actionIndex = 0; actionIndex < 10; actionIndex++)
                {
                    dockedMotion.PlayIdle(side == Key.Right);
                    var action = BanbanPetMotion.Actions.Single(action => action.Id == dockedMotion.Gesture);
                    var clearInwardEdge = true; var unreachable = 0;
                    for (var sample = 0; sample < 3; sample++)
                    {
                        for (var frame = 0; frame < action.Seconds * 15; frame++) dockedMotion.Advance(1d / 60);
                        mascot.ReviewPose = dockedMotion.Pose;
                        using var bitmap = new RenderTargetBitmap(new PixelSize(150, 261), new Vector(144, 144));
                        bitmap.Render((Visual)pet.Content!);
                        if (sample == 1) bitmap.Save(Path.Combine(output, $"idle-{side.ToString().ToLowerInvariant()}-{action.Id}.png"));
                        using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                        using var pixels = SKBitmap.Decode(stream);
                        unreachable += UnreachablePixels(pixels, 1.5, out _);
                        clearInwardEdge &= Enumerable.Range(0, pixels.Height).All(y => pixels.GetPixel(side == Key.Right ? 0 : pixels.Width - 1, y).Alpha < 10);
                    }
                    Check(clearInwardEdge, $"{side}/{action.Id} the docked action preserves the inward cover and hand silhouette throughout its gesture");
                    Check(unreachable == 0, $"{side}/{action.Id} all three docked action samples stay clickable ({unreachable} unreachable pixels)");
                }
                mascot.ReviewPose = null;
                Call("Present", new BanbanVoiceEvent("wake"));
                var dockFrames = (DispatcherTimer)type!.GetField("_dockFrames", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(pet)!;
                var dock = (IslandSpring)type.GetField("_dock", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(pet)!;
                dockFrames.Stop(); mascot.ReviewPose = BanbanPetPose.Rest;
                foreach (var peek in new[] { 1d, .8, .5, .2, 0 })
                {
                    dock.Snap(peek); Call("ArrangeCompanion", side == Key.Right); pet.UpdateLayout();
                    using var bitmap = new RenderTargetBitmap(new PixelSize((int)pet.Width * 2, (int)pet.Height * 2), new Vector(192, 192));
                    bitmap.Render((Visual)pet.Content!);
                    using var stream = new MemoryStream(); bitmap.Save(stream); stream.Position = 0;
                    using var pixels = SKBitmap.Decode(stream);
                    var unreachable = UnreachablePixels(pixels, 2, out _);
                    Check(unreachable == 0, $"{side}/wake-{peek:0.0} the moving companion remains clickable ({unreachable} unreachable pixels)");
                }
                mascot.ReviewPose = null;
                mascot.Animate = false;
                Call("Present", new BanbanVoiceEvent("state", State: "standby", Enabled: true));
                mascot.Animate = true;
            }
            var idleTimer = (DispatcherTimer)typeof(BanbanPetMascot).GetField("_idle", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(mascot)!;
            Check(idleTimer.Interval.TotalSeconds <= 6, "the first calm gesture appears within six seconds of standby");
            idleTimer.Interval = TimeSpan.FromMilliseconds(30);
            await Task.Delay(100);
            Check(mascot.Gesture == "peek-left", "the scheduled idle callback actually peeks toward the desktop from the right edge");
            Check(mascot.AnimationRunning && !mascot.IdleScheduled, "a docked gesture wakes drawing only for its finite sequence");
            await Task.Delay(3500);
            Check(!mascot.AnimationRunning && mascot.IdleScheduled,
                "a completed docked gesture returns to a static open-eyed pose and releases the frame timer");
            var scheduledActions = new HashSet<string> { "peek-left" };
            for (var i = 0; i < 9; i++)
            {
                mascot.Animate = false; mascot.Animate = true;
                idleTimer.Interval = TimeSpan.FromMilliseconds(30);
                await Task.Delay(100);
                scheduledActions.Add(mascot.Gesture);
            }
            Check(new[] { "peek-left", "peek-right", "wink", "wave", "sway", "nod", "think", "listen", "stretch", "sleepy" }.All(scheduledActions.Contains),
                "the production docked timer can reach all ten calm gestures instead of the same five");
            Check(!scheduledActions.Contains("hop") && !scheduledActions.Contains("happy"),
                "standby gestures never imply that an unrequested task succeeded");
            mascot.Animate = false;
            Check(!mascot.AnimationRunning && !mascot.IdleScheduled, "reduced motion also cancels the docked gesture schedule");
            mascot.Animate = true;
            Call("SetInClass", true);
            Check(!pet.IsVisible && !mascot.AnimationRunning && !mascot.IdleScheduled, "class time hides the resting companion and cancels its idle schedule without changing microphone state");
            using (var saved = JsonDocument.Parse(File.ReadAllText(preference)))
                Check(saved.RootElement.GetProperty("Visible").GetBoolean(), "automatic classroom hiding does not overwrite the user's visibility preference");
            Call("Present", new BanbanVoiceEvent("partial", "旁边人的说话"));
            Check(!pet.IsVisible, "unaccepted background partial speech cannot reveal the hidden classroom companion");
            mascot.Animate = true;
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(pet.IsVisible && pet.Width > BanbanPetWindow.DockedWidth && !pet.ShowActivated, "voice wake reveals the companion during class without stealing focus");
            Check(mascot.Width == restingSize.Width && mascot.Height == restingSize.Height,
                "voice wake preserves the same compact character size as standby");
            Check(pet.Position.Y + (int)Math.Ceiling(pet.Height * pet.RenderScaling) == dockedBottom,
                "waking preserves the docked companion's desktop anchor");
            await Task.Delay(70);
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.ExpandedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, "wake-early.png")); }
            await Task.Delay(180);
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.ExpandedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, "wake-hop.png")); }
            await Task.Delay(420);
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.ExpandedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(output, "wake-settled.png")); }
            Call("Suspend", true);
            Call("Present", new BanbanVoiceEvent("wake"));
            Check(!pet.IsVisible && !mascot.AnimationRunning, "voice events cannot reveal or animate a companion while Windows is locked");
            Call("Present", new BanbanVoiceEvent("state", "等候你好班班", "standby", true));
            Call("Suspend", false);
            Check(!pet.IsVisible, "unlock during class restores classroom hiding");
            Call("SetInClass", false);
            Check(pet.IsVisible && pet.Width == BanbanPetWindow.DockedWidth && !mascot.AnimationRunning && mascot.IdleScheduled,
                "the end of class restores the edge-peeking companion and sparse idle schedule");
            await Task.Delay(80);
            using (var bitmap = new RenderTargetBitmap(new PixelSize((int)BanbanPetWindow.DockedWidth * 2, (int)BanbanPetWindow.SurfaceHeight * 2), new Vector(192, 192)))
            { bitmap.Render(pet); bitmap.Save(Path.Combine(output, "docked.png")); }
            Call("Present", new BanbanVoiceEvent("wake"));
            await Task.Delay(6500);
            Call("Present", new BanbanVoiceEvent("partial", "请打开课件"));
            await Task.Delay(6500);
            Check(pet.IsVisible && pet.Width > BanbanPetWindow.DockedWidth, "continued speech keeps the companion expanded past the original idle deadline");
            await Task.Delay(6500);
            Check(pet.IsVisible && pet.Width == BanbanPetWindow.DockedWidth && !mascot.AnimationRunning && mascot.IdleScheduled,
                "twelve seconds without further speech returns the companion to its resting edge-peeking state");
            Check(BanbanPetWindow.Constrain(new PixelPoint(-5000, 5000), new PixelRect(-1920, -100, 1920, 1040), new Size(350, 204), 1.5)
                == new PixelPoint(-1920, 634), "position clamping respects negative monitor coordinates and display scaling");
            var moved = new PixelPoint(pet.Position.X - 10, pet.Position.Y - 10);
            pet.Position = moved;
            Call("HidePet");
            using (var saved = JsonDocument.Parse(File.ReadAllText(preference)))
                Check(saved.RootElement.GetProperty("X").GetInt32() == moved.X && !saved.RootElement.GetProperty("Visible").GetBoolean(), "position and hidden state are saved together");
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = true, checks }));
            Console.WriteLine($"PASS {checks.Count} desktop pet checks");
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = false, checks, error = error.ToString() }));
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            if (pet is not null) pet.GetType().GetMethod("Shutdown", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(pet, null);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

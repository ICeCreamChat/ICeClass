using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using Pointer = Avalonia.Input.Pointer;

internal static class CardQuizWheelResizeChecks
{
    private const double Diameter = BanbanClassroomWheel.Diameter, Radius = Diameter / 2;
    private static readonly Point Center = new(Radius, Radius);
    private static T Field<T>(object target, string name) => (T)target.GetType()
        .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(target)!;

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    internal static async Task Run(BanbanPetWindow pet, BanbanClassroomWheel wheel, bool hasTwoCardVideo,
        CardQuizStore store, string petSettingsPath, Func<Visual, PixelRect> bounds,
        Func<Func<bool>, string, Func<string>?, Task> until, Action<bool, string> check)
    {
        var grip = Field<Control>(pet, "_resizeGrip");
        var lens = Field<BanbanCameraLens>(pet, "_cameraLens");
        var image = Field<Image>(lens, "_frame");
        var mascot = Field<BanbanPetMascot>(pet, "_mascot");
        var preview = BanbanCameraLens.PreviewSize;
        await until(() => lens.IsEffectivelyVisible && lens.Footprint == preview && bounds(lens).Width > 0,
            "缩放前原课堂已展开取景", null);
        var settings = ReadSettings();
        var focus = pet.FocusManager?.GetFocusedElement() as Control;
        var position = pet.Position;
        var originalDisc = bounds(wheel);
        double CompanionPixels() => Field<double>(pet, "_companionScale") * pet.RenderScaling;
        var mascotWidth = bounds(mascot).Width / CompanionPixels();
        var labels = new[] { Field<TextBlock>(wheel, "_currentOption"), Field<TextBlock>(wheel, "_number"),
            Field<TextBlock>(wheel.ActivePrimary, "_caption") };
        var fontSizes = labels.Select(label => label.FontSize).ToArray();
        var commands = new List<string>();
        void Command(CardQuizWheelCommand command) => commands.Add(command.Action);
        void Menu(Button _) => commands.Add("更多");
        CardQuizWheelState State() => Field<CardQuizWheelState>(wheel, "_state");
        async Task<string> LiveTrackId()
        {
            var json = await pet.ClassroomHost!.Browser.Core!.ExecuteScriptAsync("""
                (() => {
                    const track = document.getElementById('camera').srcObject?.getVideoTracks()[0];
                    return track?.readyState === 'live' ? track.id : null;
                })()
                """);
            return JsonNode.Parse(json)?.GetValue<string>() is { Length: > 0 } id ? id :
                throw new InvalidOperationException("收答相机没有活动视频轨道");
        }
        JsonObject ReadSettings() => JsonNode.Parse(File.ReadAllText(petSettingsPath))!.AsObject();
        int Percent() => ReadSettings()["WheelSizePercent"]!.GetValue<int>();
        JsonObject ReadSession() => store.Load()["journals"]!.AsArray().Single()!["session"]!.AsObject();
        PixelPoint GripCenter() => grip.PointToScreen(new Rect(grip.Bounds.Size).Center);
        double VisiblePercent() => 100 * bounds(wheel).Width / Diameter / CompanionPixels();
        Button ButtonNamed(string name) => wheel.GetVisualDescendants().OfType<Button>()
            .Single(b => b.IsEffectivelyVisible && AutomationProperties.GetName(b) == name);
        static bool BelongsTo(Visual? hit, Visual control) => hit == control || hit?.GetVisualAncestors().Contains(control) == true;
        Visual? HitAt(PixelPoint point) => pet.InputHitTest(pet.PointToClient(point)) as Visual;
        bool Hits(PixelPoint point, Visual control) => BelongsTo(HitAt(point), control);
        int NativeHit(PixelPoint point) => SendMessageW(pet.TryGetPlatformHandle()!.Handle, 0x0084, IntPtr.Zero,
            new IntPtr((long)(ushort)point.X | (long)(ushort)point.Y << 16)).ToInt32();

        async Task CheckLayout(int percent, PixelPoint requestedCenter)
        {
            var disc = bounds(wheel);
            var camera = bounds(lens);
            var frame = bounds(image);
            var window = bounds((Visual)pet.Content!);
            var work = pet.Screens.ScreenFromPoint(requestedCenter)!.WorkingArea;
            var companionPixels = CompanionPixels();
            var center = wheel.PointToScreen(Center);
            check(Math.Abs(frame.Width - BanbanCameraLens.VideoSize.Width * disc.Width / Diameter) <= 3 &&
                Math.Abs(frame.Height - frame.Width * 9d / 16) <= 2,
                $"圆盘 {percent}% 时取景同倍率保持 16:9（圆盘 {disc.Width} px，视频 {frame.Width} × {frame.Height} px）");
            check(work.Contains(window) && window.Contains(disc) && window.Contains(camera) &&
                CenterFits(center, requestedCenter, window, work) && Math.Abs(camera.Center.X - disc.Center.X) <= 2 &&
                Math.Abs(disc.Y - camera.Bottom - 8 * companionPixels) <= 2 &&
                Math.Abs(camera.Height - frame.Height - BanbanCameraLens.ToolbarHeight * pet.RenderScaling) <= 2 &&
                Math.Abs(bounds(mascot).Width - mascotWidth * companionPixels) <= 2 &&
                Math.Abs(disc.Width - Diameter * percent / 100 * companionPixels) <= 2 && Math.Abs(disc.Width - disc.Height) <= 1,
                $"圆盘 {percent}% 时视频居中、操作条保持 44 DIP，人物独立适配（窗口 {window}，圆盘 {disc}，取景 {camera}，" +
                $"人物宽 {bounds(mascot).Width}/{mascotWidth * companionPixels:F1} px，实际/目标圆心 {center}/{requestedCenter}，工作区 {work}）");
            check(labels.Select((label, index) =>
            {
                var em = label.PointToScreen(new Point(0, label.FontSize)).Y - label.PointToScreen(default).Y;
                return label.IsEffectivelyVisible && label.TextLayout.TextLines.Count == 1 &&
                    !label.TextLayout.TextLines[0].HasCollapsed && Math.Abs(em - fontSizes[index] * disc.Width / Diameter) <= 2;
            }).All(matches => matches), $"圆心收答项、人数和主操作文字随 {percent}% 盘面等比显示");
            var corner = wheel.PointToScreen(new Point(3, Diameter - 3));
            if (bounds(grip).Contains(corner)) corner = wheel.PointToScreen(new Point(Diameter - 3, Diameter - 3));
            var gripCenter = new Rect(grip.Bounds.Size).Center;
            var edges = new (string Side, Point Offset)[] { ("左", new(-20, 0)), ("右", new(20, 0)),
                ("上", new(0, -20)), ("下", new(0, 20)) };
            (PixelPoint Screen, Visual? Hit, int Native, bool OnGrip, bool OnWheel, bool InDisc) EdgeHit(Point offset)
            {
                var point = grip.PointToScreen(gripCenter + offset);
                var hit = HitAt(point);
                return (point, hit, NativeHit(point), BelongsTo(hit, grip), BelongsTo(hit, wheel),
                    wheel.ContainsInteractive(wheel.PointToClient(point)));
            }
            await until(() => edges.Select(edge => EdgeHit(edge.Offset))
                .All(sample => sample.Native == 1 && (sample.OnGrip || sample.InDisc && sample.OnWheel)),
                $"{percent}% 时把手边缘可按下，和盘沿重叠处仍可触控", () => string.Join(" | ", edges.Select(edge =>
                {
                    var sample = EdgeHit(edge.Offset);
                    var type = sample.Hit?.GetType().Name ?? "无";
                    var name = sample.Hit?.Name;
                    var owner = sample.OnGrip ? "把手" : sample.OnWheel ? "圆盘" : "其他";
                    return $"{edge.Side} 屏幕 {sample.Screen} px，命中 {type}{(string.IsNullOrEmpty(name) ? "" : "#" + name)}，" +
                        $"归属 {owner}，盘内 {sample.InDisc}，WM_NCHITTEST={sample.Native}";
                })));
            check(NativeHit(corner) == -1 &&
                Math.Abs(bounds(grip).Width - 44 * pet.RenderScaling) <= 1 &&
                Math.Abs(bounds(grip).Height - 44 * pet.RenderScaling) <= 1,
                $"{percent}% 时把手保留 44 DIP 命中区，圆外角可点课件");
        }

        async Task Drag(PointerType type, PixelPoint start, Visual expectedHit, double factor, string label,
            double turn = 0, Func<IPointer, Task>? whileHeld = null)
        {
            await until(() => NativeHit(start) == 1 && Hits(start, expectedHit), label + "的起点可命中",
                () => $"屏幕 {start}，实际命中 {pet.InputHitTest(pet.PointToClient(start))}");
            var center = wheel.PointToScreen(Center);
            var dx = start.X - center.X;
            var dy = start.Y - center.Y;
            PixelPoint AtRadius(double ratio, double angle) => new(
                center.X + (int)Math.Round(ratio * (dx * Math.Cos(angle) - dy * Math.Sin(angle))),
                center.Y + (int)Math.Round(ratio * (dx * Math.Sin(angle) + dy * Math.Cos(angle))));
            var end = AtRadius(factor, turn);
            var initial = Percent();
            var startRadius = new Vector(dx, dy).Length;
            int ExpectedAt(PixelPoint point) => Math.Clamp((int)Math.Round(initial *
                new Vector(point.X - center.X, point.Y - center.Y).Length / startRadius), 80, 200);
            await Gesture(pet, type, start, [AtRadius((1 + factor) / 2, 0), end], point =>
            {
                var visible = VisiblePercent();
                if (Math.Abs(visible - ExpectedAt(point)) > 2)
                    throw new InvalidOperationException($"{label}在松手前未跟随屏幕半径（{start} → {point}，圆心 {center}，" +
                        $"起始 {initial}%，应为 {ExpectedAt(point)}%，实测 {visible:F1}%）");
            }, whileHeld);
            var expected = ExpectedAt(end);
            var saved = Percent();
            check(Math.Abs(saved - expected) <= 1 && commands.Count == 0 && !pet.PetMenu.IsOpen &&
                wheel.ActivePrimary.IsEffectivelyVisible && !wheel.ActivePrimary.IsPressed,
                $"{label}（起始 {initial}%，屏幕半径预期 {expected}%，保存 {saved}%，课堂操作 [{string.Join(", ", commands)}]）");
            await CheckLayout(saved, center);
        }

        void KeySize(Key key, int expected)
        {
            grip.Focus();
            grip.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = key });
            pet.UpdateLayout();
            check(grip.IsFocused && Percent() == expected, $"把手 {key} 后仍有焦点，原偏好文件保存 {expected}%");
        }

        var opening = State().Lesson;
        async Task WaitForTwoCards(IPointer pen)
        {
            var before = ReadSession();
            var sequence = before["seq"]!.GetValue<int>();
            string Progress() => $"当前 {State().Lesson.Option} 项，已收 {State().Lesson.Received} 人，捕获 {pen.Captured}，菜单 {pet.PetMenu.IsOpen}";
            check(State().Lesson.Received == 0 && pen.Captured == wheel, $"首批入账前触控笔已放大圆盘并保持捕获（{Progress()}）");
            await until(() =>
            {
                var lesson = State().Lesson;
                if (pen.Captured != wheel || lesson.Key != opening.Key || lesson.Option != "A" || pet.PetMenu.IsOpen || commands.Count != 0)
                    throw new InvalidOperationException($"触控笔尚未抬起时收答或捕获已改变（{Progress()}）");
                return lesson.Received == 2;
            }, "保持触控笔按下直到相机两卡入账", Progress);

            var journal = store.Read(before["id"]!.GetValue<string>())!;
            var entries = journal["events"]!.AsArray().Skip(sequence).Select(e => e!.AsObject()).ToArray();
            bool Card(int number, string direction) => entries.Any(e => (int?)e["payload"]?["cardNumber"] == number &&
                (string?)e["payload"]?["option"] == direction);
            var percent = VisiblePercent();
            check(Math.Abs(percent - 150) <= 2 && entries.Length == 2 && entries.All(e => (string?)e["action"] == "answer" &&
                JsonNode.DeepEquals(e["questionId"], before["currentQuestionId"]) && JsonNode.DeepEquals(e["roundId"], before["currentRoundId"]) &&
                (string?)e["payload"]?["targetOption"] == "A") && Card(1, "A") && Card(2, "B"),
                $"抬笔前同题同轮的 A 项已落盘，1 号举 A、2 号举 B（盘面 {percent:F1}%，新增 {entries.Length} 条事件，{Progress()}）");
        }

        check(pet.ClassroomExpanded && opening is { Phase: "collect", Kind: "multiple", Option: "A" } &&
            grip.IsEffectivelyVisible && grip.Focusable && Percent() == 100, "多选收答主盘默认 100%，展开时把手可见且可聚焦");
        wheel.ActionRequested += Command;
        wheel.MenuRequested += Menu;
        try
        {
            var openingTrack = LiveTrackId();
            if (hasTwoCardVideo)
            {
                await Drag(PointerType.Pen, GripCenter(), grip, 1.5, "触控笔从把手放大并等候文件相机收卡", whileHeld: WaitForTwoCards);
                KeySize(Key.Home, 100);
                check(State().Lesson is { Phase: "collect", Option: "A", Received: 2 } && State().Lesson.Key == opening.Key,
                    "抬笔后恢复 100%，原轮仍收 A 项并保留两卡");
            }
            var trackId = await openingTrack;
            await until(() => image.Source != null && bounds(image).Width > 0, "缩放检查前白板已显示首帧", null);
            var original = State();
            var session = ReadSession();
            CheckPlacement(check);
            await Drag(PointerType.Touch, wheel.PointToScreen(new Point(Radius, Radius - 106)), wheel.ActivePrimary,
                1.5, "单指从下一项扇面外沿连续放大");
            await Drag(PointerType.Mouse, wheel.PointToScreen(new Point(Radius, Radius - 115)), wheel,
                2.6, "鼠标从空白盘沿拖至上限");
            var enlargedFrame = bounds(image).Size;
            var enlargedCenter = wheel.PointToScreen(Center);
            void ClickLens(string name) => lens.GetVisualDescendants().OfType<Button>()
                .Single(b => b.IsEffectivelyVisible && AutomationProperties.GetName(b) == name)
                .RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            ClickLens("收起取景，继续扫码");
            await until(() => lens.Footprint == BanbanCameraLens.DockSize && image.Source == null,
                "放大后收起只显示扫描按钮", null);
            ClickLens("展开取景，正在扫码");
            await until(() => image.Source != null && bounds(image).Size == enlargedFrame,
                "展开恢复放大后的连续取景", null);
            check(wheel.PointToScreen(Center) == enlargedCenter && await LiveTrackId() == trackId,
                "收起再展开保留圆心和原摄像头轨道");
            KeySize(Key.Up, 200);
            CheckReload(petSettingsPath, Field<ReceiverConfig>(pet, "_classroomBinding"), check);
            await Drag(PointerType.Mouse, GripCenter(), grip, .25, "鼠标从把手拖至下限");
            KeySize(Key.Left, 80);
            await Drag(PointerType.Touch, GripCenter(), grip, 1.5, "单指从把手斜向拖动", Math.PI / 6);
            await Drag(PointerType.Touch, wheel.PointToScreen(new Point(Radius, Radius + 107)), ButtonNamed("更多操作"),
                1.2, "单指从更多扇面外沿放大");

            var beforeTap = Percent();
            var tools = ButtonNamed("课堂工具");
            var tap = wheel.PointToScreen(new Point(Radius - 107, Radius));
            await until(() => Hits(tap, tools), "缩放后工具扇面外沿可点", null);
            await Gesture(pet, PointerType.Touch, tap, [new PixelPoint(tap.X, tap.Y + 1)]);
            await until(() => !tools.IsEffectivelyVisible && Hits(wheel.PointToScreen(Center), ButtonNamed("返回课堂")),
                "轻微手抖仍打开原生工具，圆心可返回", null);
            await Gesture(pet, PointerType.Mouse, wheel.PointToScreen(Center), []);
            await until(() => tools.IsEffectivelyVisible && Hits(tap, tools), "点缩放后的圆心返回收答", null);
            check(Percent() == beforeTap, "轻点扇面和圆心保留圆盘比例");

            KeySize(Key.Home, 100);
            KeySize(Key.Right, 110);
            KeySize(Key.Up, 120);
            KeySize(Key.Left, 110);
            KeySize(Key.Down, 100);
            check(await LiveTrackId() == trackId, "缩放前后相机沿用同一条活动视频轨道");
            var state = State();
            var lesson = state.Lesson;
            check(commands.Count == 0 && !pet.PetMenu.IsOpen && pet.ClassroomExpanded &&
                state.CameraRunning && state.Preview == original.Preview && lesson.Phase == original.Lesson.Phase &&
                lesson.Key == original.Lesson.Key && lesson.Number == original.Lesson.Number && lesson.Option == original.Lesson.Option &&
                lesson.Received == original.Lesson.Received && lesson.Expected == original.Lesson.Expected &&
                lesson.Missing.SequenceEqual(original.Lesson.Missing) && JsonNode.DeepEquals(ReadSession(), session),
                "缩放全过程保留原题、收答项、已收答案和待收卡号，相机继续采集");
        }
        finally
        {
            wheel.ActionRequested -= Command;
            wheel.MenuRequested -= Menu;
            grip.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Home });
            pet.Position = position;
            focus?.Focus();
            pet.UpdateLayout();
        }
        check(JsonNode.DeepEquals(settings, ReadSettings()) && bounds(wheel) == originalDisc,
            "后续检查从原圆盘位置、比例和人物设置继续");
    }

    private static void CheckReload(string path, ReceiverConfig binding, Action<bool, string> check)
    {
        void Reopen(string file, int expected)
        {
            var reopened = new BanbanPetWindow(() => { }, () => { }, () => { }, _ => { }, file, binding);
            try
            {
                var grip = Field<Control>(reopened, "_resizeGrip");
                check(!grip.IsVisible && AutomationProperties.GetItemStatus(grip)?.Contains($"{expected}%") == true,
                    $"新建白板读取圆盘 {expected}%，课堂收起时隐藏把手");
            }
            finally { reopened.Shutdown(); }
        }
        Reopen(path, 200);
        var legacy = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        legacy.Remove("WheelSizePercent");
        legacy["SizePercent"] = 125;
        var legacyPath = Path.ChangeExtension(path, "legacy.json");
        try
        {
            File.WriteAllText(legacyPath, legacy.ToJsonString());
            Reopen(legacyPath, 100);
            var migrated = JsonNode.Parse(File.ReadAllText(legacyPath))!.AsObject();
            check(migrated["WheelSizePercent"]?.GetValue<int>() == 100 && migrated.Remove("WheelSizePercent") &&
                JsonNode.DeepEquals(migrated, legacy), "旧偏好补入圆盘默认 100%，保留人物 125%、位置和可见性");
        }
        finally { File.Delete(legacyPath); }
    }

    private static async Task Gesture(BanbanPetWindow pet, PointerType type, PixelPoint start, PixelPoint[] moves,
        Action<PixelPoint>? moved = null, Func<IPointer, Task>? whileHeld = null)
    {
        using var pointer = new Pointer(Pointer.GetNextFreeId(), type, true);
        InputElement Target(PixelPoint at) => pointer.Captured as InputElement ??
            pet.InputHitTest(pet.PointToClient(at)) as InputElement ?? throw new InvalidOperationException($"指针丢失命中与捕获 {at}");
        var target = Target(start);
        // Routed events bypass the platform device's implicit capture of the initial hit.
        pointer.Capture(target);
        ulong time = 1;
        target.RaiseEvent(new PointerPressedEventArgs(target, pointer, pet, pet.PointToClient(start), time,
            new(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed), KeyModifiers.None));
        var last = start;
        try
        {
            foreach (var move in moves)
            {
                last = move;
                target = Target(move);
                target.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent, target, pointer, pet, pet.PointToClient(move), ++time,
                    new(RawInputModifiers.LeftMouseButton, PointerUpdateKind.Other), KeyModifiers.None));
                pet.UpdateLayout();
                moved?.Invoke(move);
            }
            if (whileHeld != null) await whileHeld(pointer);
        }
        finally
        {
            target = Target(last);
            target.RaiseEvent(new PointerReleasedEventArgs(target, pointer, pet, pet.PointToClient(last), ++time,
                new(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased), KeyModifiers.None, MouseButton.Left));
            pet.UpdateLayout();
        }
    }

    private static bool CenterFits(PixelPoint actual, PixelPoint requested, PixelRect window, PixelRect work)
    {
        // A shifted center is valid only when moving it back would push that edge of the window offscreen.
        static bool Fits(int at, int wanted, int start, int end, int low, int high) =>
            Math.Abs(at - wanted) <= 2 || Math.Abs(at > wanted ? start - low : end - high) <= 1;
        return Fits(actual.X, requested.X, window.X, window.Right, work.X, work.Right) &&
            Fits(actual.Y, requested.Y, window.Y, window.Bottom, work.Y, work.Bottom);
    }

    private static void CheckPlacement(Action<bool, string> check)
    {
        const double rest = 100, petScale = .8;
        var roomy = new PixelRect(-3600, -1300, 3400, 2400);
        foreach (var work in new[] { roomy, new PixelRect(-603, -287, 581, 463), new PixelRect(31, 17, 319, 829) })
        foreach (var dpi in new[] { 1d, 1.5, 2 })
        foreach (var right in new[] { false, true })
        foreach (var percent in new[] { 80, 200 })
        foreach (var requested in new[] { work.Center, work.TopLeft, work.BottomRight })
        {
            var anchor = new PixelPoint(right ? work.Right - 20 : work.X + 20, work.Bottom - 20);
            var center = requested;
            double expandedScale = 0;
            foreach (var lens in new[] { default(Size), BanbanCameraLens.PreviewSize, BanbanCameraLens.DockSize })
            {
                var fit = BanbanPetWindow.FitClassroom(anchor, work, dpi, rest, petScale, right, lens, center, percent);
                var window = new PixelRect(fit.Position, PixelSize.FromSize(fit.Size, dpi));
                var surface = new Rect(fit.Size).Inflate(.001);
                var disc = new Rect(fit.Wheel, new Size(Diameter, Diameter) * fit.Scale);
                var camera = new Rect(fit.Lens, fit.LensSize);
                var petWidth = rest * fit.CompanionScale;
                var companion = new Rect(right ? disc.Right : disc.X - petWidth, fit.PetTop, petWidth, 130 * petScale * fit.CompanionScale);
                var actual = new PixelPoint(fit.Position.X + (int)Math.Round(disc.Center.X * dpi),
                    fit.Position.Y + (int)Math.Round(disc.Center.Y * dpi));
                var lensFits = lens == default || surface.Contains(camera) && Math.Abs(camera.Center.X - disc.Center.X) <= .001 &&
                    Math.Abs(disc.Top - camera.Bottom - 8 * fit.CompanionScale) <= .001;
                var videoFollows = lens != BanbanCameraLens.PreviewSize ||
                    Math.Abs(camera.Width - BanbanCameraLens.VideoSize.Width * fit.Scale) <= .001 &&
                    Math.Abs(camera.Height - BanbanCameraLens.VideoSize.Height * fit.Scale - BanbanCameraLens.ToolbarHeight) <= .001;
                var foldKeepsCenter = lens != BanbanCameraLens.DockSize || Math.Abs(fit.Scale - expandedScale) <= .00001 &&
                    Math.Abs(actual.X - center.X) <= 1 && Math.Abs(actual.Y - center.Y) <= 1;
                if (fit.CompanionScale is <= 0 or > 1 || work == roomy && fit.CompanionScale != 1 ||
                    Math.Abs(fit.Scale - fit.CompanionScale * percent / 100) > .00001 ||
                    !work.Contains(window) || !surface.Contains(disc) || !surface.Contains(companion) ||
                    !CenterFits(actual, center, window, work) || !lensFits || !videoFollows || !foldKeepsCenter)
                    throw new InvalidOperationException($"圆盘适配异常 {work} @ {dpi}，右停靠 {right}，{percent}%，取景 {lens}，" +
                        $"盘/人物倍率 {fit.Scale}/{fit.CompanionScale}，窗口 {window}，目标圆心 {center}，实际 {actual}");
                if (lens == BanbanCameraLens.PreviewSize) { expandedScale = fit.Scale; center = actual; }
            }
        }
        check(true, "80% 和 200% 圆盘在三档 DPI、双侧停靠、负坐标和窄工作区内可展开与收起取景，圆心按工作区限位");
    }
}

using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Automation.Peers;
using Avalonia.Automation.Provider;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Media.TextFormatting;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using SkiaSharp;
using Pointer = Avalonia.Input.Pointer;

/// <summary>Exercise the original pet's gestures and real classroom bridge with an isolated identity.</summary>
internal static class CardQuizWheelChecks
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, NativePoint point, uint flags);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref NativePoint point);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    internal static void Run(string outputDirectory, string? twoCardVideo = null, bool smallClass = false, bool interactive = false, bool videoCadence = false)
    {
        Directory.CreateDirectory(outputDirectory);
        var petSettingsPath = Path.Combine(outputDirectory, $"pet-check-{Guid.NewGuid():N}.json");
        var mediaArgs = (videoCadence ? "--use-fake-device-for-media-stream=fps=30" : "--use-fake-device-for-media-stream") + " --use-fake-ui-for-media-stream";
        if (twoCardVideo is not null) mediaArgs += " --use-file-for-fake-video-capture=\"" + Path.GetFullPath(twoCardVideo) + "\"";
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", mediaArgs);
        Exception? failure = null;
        var passed = new List<string>();
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:9/", ClassId = Guid.NewGuid().ToString(), DeviceId = Guid.NewGuid().ToString(), DeviceToken = "isolated-wheel-check", ClassName = "高一（1）班" };
                // Card 4 in the video belongs to another class. Only cards 1 and 2 should count.
                var cardNumbers = smallClass ? Enumerable.Range(1,12).ToArray() : Enumerable.Range(1, 61).Where(n => n != 4).ToArray();
                var students = new JsonArray();
                foreach (var number in cardNumbers)
                    students.Add(new JsonObject { ["id"] = $"s{number}", ["name"] = $"演示{number}", ["cardNumber"] = number });
                CardQuizService.For(config).Store.SaveCache("context", new JsonObject {
                    ["classId"] = config.ClassId, ["deviceId"] = config.DeviceId, ["className"] = config.ClassName,
                    ["students"] = students, ["publications"] = new JsonArray()
                });
                var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
                var talks = 0; var chats = 0;
                var pet = new BanbanPetWindow(() => chats++, () => talks++, () => { }, _ => { }, petSettingsPath, config);
                desktop.MainWindow = pet;
                bool OnlyPet() => desktop.Windows.Where(w => w.IsVisible).SequenceEqual([pet]);
                Window? lesson = null;
                try
                {
                    async Task<bool> Read(string expression) => pet.ClassroomHost?.Browser.Core is { } core && await core.ExecuteScriptAsync(expression) == "true";
                    async Task Wait(string expression)
                    {
                        for (var count = 0; count < 150; count++) { if (await Read(expression)) return; await Task.Delay(100); }
                        var state = await (pet.ClassroomHost?.Browser.Core?.ExecuteScriptAsync("""
                            (() => { const get = id => document.getElementById(id), v = get('camera');
                              return {pane:document.body.dataset.pane,hidden:document.hidden,width:innerWidth,status:get('round-status')?.textContent,
                                feedback:get('feedback')?.textContent,camera:get('camera-status')?.textContent,count:get('received')?.textContent,
                                frames:v?.getVideoPlaybackQuality?.().totalVideoFrames,dropped:v?.getVideoPlaybackQuality?.().droppedVideoFrames,
                                videoWidth:v?.videoWidth,track:v?.srcObject?.getVideoTracks()[0]?.label}; })()
                            """) ?? Task.FromResult("无页面"));
                        throw new InvalidOperationException("Timed out: " + expression + " " + state);
                    }
                    void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); passed.Add(name); Console.WriteLine("PASS " + name); }
                    pet.SetInClass(true); pet.ShowPet(true); await Task.Delay(100); pet.UpdateLayout();
                    var talk = Field<Button>(pet,"_talk"); var mascot = Field<BanbanPetMascot>(pet,"_mascot"); mascot.Animate = false;
                    var wheel = Field<BanbanClassroomWheel>(pet,"_classroomWheel");
                    Button PrimaryButton() => wheel.ActivePrimary;
                    var restSize = new Size(pet.Width,pet.Height);
                    foreach (var dpi in new[] {1d,1.5,2d})
                    foreach (var right in new[] { false,true })
                    {
                        var work = new PixelRect(-600,0,600,480);
                        var anchorX = right ? work.Right-55 : work.X+55;
                        var fit = BanbanPetWindow.FitClassroom(new PixelPoint(anchorX,475),work,dpi,100,.8,right);
                        var bounds = new PixelRect(fit.Position,new PixelSize((int)Math.Round(fit.Size.Width*dpi),(int)Math.Round(fit.Size.Height*dpi)));
                        if (!work.Contains(bounds) || fit.PetTop<0 || fit.PetTop+130*.8*fit.Scale>fit.Size.Height+.01)
                            throw new InvalidOperationException("紧凑屏幕定位 "+dpi);
                        foreach (var lensSize in new[] { BanbanCameraLens.PreviewSize, BanbanCameraLens.DockSize })
                        {
                            var placement = BanbanPetWindow.FitClassroom(new PixelPoint(anchorX,475),work,dpi,100,.8,right,lensSize);
                            var area = new Rect(placement.Size);
                            var disc = new Rect(placement.Wheel,new Size(240,240)*placement.Scale);
                            var aperture = new Rect(placement.Lens,lensSize*placement.Scale);
                            var window = new PixelRect(placement.Position, PixelSize.FromSize(placement.Size, dpi));
                            if (!work.Contains(window) || !area.Inflate(.001).Contains(disc) || !area.Inflate(.001).Contains(aperture) ||
                                Math.Abs(aperture.Center.X-disc.Center.X) > .001 || Math.Abs(disc.Y-aperture.Bottom-8*placement.Scale) > .001)
                                throw new InvalidOperationException($"窄屏取景与圆盘居中、间距或工作区边界异常 {dpi}: {window}, {disc}, {aperture}");
                        }
                    }
                    Check(true,"窄工作区左右停靠及 100%、150%、200% 缩放均在屏内");
                    foreach (var right in new[] {false,true})
                    {
                        var work = new PixelRect(0,0,800,700);
                        var point = new PixelPoint(right ? 415 : 385,410);
                        var alone = BanbanPetWindow.FitClassroom(point,work,1,100,.8,right);
                        var expanded = BanbanCameraLens.PreviewSize;
                        var withLens = BanbanPetWindow.FitClassroom(point,work,1,100,.8,right,expanded);
                        Check(alone.Position.X+alone.Wheel.X == withLens.Position.X+withLens.Wheel.X &&
                            alone.Position.Y+alone.Wheel.Y == withLens.Position.Y+withLens.Wheel.Y &&
                            withLens.Lens.X + expanded.Width / 2 == withLens.Wheel.X + 120 &&
                            withLens.Lens.Y + expanded.Height < withLens.Wheel.Y,
                            (right ? "右侧" : "左侧")+"空间充足时开相机保持圆盘原位，宽取景在其正上方居中");
                    }
                    PixelPoint Anchor() => mascot.PointToScreen(new Point(mascot.Bounds.Width/2,mascot.Bounds.Height/2));
                    var anchor = Anchor();
                    void Click(Button b) { if (!b.IsEffectivelyVisible || !b.IsEnabled) throw new InvalidOperationException("不可用按钮 "+b.Content); b.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); }
                    void PressEnter(Button button)
                    {
                        if (!button.IsFocused) throw new InvalidOperationException("键盘焦点未到 " + AutomationProperties.GetName(button));
                        button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Enter });
                        button.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyUpEvent, Key = Key.Enter });
                    }
                    Button? Find(string label) => wheel.GetVisualDescendants().OfType<Button>().FirstOrDefault(b=>b.IsEffectivelyVisible &&
                        (AutomationProperties.GetName(b)==label || b.Content as string==label));
                    Button ButtonFor(string label) => Find(label) ?? throw new InvalidOperationException("未找到 "+label);
                    var bodyScroll = Field<ScrollViewer>(wheel,"_bodyScroll");
                    var toolGrid = Field<Canvas>(wheel,"_tools");
                    BanbanToolSector[] VisibleTools() => toolGrid.Children.OfType<BanbanToolSector>().Where(b => b.IsEffectivelyVisible).ToArray();
                    BanbanToolSector? Tool(string id) => VisibleTools().SingleOrDefault(b => b.ActionId == id);
                    const string allCards = "查看全班卡号", pendingCards = "只看待收卡号";
                    bool NoCardFilter() => Find(allCards) == null && Find(pendingCards) == null;
                    async Task<Button> OpenAllCards()
                    {
                        var round = Field<CardQuizWheelState>(wheel, "_state").Lesson;
                        var status = round.Expected == 0 ? "全员免答" : round.Missing.Length == 0 ? "已收齐" : $"待收 {round.Missing.Length} 人";
                        var entry = ButtonFor(status + "，查看卡号");
                        Click(entry);
                        await Until(() => Field<CardQuizWheelState>(wheel, "_state").CardPanel is
                            { Overview:true, PendingOnly:true, ReadOnly:true } && Find(allCards)?.IsEnabled == true, "从右侧进入待收总览");
                        var pendingState = Field<CardQuizWheelState>(wheel, "_state");
                        var pending = pendingState.CardPanel!;
                        Check(pending.Cards.Select(mark => mark.Number).SequenceEqual(pendingState.Lesson.Missing) &&
                            pending.Cards.All(mark => mark.State == "pending") && pending.Grouped == (pending.Cards.Length > 12),
                            "待收总览仅列缺收卡，超过十二张按印刷号段分组");
                        var sectors = Field<Canvas>(Field<BanbanCardOverview>(wheel, "_cardRing"), "_ring")
                            .Children.OfType<BanbanToolSector>().ToArray();
                        if (pending.Grouped)
                        {
                            var groups = pendingState.Lesson.Missing.GroupBy(n => (n - 1) / 10).ToArray();
                            Check(sectors.Length == groups.Length && groups.Select((group, index) =>
                                Field<int[]>(sectors[index], "_dotNumbers").SequenceEqual(Enumerable.Range(group.Key * 10 + 1, 10)
                                    .Select(n => group.Contains(n) ? n : 0))).All(matches => matches),
                                "待收号段沿用印刷位置，已收、免答和缺号处均留空");
                        }
                        else
                            Check(sectors.Select(AutomationProperties.GetName).SequenceEqual(pendingState.Lesson.Missing.Select(n => $"{n} 号卡，待收")),
                                "十二张以内逐张显示缺收卡号");
                        var scope = ButtonFor(allCards);
                        var scopePoint = scope.TranslatePoint(new Rect(scope.Bounds.Size).Center, wheel)!.Value;
                        await Until(() => HitButton(scopePoint) == scope, "全班筛选按钮可触控");
                        Touch(scopePoint, scopePoint);
                        await Until(() => Field<CardQuizWheelState>(wheel, "_state").CardPanel is
                            { Overview:true, PendingOnly:false, ReadOnly:false } && Find(pendingCards)?.IsEnabled == true, "切换到全班总览");
                        return entry;
                    }
                    bool UsesWheelBold(Button button)
                    {
                        var expected = new Typeface(new FontFamily("Microsoft YaHei"), weight: FontWeight.Bold).GlyphTypeface;
                        var faces = button.GetVisualDescendants().OfType<TextBlock>().SelectMany(text => text.TextLayout.TextLines)
                            .SelectMany(line => line.TextRuns).OfType<ShapedTextRun>().Select(run => run.ShapedBuffer.GlyphTypeface).ToArray();
                        return faces.Length > 0 && faces.All(face => face.FamilyName == expected.FamilyName && face.Weight == FontWeight.Bold);
                    }
                    Button? HitButton(Point pointOnWheel)
                    {
                        var point = wheel.TranslatePoint(pointOnWheel, pet)!.Value;
                        var hit = pet.InputHitTest(point) as Visual;
                        return hit as Button ?? hit?.GetVisualAncestors().OfType<Button>().FirstOrDefault();
                    }
                    Point OnRing(double radius, double angle) => new(BanbanClassroomWheel.Diameter / 2 + radius * Math.Sin(angle),
                        BanbanClassroomWheel.Diameter / 2 - radius * Math.Cos(angle));
                    // Every sector ends at 110 DIP, leaving 6 DIP to the disc's outer edge.
                    const double insideClassroomRim = 109, outsideClassroomRim = 111;
                    bool ClassroomRimHits(Button? sector, double angle) => sector != null &&
                        HitButton(OnRing(insideClassroomRim, angle)) == sector && HitButton(OnRing(outsideClassroomRim, angle)) == null;
                    void Touch(Point from, Point to)
                    {
                        var button = HitButton(from) ?? throw new InvalidOperationException("触点没有命中按钮");
                        using var pointer = new Pointer(Pointer.GetNextFreeId(), PointerType.Touch, true);
                        var down = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed);
                        var up = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased);
                        button.RaiseEvent(new PointerPressedEventArgs(button, pointer, pet, wheel.TranslatePoint(from, pet)!.Value, 1, down, KeyModifiers.None));
                        button.RaiseEvent(new PointerReleasedEventArgs(button, pointer, pet, wheel.TranslatePoint(to, pet)!.Value, 2, up, KeyModifiers.None, MouseButton.Left));
                    }
                    async Task<bool> RingFits()
                    {
                        var back = ButtonFor("返回课堂");
                        var buttons = VisibleTools();
                        var sweep = Math.Tau / buttons.Length;
                        await Until(() => HitButton(OnRing(0, 0)) == back &&
                            buttons.Select((button, i) => HitButton(OnRing(76, i * sweep)) == button).All(hit => hit),
                            "各个扇区和圆心返回可点中");
                        for (int i = 0; i < buttons.Length; i++)
                        {
                            var button = buttons[i];
                            var a = i * sweep;
                            var center = OnRing(76, a);
                            for (int direction = 0; direction < 8; direction++)
                            {
                                var angle = direction * Math.PI / 4;
                                if (HitButton(center + new Point(22 * Math.Cos(angle), 22 * Math.Sin(angle))) != button) return false;
                            }
                            if (HitButton(OnRing(43, a)) != button || !ClassroomRimHits(button, a) ||
                                HitButton(OnRing(85, a - sweep / 2 + .05)) != button || HitButton(OnRing(85, a + sweep / 2 - .05)) != button ||
                                HitButton(OnRing(85, a + sweep / 2)) != null || HitButton(OnRing(114, a)) != null ||
                                string.IsNullOrWhiteSpace(AutomationProperties.GetName(button))) return false;
                        }
                        return !bodyScroll.IsEffectivelyVisible && HitButton(OnRing(32, 0)) == null;
                    }
                    bool FaceFits(Button button) => LegendFits(button, false);
                    bool LegendFits(Button button, bool textOnly)
                    {
                        var label = button is BanbanToolSector ? Field<TextBlock>(button, "_caption") : button.GetVisualDescendants().OfType<TextBlock>().Single();
                        Control icon = button is BanbanToolSector ? Field<Border>(button, "_symbol") : button.GetVisualDescendants().OfType<Viewbox>().Single();
                        if (!label.IsEffectivelyVisible || string.IsNullOrWhiteSpace(label.Text)) return false;
                        var textWidth = label.TextLayout.WidthIncludingTrailingWhitespace;
                        var text = new Rect((label.Bounds.Width - textWidth) / 2, 0, textWidth, label.Bounds.Height);
                        bool Inside(Visual child, Rect rect) => new[] { rect.TopLeft, rect.TopRight, rect.BottomLeft, rect.BottomRight }
                            .All(p =>
                            {
                                var point = child.TranslatePoint(p, button)!.Value;
                                return button.Clip?.FillContains(point) ?? new Rect(button.Bounds.Size).Contains(point);
                            });
                        if (!Inside(label, text)) return false;
                        if (!icon.IsEffectivelyVisible) return textOnly;
                        if (!Inside(icon, new Rect(icon.Bounds.Size))) return false;
                        if (label.Parent is StackPanel { Orientation: Avalonia.Layout.Orientation.Horizontal })
                        {
                            var iconRight = icon.TranslatePoint(new Point(icon.Bounds.Width, icon.Bounds.Height / 2), button)!.Value;
                            var textLeft = label.TranslatePoint(new Point(text.Left, text.Center.Y), button)!.Value;
                            return iconRight.X <= textLeft.X && Math.Abs(iconRight.Y - textLeft.Y) <= 1;
                        }
                        var iconBottom = icon.TranslatePoint(new Point(icon.Bounds.Width / 2, icon.Bounds.Height), button)!.Value;
                        var textTop = label.TranslatePoint(new Point(text.Center.X, 0), button)!.Value;
                        return Math.Abs(iconBottom.X - textTop.X) <= 1 && iconBottom.Y <= textTop.Y;
                    }
                    bool FullyVisibleInChart(Control row)
                    {
                        var start = row.TranslatePoint(default, bodyScroll);
                        return start is { } p && p.Y >= -0.5 && p.Y + row.Bounds.Height <= bodyScroll.Bounds.Height + 0.5;
                    }
                    string arcIssue = "";
                    bool ArcTarget(Button button, double angle, double halfSweep, bool hitTest = true, bool textOnly = false)
                    {
                        bool Miss(string where)
                        {
                            arcIssue = $"{AutomationProperties.GetName(button)} · {where}";
                            return false;
                        }
                        if (button is not BanbanToolSector || button.Clip is not { } shape) return Miss("缺少扇面");
                        if (!LegendFits(button, textOnly) || !UsesWheelBold(button))
                        {
                            var caption = Field<TextBlock>(button, "_caption");
                            var symbol = Field<Border>(button, "_symbol");
                            return Miss($"图标 {symbol.TranslatePoint(default, wheel)} {symbol.Bounds.Size}，标签 {caption.TranslatePoint(default, wheel)} {caption.Bounds.Size}，字宽 {caption.TextLayout.WidthIncludingTrailingWhitespace:0.##}");
                        }
                        bool InShape(Point p) => wheel.TranslatePoint(p, button) is { } local && shape.FillContains(local);
                        bool Contains(Point p) => InShape(p) && (!hitTest || !button.IsEnabled || HitButton(p) == button);
                        var center = OnRing(82, angle);
                        for (int i = 0; i < 16; i++)
                        {
                            var direction = Math.Tau * i / 16;
                            var p = center + new Point(22 * Math.Cos(direction), 22 * Math.Sin(direction));
                            if (!Contains(p)) return Miss($"44 DIP 触点 {p}");
                        }
                        if (!Contains(OnRing(83, angle - halfSweep + .055)) || !Contains(OnRing(83, angle + halfSweep - .055))) return Miss("扇面外翼");
                        if (!Contains(OnRing(insideClassroomRim, angle))) return Miss("开课盘外弧内侧");
                        foreach (var gap in new[] { OnRing(outsideClassroomRim, angle), OnRing(113, angle), OnRing(83, angle - halfSweep), OnRing(83, angle + halfSweep) })
                            if (InShape(gap) || hitTest && HitButton(gap) != null) return Miss($"进度轨或分隔缝 {gap}");
                        return true;
                    }
                    bool FooterTargets(Button[] leftToRight, bool hitTest = false)
                    {
                        var sweep = (leftToRight.Length switch { 3 => 38, 2 => 57, _ => 60 }) * Math.PI / 180;
                        return leftToRight.Select((button, i) => ArcTarget(button,
                            Math.PI + ((leftToRight.Length - 1) / 2d - i) * sweep, sweep / 2, hitTest)).All(fits => fits);
                    }
                    async Task<bool> FooterFits(params Button[] leftToRight)
                    {
                        // Input hit testing follows the committed Avalonia scene after a page or geometry change.
                        await Until(() => FooterTargets(leftToRight, true), "底部扇面布局", () => arcIssue);
                        return true;
                    }
                    Task CheckReaderFooter(Control page, Control body, params string[] captions)
                    {
                        string issue = "";
                        return Until(() =>
                        {
                            var buttons = page.GetVisualDescendants().OfType<BanbanToolSector>().Where(b => b.IsEffectivelyVisible)
                                .OrderBy(b => b.TranslatePoint(new Rect(b.Bounds.Size).Center, wheel)?.X).ToArray();
                            issue = "页脚顺序或正文尺寸";
                            if (!buttons.Select(b => Field<TextBlock>(b, "_caption").Text).SequenceEqual(captions) ||
                                !body.IsEffectivelyVisible || body.Bounds.Width <= 1 || body.Bounds.Height <= 1) return false;
                            issue = "页码与底弧重叠";
                            if (page is BanbanTextReader reader && !TextClearsArcs(Field<TextBlock>(reader, "_counter"))) return false;
                            foreach (var button in buttons)
                            {
                                var name = AutomationProperties.GetName(button);
                                issue = $"{name} 的图文或扇面位置";
                                var angle = Field<double>(button, "_angle");
                                if (Math.Cos(angle) >= 0 || button.Clip is not { } shape || !FaceFits(button)) return false;
                                bool InShape(Point p) => wheel.TranslatePoint(p, button) is { } local && shape.FillContains(local);
                                bool Target(Point p) => InShape(p) && (!button.IsEnabled || HitButton(p) == button);
                                var caption = Field<TextBlock>(button, "_caption");
                                issue = $"{name} 的标签或外缘命中";
                                if (!Target(caption.TranslatePoint(new Rect(caption.Bounds.Size).Center, wheel)!.Value) ||
                                    !Target(OnRing(insideClassroomRim, angle)) || InShape(OnRing(outsideClassroomRim, angle)) ||
                                    HitButton(OnRing(outsideClassroomRim, angle)) != null) return false;
                                var center = OnRing(82, angle);
                                issue = $"{name} 的 44 DIP 触点";
                                for (var i = 0; i < 16; i++)
                                {
                                    var direction = Math.Tau * i / 16;
                                    if (!Target(center + new Point(22 * Math.Cos(direction), 22 * Math.Sin(direction)))) return false;
                                }
                                var area = new Rect(body.TranslatePoint(default, button)!.Value,
                                    body.TranslatePoint(new Rect(body.Bounds.Size).BottomRight, button)!.Value);
                                var overlap = new CombinedGeometry(GeometryCombineMode.Intersect, shape, new RectangleGeometry(area)).Bounds;
                                if (overlap.Width > 0 && overlap.Height > 0) { issue = $"{name} 与正文重叠 {overlap}"; return false; }
                            }
                            return true;
                        }, $"阅读页底弧 {string.Join("、", captions)}", () => issue);
                    }
                    bool TextClearsArcs(TextBlock caption)
                    {
                        var textWidth = caption.TextLayout.WidthIncludingTrailingWhitespace;
                        var left = (caption.Bounds.Width - textWidth) / 2;
                        var buttons = wheel.GetVisualDescendants().OfType<BanbanToolSector>().Where(b => b.IsEffectivelyVisible);
                        return buttons.All(b => Enumerable.Range(0, (int)Math.Ceiling(textWidth) + 1).All(x =>
                            !b.Clip!.FillContains(caption.TranslatePoint(new Point(left + x, 0), b)!.Value) &&
                            !b.Clip.FillContains(caption.TranslatePoint(new Point(left + x, caption.Bounds.Height), b)!.Value)));
                    }
                    bool ChartMatches(CardQuizBar[] expected, int total)
                    {
                        var rows = Field<StackPanel>(wheel, "_bars").Children.OfType<Grid>().Where(row => row.IsEffectivelyVisible).ToArray();
                        if (rows.Length != Math.Min(4, expected.Length)) return false;
                        for (var i = 0; i < rows.Length; i++)
                        {
                            var row = rows[i];
                            var label = (TextBlock)row.Children[0];
                            var rail = (Border)row.Children[1];
                            var fill = (Border)rail.Child!;
                            var amount = (TextBlock)row.Children[2];
                            var bar = expected[i];
                            var leading = bar.Count > 0 && bar.Count == expected.Max(item => item.Count);
                            var weight = leading ? FontWeight.Bold : FontWeight.Normal;
                            if (label.Text != bar.Label || amount.Text != bar.Count.ToString() || label.FontWeight != weight || amount.FontWeight != weight ||
                                !Equals(fill.Background, Field<IBrush>(wheel, leading ? "_mark" : "_otherBar")) ||
                                AutomationProperties.GetName(row)!.Contains("人数最多") != leading ||
                                fill.HorizontalAlignment != Avalonia.Layout.HorizontalAlignment.Left ||
                                Math.Abs(fill.Width - (total == 0 ? 0 : rail.Width * bar.Count / total)) > .1) return false;
                        }
                        return true;
                    }
                    async Task Until(Func<bool> ready,string label, Func<string>? detail = null)
                    {
                        for (var i=0;i<150;i++) { pet.UpdateLayout(); if (ready()) return; await Task.Delay(80); }
                        throw new InvalidOperationException("等待 "+label+"，当前主操作 "+AutomationProperties.GetName(PrimaryButton())+"，"+Field<TextBlock>(wheel,"_caption").Text+" "+detail?.Invoke());
                    }
                    Task Primary(string label) => Until(()=>AutomationProperties.GetName(PrimaryButton())==label && PrimaryButton().IsEnabled,label);
                    RenderTargetBitmap RenderPet()
                    {
                        pet.UpdateLayout();
                        var scale = pet.RenderScaling;
                        var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet.Width*scale),(int)Math.Ceiling(pet.Height*scale)),
                            new Vector(96*scale, 96*scale));
                        bitmap.Render((Visual)pet.Content!);
                        return bitmap;
                    }
                    void Snapshot(string filename)
                    {
                        using var bitmap = RenderPet();
                        bitmap.Save(Path.Combine(outputDirectory,filename));
                    }
                    async Task WaitForReviewExit(string title)
                    {
                        var closed = new TaskCompletionSource();
                        pet.PetMenu.AddAction("结束" + title + "试用", "退出", "square", () => closed.TrySetResult());
                        pet.Closed += (_, _) => closed.TrySetResult();
                        Console.WriteLine(title + "试用已就绪，可从班班右键菜单结束。");
                        await closed.Task;
                    }
                    async Task SnapshotDetail(string filename)
                    {
                        var browser = pet.ClassroomHost!.Browser;
                        using var png = new MemoryStream();
                        await browser.Core!.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, png);
                        png.Position = 0;
                        using var web = SKBitmap.Decode(png);
                        using var native = RenderPet();
                        using var nativePng = new MemoryStream();
                        native.Save(nativePng); nativePng.Position = 0;
                        using var combined = SKBitmap.Decode(nativePng);
                        var origin = pet.PointToScreen(default);
                        var start = browser.PointToScreen(default) - origin;
                        var end = browser.PointToScreen(new Rect(browser.Bounds.Size).BottomRight) - origin;
                        using (var canvas = new SKCanvas(combined))
                            canvas.DrawBitmap(web, new SKRect(start.X, start.Y, end.X, end.Y));
                        using var image = SKImage.FromBitmap(combined);
                        using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
                        using var file = File.Create(Path.Combine(outputDirectory, filename));
                        encoded.SaveTo(file);
                    }
                    void RightClickPet()
                    {
                        using var mouse = new Pointer(Pointer.GetNextFreeId(), PointerType.Mouse, true);
                        var point = talk.TranslatePoint(new Rect(talk.Bounds.Size).Center, pet)!.Value;
                        var pressed = new PointerPointProperties(RawInputModifiers.RightMouseButton, PointerUpdateKind.RightButtonPressed);
                        var released = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.RightButtonReleased);
                        talk.RaiseEvent(new PointerPressedEventArgs(talk, mouse, pet, point, 1, pressed, KeyModifiers.None));
                        talk.RaiseEvent(new PointerReleasedEventArgs(talk, mouse, pet, point, 2, released, KeyModifiers.None, MouseButton.Right));
                    }
                    async Task TouchPet(PointerType type, bool hold = false, bool move = false)
                    {
                        using var pointer = new Pointer(Pointer.GetNextFreeId(), type, true);
                        var point = talk.TranslatePoint(new Rect(talk.Bounds.Size).Center, pet)!.Value;
                        var down = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed);
                        var up = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased);
                        talk.RaiseEvent(new PointerPressedEventArgs(talk, pointer, pet, point, 1, down, KeyModifiers.None));
                        if (hold)
                        {
                            await Until(() => Field<bool>(pet,"_longPressed"), "人物静止长按");
                            Check(!pet.PetMenu.IsOpen, "长按松手前不能误选扇面");
                        }
                        if (move)
                        {
                            point += new Vector(0, -24);
                            var destination = pet.PointToScreen(point);
                            talk.RaiseEvent(new PointerEventArgs(InputElement.PointerMovedEvent, talk, pointer, pet, point, 2, down, KeyModifiers.None));
                            point = pet.PointToClient(destination);
                        }
                        talk.RaiseEvent(new PointerReleasedEventArgs(talk, pointer, pet, point, 3, up, KeyModifiers.None, MouseButton.Left));
                    }
                    RightClickPet();
                    await Until(() => pet.PetMenu.IsOpen && pet.PetMenu.Actions.All(b => b.Bounds.Width > 0), "人物右键菜单");
                    var menuView = (Control)pet.PetMenu.Content!;
                    var actions = pet.PetMenu.Actions.ToArray();
                    void SnapshotMenu(string filename)
                    {
                        var scale = TopLevel.GetTopLevel(menuView)!.RenderScaling;
                        using var bitmap = new RenderTargetBitmap(PixelSize.FromSize(menuView.Bounds.Size, scale), new Vector(96 * scale, 96 * scale));
                        bitmap.Render(menuView);
                        bitmap.Save(Path.Combine(outputDirectory, filename));
                    }
                    bool MenuRimHits()
                    {
                        var disc = ((Viewbox)menuView).Child!;
                        var sectors = pet.PetMenu.Actions.ToArray();
                        BanbanToolSector? Hit(double radius, double angle)
                        {
                            var visual = disc.InputHitTest(OnRing(radius, angle)) as Visual;
                            return visual as BanbanToolSector ?? visual?.GetVisualAncestors().OfType<BanbanToolSector>().FirstOrDefault();
                        }
                        for (var i = 0; i < sectors.Length; i++)
                        {
                            var angle = Math.Tau * i / sectors.Length;
                            if (Hit(insideClassroomRim, angle) != sectors[i] || Hit(outsideClassroomRim, angle) != null ||
                                Hit(113, angle) != null) return false;
                        }
                        return sectors.Length > 0;
                    }
                    IntPtr PopupHit(Point point)
                    {
                        var pixel = menuView.PointToScreen(point);
                        var handle = TopLevel.GetTopLevel(menuView)!.TryGetPlatformHandle()!.Handle;
                        return SendMessageW(handle, 0x0084, IntPtr.Zero, new IntPtr((ushort)pixel.X | (long)(ushort)pixel.Y << 16));
                    }
                    var transparent = new IntPtr(-1);
                    Check(PopupHit(new Point(120, 44)) != transparent && new[] { new Point(3,3), new Point(237,3),
                        new Point(3,237), new Point(237,237) }.All(p => PopupHit(p) == transparent),
                        "右键原生弹层四角穿透课件，圆内接收点击");
                    var names = actions.Select(AutomationProperties.GetName);
                    Check(names.SequenceEqual(["课堂功能","打开对话","停止操作","启用语音","大小","移回桌面右下角","隐藏班班"]) &&
                        actions.All(FaceFits) &&
                        !pet.ClassroomExpanded && pet.ClassroomHost is null, "右键沿圆周显示七个操作，打开菜单不启动课堂");
                    await Until(MenuRimHits, "人物独立右键菜单沿用开课盘外缘，109 DIP 命中扇面，111 DIP 不命中扇面");
                    for (var i = 0; i < actions.Length; i++)
                    {
                        var a = Math.Tau * i / actions.Length;
                        var center = new Point(120 + 76 * Math.Sin(a), 120 - 76 * Math.Cos(a));
                        var gap = a + Math.PI / actions.Length;
                        var seam = new Point(120 + 76 * Math.Sin(gap), 120 - 76 * Math.Cos(gap));
                        Check(actions[i].Clip!.FillContains(menuView.TranslatePoint(center, actions[i])!.Value) &&
                            actions.All(b => !b.Clip!.FillContains(menuView.TranslatePoint(seam, b)!.Value)), $"右键扇面 {i+1} 与分隔缝的命中边界");
                    }
                    SnapshotMenu("native-pet-context.png");
                    Click(actions[0]); await Primary("开始课堂");
                    Check(!pet.PetMenu.IsOpen && pet.ClassroomExpanded, "右键课堂入口展开原课堂圆环");
                    pet.SetClassroomExpanded(false);
                    await TouchPet(PointerType.Touch, hold:true);
                    await Until(() => pet.PetMenu.IsOpen, "贴边班班长按松手显示快捷圆环");
                    var menuCenter = Field<Button>(pet.PetMenu,"_close");
                    Check(!pet.ClassroomExpanded && AutomationProperties.GetName(menuCenter) == "收起菜单" && chats==0 && talks==0,
                        "长按只展示菜单，没有启动课堂、说话或对话");
                    Click(menuCenter);
                    await TouchPet(PointerType.Touch); await Primary("开始课堂");
                    Console.WriteLine($"原生窗口缩放 {pet.RenderScaling:P0}，圆环与人物 {pet.Width:0.##} × {pet.Height:0.##} DIP");
                    Check(OnlyPet() && pet.ClassroomExpanded && talks==0 && chats==0 && mascot.AssetsLoaded,"课中单击原人物即展开同窗课堂");
                    if (videoCadence)
                    {
                        var host = pet.ClassroomHost!;
                        var camera = Field<BanbanCameraLens>(pet,"_cameraLens");
                        var image = Field<Image>(camera,"_frame");
                        Click(PrimaryButton()); await Primary("开始收答");
                        var startup = System.Diagnostics.Stopwatch.StartNew();
                        long visibleAt = -1, firstFrameAt = -1;
                        void LensChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
                        {
                            if (e.Property == Visual.IsVisibleProperty && camera.IsVisible && visibleAt < 0) visibleAt = startup.ElapsedMilliseconds;
                        }
                        void ImageChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
                        {
                            if (e.Property == Image.SourceProperty && image.Source is WriteableBitmap && firstFrameAt < 0) firstFrameAt = startup.ElapsedMilliseconds;
                        }
                        camera.PropertyChanged += LensChanged; image.PropertyChanged += ImageChanged;
                        Click(PrimaryButton()); await Primary("结束收答");
                        await Until(() => image.Source is WriteableBitmap, "真实 WebView2 交付连续取景");
                        camera.PropertyChanged -= LensChanged; image.PropertyChanged -= ImageChanged;
                        Check(visibleAt >= 0 && firstFrameAt >= visibleAt, $"点击收答后原生取景框 {visibleAt} ms，首帧 {firstFrameAt} ms");
                        await Wait("Number(document.getElementById('received').textContent) === 2");
                        var liveBitmap = image.Source;
                        var frames = 0;
                        void CountFrame(string key, Stream pixels) => frames++;
                        host.PreviewPixels += CountFrame;
                        var watch = System.Diagnostics.Stopwatch.StartNew();
                        await Task.Delay(6000);
                        var fps = frames / watch.Elapsed.TotalSeconds;
                        Check(fps >= 20 && ReferenceEquals(image.Source,liveBitmap), $"原生取景 {fps:F1} 帧/秒，六秒采样 {frames} 帧，复用同一显示位图");
                        var renderedFrames = new HashSet<string>();
                        for (var sample = 0; sample < 5; sample++)
                        {
                            using var rendering = new RenderTargetBitmap(PixelSize.FromSize(image.Bounds.Size, 1));
                            rendering.Render(image);
                            using var png = new MemoryStream();
                            rendering.Save(png);
                            renderedFrames.Add(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(png.ToArray())));
                            await Task.Delay(90);
                        }
                        Check(renderedFrames.Count >= 3, $"取景控件五次绘制得到 {renderedFrames.Count} 幅不同画面");
                        var fold = camera.GetVisualDescendants().OfType<Button>().Single(b=>AutomationProperties.GetName(b)=="收起取景，继续扫码");
                        Click(fold); await Until(()=>image.Source == null,"收起清空画面");
                        var folded = frames; await Task.Delay(350);
                        Check(frames == folded && await Read("document.getElementById('camera').srcObject.active"),"收起后停止绘制并继续用原镜头识卡");
                        Click(camera.GetVisualDescendants().OfType<Button>().Single(b=>AutomationProperties.GetName(b)=="展开取景，正在扫码"));
                        await Until(()=>frames>folded && image.Source!=null,"原取景框重新出画");
                        Click(PrimaryButton());
                        await Wait("!document.getElementById('camera').srcObject");
                        await Until(()=>!camera.IsVisible && image.Source==null,"封存清空实时取景");
                        host.PreviewPixels -= CountFrame;
                        return;
                    }
                    if (smallClass || interactive)
                    {
                        Click(PrimaryButton()); await Primary("开始收答"); Click(PrimaryButton()); await Primary("结束收答");
                        await Wait("Number(document.getElementById('received').textContent) >= 2");
                        if (!smallClass)
                        {
                            var camera = Field<BanbanCameraLens>(pet, "_cameraLens");
                            await Until(() => camera.IsEffectivelyVisible && Field<Image>(camera, "_frame").Source != null, "两张测试纸卡取景");
                            Click(ButtonFor("课堂工具"));
                            Check(await RingFits() && Tool("pause") == ButtonFor("暂停收答") && Tool("camera") == null &&
                                Tool("exempt") == null && VisibleTools().All(FaceFits) && camera.IsEffectivelyVisible &&
                                await Read("document.getElementById('camera').srcObject?.active===true"), "取景试用在收答工具盘继续扫码");
                            Snapshot("native-camera-preview.png");
                            await WaitForReviewExit("取景");
                            return;
                        }
                        if (interactive)
                        {
                            pet.SetClassroomExpanded(false);
                            await Wait("!document.getElementById('camera').srcObject && document.getElementById('round-status').textContent.includes('已暂停')");
                            pet.SetClassroomExpanded(true); await Primary("继续收答");
                        }
                        await OpenAllCards();
                        await Until(() => Find("12 号卡，待收") != null && !wheel.BrowserDetailVisible, "十二张卡的原生圆环");
                        var ring = Field<BanbanCardOverview>(wheel,"_cardRing");
                        var marks = ring.GetVisualDescendants().OfType<BanbanToolSector>().Where(b=>b.ActionId=="card").ToArray();
                        Check(marks.Length==12 && marks.Select((b,i)=>HitButton(OnRing(84,Math.Tau*i/12))==b).All(hit=>hit)
                            && pet.ClassroomHost!.Browser.Width==1, "12 个纸卡号按顺时针实点命中，网页让出圆周");
                        Snapshot("native-card-overview-12.png");
                        Click(ButtonFor("12 号卡，待收")); await Until(()=>Find("上一页卡号")?.IsEnabled == true,"进入第 2 页明细");
                        Check(ButtonFor("12 号卡，待收").IsFocused && Find("12 号卡，免答")==null && NoCardFilter(),"定位卡号只打开明细并聚焦该卡，明细隐藏筛选入口");
                        Click(ButtonFor("12 号卡，待收")); await Until(()=>Find("12 号卡，免答")!=null, "切换免答");
                        Check(OnlyPet() && Field<CardQuizWheelState>(wheel,"_state").Lesson.Expected==11, "明细免答调用原收答逻辑");
                        Snapshot("native-card-detail-12.png");
                        Click(ButtonFor("12 号卡，免答")); await Until(()=>Find("12 号卡，待收")!=null,"恢复 12 号应答");
                        Click(ButtonFor("上一页卡号")); await Until(()=>Find("下一页卡号")?.IsEnabled==true,"顺圆周翻页");
                        Click(ButtonFor("返回")); await Until(()=>Find("上一页卡号")==null && Find("12 号卡，待收")?.IsFocused==true,"返回到原卡号");
                        var smallState = Field<CardQuizWheelState>(wheel, "_state");
                        var smallPanel = smallState.CardPanel!;
                        ring.Update(smallPanel with { PendingOnly=true, ReadOnly=true, Cards=[] },
                            smallState.Lesson with { Missing=[], Received=12 });
                        Check(Field<TextBlock>(ring, "_title").Text!.Contains("已收齐") && Find(allCards)?.IsEnabled == true &&
                            Field<Canvas>(ring, "_ring").Children.Count == 0, "小班收齐后待收总览为空，仍可切换到全班");
                        ring.Update(smallPanel, smallState.Lesson);
                        if (interactive) await WaitForReviewExit("核卡");
                        return;
                    }
                    // The cached roster enables the home button before the startup bootstrap reply.
                    // Finish a refresh on the same queue before presenting synthetic setup states.
                    await pet.ClassroomHost!.Browser.Core!.ExecuteScriptAsync("document.getElementById('refresh').click()");
                    await Wait("!document.getElementById('refresh').disabled");
                    await Until(() => Field<CardQuizWheelState>(wheel, "_state").Setup is { Busy: false, CanCreate: true },
                        "离线名单刷新完成");
                    Snapshot("native-pet-home.png");
                    var initial = Field<CardQuizWheelState>(wheel,"_state");
                    var homeActions = new[] { PrimaryButton(), ButtonFor("开课设置"), ButtonFor("更多操作"), ButtonFor("说话") };
                    await Until(() => homeActions.Select((b,i) => ArcTarget(b, i*Math.PI/2, Math.PI/4, true)).All(fits=>fits),
                        "开课四个等分扇面图文完整，触控直径 44 DIP", () => arcIssue);
                    Check(true, "开课在顶部，设置、更多和说话顺时针排列");
                    wheel.Update(initial with { Actions = [..initial.Actions.Where(a => a.Id != "end-session"), new("end-session", "待同步课堂", "", true)] });
                    pet.UpdateLayout();
                    var bottom = OnRing(82, Math.PI);
                    Touch(bottom,bottom);
                    await Until(() => menuCenter.IsFocused, "首页从六点钟打开更多");
                    await Until(MenuRimHits, "开课切到更多，正上方同一触点仍在扇面内，外侧留空");
                    SnapshotMenu("native-pet-home-more.png");
                    Check(pet.PetMenu.Actions.Any(b=>b.ActionId=="待同步课堂") &&
                        pet.PetMenu.Actions.All(b=>AutomationProperties.GetName(b)!="课堂功能"), "已有待同步课堂时可在更多中找到记录");
                    Click(menuCenter);
                    Check(homeActions[2].IsFocused, "更多圆心返回到原入口");
                    var pendingEntry = new CardQuizDiscItem("lesson-14","09:10","十一月一日数学","book-open", Enabled:false, Mark:"11/1");
                    var historyPage = new CardQuizDiscPage("history/3", "ring", "待同步课堂", [pendingEntry]);
                    var waitingHistory = initial with { Panel="history", PanelTitle="待同步课堂", DiscPage=historyPage };
                    wheel.Update(waitingHistory);
                    pet.UpdateLayout();
                    Check(ButtonFor("返回").IsFocused, "载入历史记录时可从圆心返回");
                    wheel.Update(waitingHistory with { DiscPage=historyPage with { Items=[pendingEntry with { Enabled=true }], FocusId=pendingEntry.Id } });
                    Check(ButtonFor(pendingEntry.Name).IsFocused, "待同步末页在异步载入后恢复刚查看的记录焦点");
                    var longName = "高一物理与跨学科联合教学实验班（临时合班上课）";
                    wheel.Update(initial with { Lesson = initial.Lesson with { Heading = longName } });
                    pet.UpdateLayout();
                    var heading = Field<TextBlock>(wheel,"_heading");
                    Check(heading.TextTrimming == TextTrimming.CharacterEllipsis && Equals(ToolTip.GetTip(heading),longName) &&
                        heading.Bounds.Width <= bodyScroll.Bounds.Width && Find("开始课堂")==PrimaryButton(),"长班名保留全称，开课按钮仍可用");
                    wheel.ShowError(string.Concat(Enumerable.Repeat("记录暂时无法读取，请核对本地保存状态后重试。",8)));
                    pet.UpdateLayout();
                    Check(PrimaryButton().IsEnabled && Find("重读记录")==PrimaryButton() &&
                        bodyScroll.Extent.Height <= bodyScroll.Viewport.Height + .5,"读取错误时原因和重读同时可见");
                    Click(ButtonFor("记录待核对详情"));
                    var reason = Field<BanbanTextReader>(wheel, "_messageReader");
                    var firstPage = Field<TextBlock>(reason, "_counter").Text;
                    Click(ButtonFor("下一页"));
                    Check(Field<TextBlock>(reason, "_counter").Text != firstPage && Find("返回") != null && Find("重读记录")?.IsEnabled == true,
                        "长错误在原盘翻页，返回和重读固定在底弧");
                    await CheckReaderFooter(reason, Field<TextBlock>(reason, "_body"), "上页", "返回", "重读", "下页");
                    Click(ButtonFor("返回"));
                    Check(Find("重读记录")==PrimaryButton(), "从错误详情返回后可立即重读");
                    wheel.Update(initial);
                    Check(Math.Abs(Anchor().X-anchor.X)<=2 && Math.Abs(Anchor().Y-anchor.Y)<=2,"展开时人物屏幕坐标稳定");
                    var screenPoint = pet.PointToScreen(new Point(1,1));
                    var packed = (long)(ushort)screenPoint.X | ((long)(ushort)screenPoint.Y << 16);
                    object[] hitArgs = [IntPtr.Zero,(uint)0x0084,IntPtr.Zero,new IntPtr(packed),false];
                    Check((IntPtr)typeof(BanbanPetWindow).GetMethod("HitTest",Private)!.Invoke(pet,hitArgs)! == new IntPtr(-1) && (bool)hitArgs[4],"圆环外透明角可穿透课件");
                    bool TopActionHit()
                    {
                        var button = PrimaryButton();
                        var center = button.TranslatePoint(new Rect(button.Bounds.Size).Center, pet);
                        return center is { } point && pet.InputHitTest(point) is Visual hit &&
                            (hit == button || hit.GetVisualAncestors().Contains(button));
                    }
                    await Until(TopActionHit, "顶部操作真实命中");
                    Check(TopActionHit(), "顶部操作真实命中");
                    Check(Find("课表")==null,"开课页只保留课堂入口和说话等操作");
                    Click(ButtonFor("说话")); Click(PrimaryButton()); Check(talks==1 && OnlyPet(),"圆环说话使用原语音回调");
                    Click(ButtonFor("返回课堂")); Click(ButtonFor("开课设置"));
                    var setup = Field<BanbanClassroomSetup>(wheel,"_setup");
                    pet.UpdateLayout();
                    Check(setup.IsVisible && OnlyPet() && pet.Height == BanbanClassroomWheel.Diameter && !wheel.ContainsInteractive(new Point(15,15)) &&
                        Math.Abs(Anchor().X-anchor.X)<=2 && Math.Abs(Anchor().Y-anchor.Y)<=2,"开课设置留在原圆盘，四角穿透且人物位置稳定");
                    var rosterLabel = Field<TextBlock>(setup,"_roster");
                    var setupState = initial.Setup!;
                    var plainSetup = initial with { Error = false, Feedback = "", Setup = setupState with { Notice = "" } };
                    wheel.Update(plainSetup);
                    var sourceName = "出题方式，" + setupState.Publications.First().Label;
                    var typeName = "首题题型，" + setupState.Templates.First().Label;
                    async Task CheckSetupRing(string[] names, string description, bool textOnly = false)
                    {
                        var angle = Math.Tau / names.Length;
                        await Until(() => names.Select((name, i) => ArcTarget(ButtonFor(name), angle * i, angle / 2, textOnly: textOnly)).All(hit => hit),
                            description, () => arcIssue);
                        Check(true, description);
                    }
                    await CheckSetupRing([sourceName, typeName, "联网刷新", "开始课堂", "返回", "学科，语文"], "设置六块扇面同屏，图文在弧内，44 DIP 触点和分隔缝正确");
                    Check(rosterLabel.Text == "60" && TextClearsArcs(rosterLabel) && Find("查看名单详情") == null,
                        "中心显示已校验的纸卡数，三个设置都无需滚动");
                    Snapshot("native-pet-setup.png");
                    ButtonFor(sourceName).Focus();
                    ButtonFor(sourceName).RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Left });
                    Check(ButtonFor("学科，语文").IsFocused, "设置可用方向键沿圆切换");
                    Touch(OnRing(83, -Math.PI/3), OnRing(83, -Math.PI/3));
                    await CheckSetupRing(setupState.Subjects.Select(o => o.Label).ToArray(), "九门学科可在一圈内直接点选", textOnly: true);
                    Check(ButtonFor("语文").IsFocused && AutomationProperties.GetItemStatus(ButtonFor("语文")) == "已选" &&
                        HitButton(OnRing(0,0)) == ButtonFor("返回"), "学科选择聚焦已选项，圆心整块可返回");
                    Snapshot("native-pet-setup-subjects.png");
                    Click(ButtonFor("数学")); Check(Find("学科，数学")?.IsFocused==true,"同窗选择学科并返回原字段");
                    Click(ButtonFor(typeName));
                    await CheckSetupRing(setupState.Templates.Select(o => o.Label).ToArray(), "七种首题设置同时显示题型和选项范围");
                    Snapshot("native-pet-setup-types.png");
                    var threeOptions = setupState.Templates.Single(o => o.Value == "single:3");
                    Click(ButtonFor(threeOptions.Label));
                    var threeName = "首题题型，" + threeOptions.Label;
                    Check(ButtonFor(threeName).IsFocused && ButtonFor(threeName).GetVisualDescendants().OfType<TextBlock>().Any(t => t.Text == "A-C"),
                        "原扇面直接显示所选题型的选项范围");
                    Click(ButtonFor(threeName)); Click(ButtonFor(setupState.Templates.First().Label));
                    async Task<string> ReadSetupPages()
                    {
                        var reader = Field<BanbanTextReader>(setup, "_reader");
                        var body = Field<TextBlock>(reader, "_body");
                        var text = new System.Text.StringBuilder();
                        while (true)
                        {
                            pet.UpdateLayout();
                            if (!body.IsEffectivelyVisible || body.TextLayout.Height > body.Bounds.Height + 1 ||
                                body.TextLayout.TextLines.Any(line => line.HasCollapsed))
                                throw new InvalidOperationException("圆盘阅读器正文被截断");
                            text.Append(body.Text);
                            if (Find("下一页") is not { IsEnabled: true } next) return text.ToString();
                            var counter = Field<TextBlock>(reader, "_counter");
                            var before = counter.Text;
                            var caption = Field<TextBlock>(next, "_caption");
                            var point = caption.TranslatePoint(new Rect(caption.Bounds.Size).Center, wheel)!.Value;
                            await Until(() => HitButton(point) == next, "下页圆弧可以触控");
                            Touch(point, point);
                            if (before == counter.Text) throw new InvalidOperationException("圆弧翻页没有前进");
                        }
                    }
                    var longDeck = new CardQuizWheelOption("long-deck", "高一数学跨学科课件配套纸卡课堂练习题单（第二单元综合练习与课堂复习） · 18 题 · 已缓存");
                    var decks = Enumerable.Range(1, 52).Select(n => new CardQuizWheelOption($"deck-{n}", $"高一数学第 {n} 课"));
                    var deckSetup = plainSetup with { Setup = plainSetup.Setup! with { Publications = [..setupState.Publications, ..decks, longDeck] } };
                    wheel.Update(deckSetup);
                    Click(ButtonFor(sourceName)); pet.UpdateLayout();
                    Check(ButtonFor(setupState.Publications[0].Label) is BanbanToolSector { IsFocused: true } &&
                        Find(longDeck.Label) == null, "长名单先在圆周显示已选课件所在页");
                    for (var i = 0; i < deckSetup.Setup!.Publications.Length && Find("下一页选项") is { } nextSet; i++) Click(nextSet);
                    Click(ButtonFor("查看本页完整名称"));
                    Check((await ReadSetupPages()).Contains(longDeck.Label), "末页同前缀题单按扇面编号能读全名称、题数和缓存状态");
                    Click(ButtonFor("返回"));
                    Check(ButtonFor("查看本页完整名称").IsFocused && ButtonFor(longDeck.Label) is BanbanToolSector, "读完返回原页，可直接点选题单");
                    Click(ButtonFor(longDeck.Label));
                    Check(Find("学科，数学") == null && Find(typeName) == null && ButtonFor("开始课堂").IsEnabled &&
                        ButtonFor("出题方式，" + longDeck.Label).IsFocused, "题单使用自身学科和题型");
                    await CheckSetupRing(["出题方式，" + longDeck.Label, "联网刷新", "开始课堂", "返回"], "选题单后四个操作等分整圈，仍在圆底开课");
                    Click(ButtonFor("查看题单全名"));
                    Check(await ReadSetupPages() == longDeck.Label, "已选题单圆心可读全名");
                    Click(ButtonFor("返回"));
                    Click(ButtonFor("出题方式，" + longDeck.Label));
                    Check(ButtonFor(longDeck.Label).IsFocused && Find("下一页选项") == null, "重开环选时锚定末页的已选题单");
                    wheel.Update(plainSetup); pet.UpdateLayout();
                    Check(ButtonFor(sourceName).IsFocused && ButtonFor("学科，数学").IsVisible && ButtonFor(typeName).IsVisible, "刷新撤回题单后回到课件并保留原学科");

                    var longNotice = string.Concat(Enumerable.Repeat("学校连接中断，本机名单可以继续上课。\r\n请核对 A-12。", 12));
                    wheel.Update(plainSetup with { Setup = plainSetup.Setup! with { Notice = longNotice } });
                    Click(ButtonFor("查看提示")); pet.UpdateLayout();
                    var noticeReader = Field<BanbanTextReader>(setup, "_reader");
                    await CheckReaderFooter(noticeReader, Field<TextBlock>(noticeReader, "_body"), "上页", "返回", "下页");
                    Check(ButtonFor("返回").IsFocused && Find("下一页")?.IsEnabled == true &&
                        await ReadSetupPages() == longNotice && ButtonFor("上一页").IsEnabled, "缓存可用时长提示可沿圆弧逐页读完，原文完整");
                    Click(ButtonFor("返回")); Check(ButtonFor("查看提示").IsFocused && ButtonFor("开始课堂").IsEnabled, "提示返回原位后仍可开课");
                    wheel.Update(plainSetup with { Setup = setupState with { Notice="名单和题单已刷新。", Refreshed=true, CardCount=157 } });
                    pet.UpdateLayout();
                    Check(Find("查看提示") == null && Field<TextBlock>(setup,"_hint").Text == "已刷新" && rosterLabel.Text == "157" &&
                        TextClearsArcs(rosterLabel) && TextClearsArcs(Field<TextBlock>(setup,"_unit")), "刷新成功直接确认，三位数纸卡数量与单位仍在圆心内");
                    wheel.Update(plainSetup with { Setup = setupState with { CanCreate=false, CanRefresh=false, Busy=true } });
                    Check(!ButtonFor("开始课堂").IsEnabled && !ButtonFor("联网刷新").IsEnabled && !ButtonFor("返回").IsEnabled && wheel.BackFromSetup(),
                        "刷新中阻止重复操作");
                    wheel.Update(plainSetup with { Setup = setupState with { CanCreate=false, CardCount=null, Roster="本班还没有学生", Notice="" } });
                    Check(!ButtonFor("开始课堂").IsEnabled && ButtonFor("联网刷新").IsEnabled && Field<TextBlock>(setup,"_statusText").Text!.Contains("还没有学生"),
                        "无可用名单时显示原因并可刷新");
                    await CheckSetupRing(["查看名单详情", "联网刷新", "开始课堂", "返回"], "无名单可点左右两侧刷新或返回，开课保持禁用");
                    var recovery = new CardQuizWheelOption("saved-class", "数学 · 11月22日 08:30");
                    var recoverySetup = plainSetup with { Setup = setupState with { CanCreate=false, CardCount=null, Roster="上次课堂未结束", Recovery=recovery, Notice="" } };
                    wheel.Update(recoverySetup);
                    Check(ButtonFor("恢复课堂").IsEnabled && Find("开始课堂") == null && Find(sourceName) == null &&
                        Field<TextBlock>(setup,"_statusText").Text!.Contains(recovery.Label), "恢复时显示原课堂，入口仍在六点钟方向");
                    await CheckSetupRing(["查看上次课堂", "联网刷新", "恢复课堂", "返回"], "恢复操作位于底弧，左右两侧均可点按");
                    wheel.Update(recoverySetup with { Error=true, Feedback=longNotice });
                    Click(ButtonFor("查看错误"));
                    var recoveryText = await ReadSetupPages();
                    Check(recoveryText.Contains(recovery.Label) && recoveryText.Contains(longNotice), "恢复页同时保留课堂身份和完整长错误");
                    Click(ButtonFor("返回"));
                    Check(ButtonFor("查看错误").IsFocused && ButtonFor("恢复课堂").IsEnabled, "读完恢复错误后回原位，可重试恢复");
                    wheel.Update(plainSetup);
                    Click(ButtonFor("开始课堂")); await Primary("开始收答");
                    await Wait("document.getElementById('class-name').textContent.includes('数学')");
                    Check(Math.Abs(pet.Height-BanbanClassroomWheel.Diameter)<=1,"进入题目后还原紧凑圆环");
                    Snapshot("native-pet-ready.png");
                    var readyMorePoint = OnRing(82, 4 * Math.PI / 3);
                    Touch(readyMorePoint, readyMorePoint);
                    await Until(() => pet.PetMenu.IsOpen && menuCenter.IsFocused, "备题时点左下更多");
                    await Until(MenuRimHits, "备题更多沿用开课盘外缘");
                    SnapshotMenu("native-pet-ready-more.png");
                    Click(menuCenter);
                    Check(ButtonFor("更多操作").IsFocused && PrimaryButton() == Find("开始收答"), "返回备题后焦点回到更多");
                    Touch(bottom, bottom);
                    await Primary("确认结课");
                    Click(ButtonFor("取消"));
                    Check(ButtonFor("结课").IsFocused && PrimaryButton() == Find("开始收答"), "备题盘正下方打开结课确认，取消后回到结课扇面");
                    var toolsEntry = ButtonFor("课堂工具");
                    Check(new[] {PrimaryButton(),ButtonFor("单选"),ButtonFor("判断"),ButtonFor("多选"),ButtonFor("结课"),toolsEntry}.All(UsesWheelBold) &&
                        toolsEntry.GetVisualDescendants().OfType<Viewbox>().Any(icon => icon.IsEffectivelyVisible) &&
                        toolsEntry.GetVisualDescendants().OfType<TextBlock>().Any(label => label.IsEffectivelyVisible && label.Text == "工具"),
                        "主操作、题型和页脚使用微软雅黑粗体，工具入口同时显示图标与文字");
                    var unselected = ButtonFor("判断");
                    var hover = (IPseudoClasses)unselected.Classes;
                    hover.Add(":pointerover"); pet.UpdateLayout();
                    Check(unselected is BanbanToolSector && FaceFits(unselected) && UsesWheelBold(unselected) &&
                        ButtonFor("单选").Classes.Contains("selected"), "悬停未选题型时保留粗体和原选中项");
                    hover.Remove(":pointerover");
                    var readyToolsPoint = OnRing(82, 2 * Math.PI / 3);
                    Touch(readyToolsPoint, readyToolsPoint);
                    Snapshot("native-pet-tools.png");
                    var readyTools = VisibleTools();
                    Check(readyTools.Select(b => b.ActionId).SequenceEqual(["source","edit","next","voice"]) && await RingFits() &&
                        Find("课表")==null && Find("下一页")==null && OnlyPet(), "备题工具按顺序等分圆环，扇面内外缘与分隔缝命中正确");
                    Check(readyTools.All(FaceFits) && FaceFits(ButtonFor("返回课堂")), "备题工具和圆心返回均常显居中的图标与文字");
                    var firstTool = readyTools[0];
                    firstTool.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Down });
                    var editing = ButtonFor("题目答案");
                    Check(editing.IsFocused && VisibleTools().All(FaceFits), "键盘顺时针选择工具时，所有图标和文字仍完整可见");
                    var detailFace = Field<BanbanClassroomDetail>(wheel,"_detail");
                    BanbanToolSector? DetailSector(string id) => detailFace.GetVisualDescendants().OfType<BanbanToolSector>()
                        .FirstOrDefault(button => button.IsEffectivelyVisible && button.ActionId == id);
                    async Task EnterDetail(string id)
                    {
                        await Until(() => DetailSector(id) is { IsEnabled:true }, "可点的详情扇面 " + id);
                        Click(DetailSector(id)!);
                    }
                    Click(editing);
                    await Until(() => ClassroomRimHits(DetailSector("edit"), 0), "题目页顶部设置扇面沿用开课盘外缘");
                    await EnterDetail("edit");
                    await Until(() => ClassroomRimHits(DetailSector("answer-a"), 0), "答案页顶部 A 扇面沿用开课盘外缘");
                    await EnterDetail("answer-b");
                    await Until(() => DetailSector("answer-b")?.Classes.Contains("selected") == true, "B 答案的选中态");
                    Check(!wheel.BrowserDetailVisible && DetailSector("save") is { IsEnabled:true } &&
                        HitButton(OnRing(0,0)) == ButtonFor("返回"), "标准答案沿圆周直接选择，保存和返回同时可点");
                    Snapshot("native-disc-answers.png");
                    await EnterDetail("fields"); await EnterDetail("stem");
                    await Until(()=>wheel.BrowserDetailVisible && DetailSector("save")!=null, "圆心题干编辑区");
                    Task WaitForBrowserBounds(string label, bool checkCorners = false)
                    {
                        var browser = pet.ClassroomHost!.Browser;
                        Rect target = default;
                        PixelRect actual = default, expected = default;
                        return Until(() =>
                        {
                            target = wheel.BrowserDetailBounds;
                            actual = ScreenBounds(browser);
                            expected = new PixelRect(wheel.PointToScreen(target.TopLeft), wheel.PointToScreen(target.BottomRight));
                            // Layout can round the origin and the size separately at fractional display scales.
                            return wheel.BrowserDetailVisible && Math.Abs(actual.X - expected.X) <= 1 &&
                                Math.Abs(actual.Y - expected.Y) <= 1 && Math.Abs(actual.Right - expected.Right) <= 1 &&
                                Math.Abs(actual.Bottom - expected.Bottom) <= 1 && (!checkCorners ||
                                new[] { actual.TopLeft, actual.TopRight, actual.BottomLeft, actual.BottomRight }
                                    .All(p => wheel.ContainsInteractive(wheel.PointToClient(p))));
                        }, label, () => $"Browser.Width={browser.Width}, Height={browser.Height}, Bounds={browser.Bounds} DIP, " +
                            $"目标 Rect={target} DIP, 实际屏幕边界={actual} px, 目标屏幕边界={expected} px, RenderScaling={pet.RenderScaling}");
                    }
                    await WaitForBrowserBounds("同步编辑正文像素边界");
                    await CheckReaderFooter(detailFace, pet.ClassroomHost!.Browser, "返回", "保存");
                    await SnapshotDetail("native-disc-edit-stem.png");
                    Click(ButtonFor("返回")); await Until(()=>DetailSector("stem")?.IsFocused==true,"字段入口恢复焦点");
                    Click(ButtonFor("返回")); await Until(()=>DetailSector("fields")?.IsFocused==true,"答案盘恢复焦点");
                    Click(ButtonFor("返回")); await Until(()=>DetailSector("edit")?.IsFocused==true,"返回题目页");
                    Click(ButtonFor("返回")); await Until(()=>!wheel.DetailVisible && editing.IsFocused,"回到原题工具");
                    var toolSweep = Math.Tau / readyTools.Length;
                    Touch(OnRing(82, toolSweep * .35), OnRing(82, toolSweep * .65));
                    await Task.Delay(150);
                    Check(!wheel.DetailVisible && VisibleTools().SequenceEqual(readyTools), "从扫码扇区按住滑到相邻扇区松开，不执行任一工具");
                    var voiceEdge = OnRing(96, (Array.FindIndex(readyTools, b => b.ActionId == "voice") - .33) * toolSweep);
                    Touch(voiceEdge, voiceEdge);
                    Check(Find("开始说话") == PrimaryButton(), "触摸麦克风扇面外翼可打开说话");
                    Click(ButtonFor("返回工具"));
                    Click(ButtonFor("返回课堂"));
                    Check(ButtonFor("课堂工具").IsFocused && Find("开始收答")==PrimaryButton(),"返回课堂后焦点回到原题工具入口");
                    var readyState = Field<CardQuizWheelState>(wheel,"_state");
                    wheel.Update(readyState with { Lesson = readyState.Lesson with { Primary = "advance", Label = "准备第一题" } });
                    pet.UpdateLayout();
                    var readyActions = new[] { "判断", "多选", "课堂工具", "结课", "更多操作", "单选" };
                    await Until(() => HitButton(OnRing(0,0)) == PrimaryButton() && readyActions.Select((name,i) =>
                        ArcTarget(ButtonFor(name), i * Math.PI/3, Math.PI/6)).All(hit => hit), "备题页六块扇面的命中和文字", () => arcIssue);
                    Check(true, "备题上半圈从左到右为单选、判断、多选，下半圈从左到右为更多、结课、工具，圆心收答");
                    wheel.Update(readyState with { Lesson = readyState.Lesson with { CanChooseType = false } });
                    var fixedActions = new[] { "查看题目", "结课", "更多操作", "课堂工具" };
                    await Until(() => Find("单选") is null && fixedActions.Select((name, i) =>
                        HitButton(OnRing(82, i * Math.PI / 2)) == ButtonFor(name)).All(hit => hit), "固定题型使用原位四扇面");
                    Click(ButtonFor("课堂工具"));
                    Check(Tool("edit") == null && await RingFits(), "固定题型从主盘查看题目，其余工具按可见数量等分");
                    Click(ButtonFor("返回课堂"));
                    wheel.Update(readyState);
                    Click(ButtonFor("课堂工具"));
                    wheel.Update(readyState with { Actions = readyState.Actions.Select(a => a.Id == "source" ? a with { Label = "换回本机" } : a).ToArray() });
                    var localCamera = ButtonFor("换回本机");
                    Check(localCamera.GetVisualDescendants().OfType<Avalonia.Controls.Shapes.Path>().Any(path => path.Data is RectangleGeometry) &&
                        localCamera.GetVisualDescendants().OfType<TextBlock>().Any(label => label.IsEffectivelyVisible && label.Text == "本机"),
                        "使用手机时原扫码位置显示本机屏幕图标和返回本机的名称");
                    wheel.Update(readyState);
                    wheel.Update(readyState with { Error = true, Feedback = "手机暂时无法配对" });
                    Check(reason.IsEffectivelyVisible && Field<TextBlock>(reason,"_body").Text=="手机暂时无法配对", "工具操作失败时在原圆盘显示原因");
                    Click(ButtonFor("返回"));
                    Check(Find("开始收答")==PrimaryButton(), "读完提示后回到备题圆心");
                    wheel.Update(readyState);
                    PrimaryButton().Focus();
                    var previous = PrimaryButton();
                    foreach (var name in new[] { "单选", "判断", "多选", "课堂工具", "结课", "更多操作" })
                    {
                        previous.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Right });
                        var target = ButtonFor(name);
                        Check(target.IsFocused && target.TabIndex == previous.TabIndex + 1, $"备题方向键与 Tab 顺序一致，到达{name}");
                        previous = target;
                    }
                    PrimaryButton().Focus();
                    PrimaryButton().RaiseEvent(new KeyEventArgs { RoutedEvent=InputElement.KeyDownEvent, Key=Key.End });
                    Check(ButtonFor("更多操作").IsFocused,"End 可达左下的更多扇面");
                    wheel.FocusAction(ButtonFor("更多操作"),Key.Left);
                    Check(ButtonFor("结课").IsFocused,"从更多逆时针回到正下方结课");
                    PixelRect ScreenBounds(Visual control) => new(control.PointToScreen(default),
                        control.PointToScreen(new Rect(control.Bounds.Size).BottomRight));
                    PixelPoint DiscCenter() => wheel.PointToScreen(new Point(120,120));
                    pet.UpdateLayout();
                    var discPosition = DiscCenter();
                    var originalDisc = ScreenBounds(wheel);
                    bool DiscStayed() => Math.Abs(DiscCenter().X-discPosition.X)<=1 && Math.Abs(DiscCenter().Y-discPosition.Y)<=1;
                    PrimaryButton().Focus(); PressEnter(PrimaryButton());
                    var menuProgress = Field<BanbanClassroomProgress>(pet.PetMenu,"_progress");
                    if (twoCardVideo != null)
                    {
                        await Until(() => Field<CardQuizWheelState>(wheel,"_state").Lesson.Phase == "collect", "等待相机进入收答");
                        Touch(bottom,bottom);
                        Check(pet.PetMenu.IsOpen && Field<CardQuizWheelState>(wheel,"_state").Lesson.Received == 0, "在第一张卡入账前点开更多");
                        await Until(() => Field<CardQuizWheelState>(wheel,"_state").Lesson.Received == 2, "更多打开时识别两张视频纸卡");
                        Check(pet.PetMenu.IsOpen && menuProgress.Segment.IsEffectivelyVisible &&
                            Math.Abs(menuProgress.Segment.SweepAngle - 720d / cardNumbers.Length) < .01 && await Read("document.getElementById('camera').srcObject?.active===true"),
                            "更多停留期间两张卡从相机入账，外圈随真实收答增长");
                        Click(menuCenter);
                    }
                    await Primary("结束收答");
                    await Wait("document.getElementById('camera').srcObject?.active===true");
                    if (twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    var lens = Field<BanbanCameraLens>(pet,"_cameraLens");
                    var lensFrame = Field<Image>(lens,"_frame");
                    await Until(() => lens.IsEffectivelyVisible && lensFrame.Source != null, "原生取景收到相机图像");
                    bool LensAboveWheel()
                    {
                        pet.UpdateLayout();
                        var frame = ScreenBounds(lens);
                        var disc = ScreenBounds(wheel);
                        return Math.Abs(frame.Center.X - disc.Center.X) <= 1 &&
                            Math.Abs(disc.Y - frame.Bottom - 8 * disc.Width / 240d) <= 1;
                    }
                    void CheckLensHit(Point local, int expectedHit, string label)
                    {
                        var pixel = lens.PointToScreen(local);
                        var hit = SendMessageW(pet.TryGetPlatformHandle()!.Handle, 0x0084, IntPtr.Zero,
                            new IntPtr((ushort)pixel.X | (long)(ushort)pixel.Y << 16));
                        Check(hit == new IntPtr(expectedHit), $"{label}（屏幕 {pixel}，WM_NCHITTEST={hit}，预期 {expectedHit}）");
                    }
                    Button LensButton(string name) => lens.GetVisualDescendants().OfType<Button>()
                        .Single(b => b.IsEffectivelyVisible && AutomationProperties.GetName(b) == name);
                    pet.UpdateLayout();
                    var frameBounds = ScreenBounds(lens);
                    var discBounds = ScreenBounds(wheel);
                    var currentCenter = DiscCenter();
                    var workArea = (pet.Screens.ScreenFromPoint(discPosition) ??
                        throw new InvalidOperationException($"找不到原圆心 {discPosition} 所在屏幕")).WorkingArea;
                    Check(OnlyPet(), "取景与圆盘共用班班原窗");
                    Check(workArea.Contains(frameBounds) && workArea.Contains(discBounds),
                        $"取景 {frameBounds} 与圆盘 {discBounds} 完整位于工作区 {workArea}");
                    var expectedY = Math.Clamp(discPosition.Y, workArea.Y + currentCenter.Y - frameBounds.Y,
                        workArea.Bottom - (discBounds.Bottom - currentCenter.Y));
                    var hostBounds = ScreenBounds((Visual)pet.Content!);
                    var expectedX = Math.Clamp(discPosition.X, workArea.X + currentCenter.X - hostBounds.X,
                        workArea.Right - (hostBounds.Right - currentCenter.X));
                    Check((originalDisc.Width != discBounds.Width || Math.Abs(currentCenter.X - expectedX) <= 1) &&
                        Math.Abs(currentCenter.Y - expectedY) <= 1,
                        $"开镜头仅在空间不足时移动圆盘（圆心 {discPosition} 到 {currentCenter}，预期 {expectedX}, {expectedY}）");
                    discPosition = currentCenter;
                    var videoBounds = ScreenBounds(lensFrame);
                    var pixelScale = discBounds.Width / BanbanClassroomWheel.Diameter;
                    var video = BanbanCameraLens.VideoSize;
                    Check(frameBounds.Width > discBounds.Width && Math.Abs(videoBounds.Width - video.Width * pixelScale) <= 1 &&
                        Math.Abs(videoBounds.Height - video.Height * pixelScale) <= 1 && videoBounds.Width == frameBounds.Width &&
                        frameBounds.Bottom - videoBounds.Bottom >= 44 * pixelScale - 1,
                        $"宽取景完整显示 16:9 画面，操作条在下方（画面 {videoBounds.Size}，含操作条 {frameBounds.Size}，盘宽 {discBounds.Width} px）");
                    Check(LensAboveWheel(), $"取景居于圆盘正上方并留 8 DIP 间隙（取景 {frameBounds}，圆盘 {discBounds}）");
                    var frameSize = (lensFrame.Source as Bitmap)?.PixelSize;
                    Check(lensFrame.Source is WriteableBitmap && frameSize is { Width: 640, Height: 360 }, $"原生取景收到共享视频帧（{frameSize}）");
                    Check(lensFrame.Stretch == Stretch.Uniform, $"取景等比完整显示（Stretch={lensFrame.Stretch}）");
                    CheckLensHit(new Point(20, 3), 1, "横框内侧接收点击");
                    foreach (var corner in new[] { new Point(1,1), new Point(lens.Width-1,1),
                        new Point(1,lens.Height-1), new Point(lens.Width-1,lens.Height-1) })
                        CheckLensHit(corner, -1, $"取景圆角 {corner} 可穿透课件");
                    CheckLensHit(new Point(lens.Width / 2, lens.Height + 4), -1, "取景与圆盘之间可穿透课件");
                    CheckLensHit(new Point(10, lens.Height + 60), -1, "宽取景下方、圆盘外的课件仍可点击");
                    var sourceButton = LensButton("电脑取景，选择相机来源");
                    var foldButton = LensButton("收起取景，继续扫码");
                    var toolbarButtons = new[] { sourceButton, foldButton, LensButton("关闭当前相机") };
                    var toolbarBounds = toolbarButtons.Select(b => ScreenBounds(b)).ToArray();
                    Check(toolbarButtons.All(b => b.Height >= 44 && b.Width >= 44) &&
                        toolbarBounds.All(r => r.Y >= videoBounds.Bottom && r.Y == toolbarBounds[0].Y && frameBounds.Contains(r)) &&
                        toolbarBounds[0].Right <= toolbarBounds[1].X && toolbarBounds[1].Right <= toolbarBounds[2].X &&
                        toolbarButtons.All(b => b.GetVisualDescendants().OfType<Viewbox>().Any(v => v.IsEffectivelyVisible) &&
                            !b.GetVisualDescendants().OfType<TextBlock>().Any(t => t.IsEffectivelyVisible && !string.IsNullOrWhiteSpace(t.Text))),
                        "来源、收起和关相机均为单行图标，各有独立触控区");
                    Click(sourceButton);
                    pet.UpdateLayout();
                    var phoneChoice = LensButton("暂停本轮，改用手机扫码");
                    var boardChoice = LensButton("电脑，当前来源");
                    Check(phoneChoice.IsFocused && !boardChoice.IsEnabled && phoneChoice.Bounds.Y == boardChoice.Bounds.Y &&
                        LensButton("返回取景").Bounds.Y == phoneChoice.Bounds.Y && lens.Back() && sourceButton.IsFocused,
                        "取景下沿单行选择来源，返回后焦点回到当前来源");
                    Click(foldButton);
                    await Until(() => Field<Button>(lens,"_dock").IsEffectivelyVisible, "收起取景");
                    var dockButton = LensButton("展开取景，正在扫码");
                    pet.UpdateLayout();
                    CheckLensHit(new Point(1,1), -1, "扫描图标四角可穿透课件");
                    Check(lensFrame.Source == null && DiscStayed() && LensAboveWheel() && dockButton.IsFocused &&
                        await Read("document.getElementById('camera').srcObject?.active===true"),
                        "收起后焦点落在扫描图标，释放显示帧并继续采集");
                    Click(dockButton);
                    await Until(() => lensFrame.Source != null, "扫描图标恢复实时取景");
                    Check(foldButton.IsFocused && DiscStayed() && LensAboveWheel(), "重新展开取景保持圆盘原位和操作焦点");
                    var beforeCameraClose = Field<CardQuizWheelState>(wheel,"_state").Lesson;
                    Click(LensButton("关闭当前相机")); await Primary("开启相机");
                    await Wait("!document.getElementById('camera').srcObject");
                    Check(!lens.IsEffectivelyVisible && lensFrame.Source == null &&
                        Field<CardQuizWheelState>(wheel,"_state").Lesson.Received == beforeCameraClose.Received,
                        "取景条关闭相机后保留已收卡，主盘可重新开启");
                    Click(PrimaryButton()); await Primary("结束收答");
                    await Until(() => lensFrame.Source != null && LensAboveWheel(), "从主盘恢复本轮取景");
                    RightClickPet();
                    await Until(() => pet.PetMenu.IsOpen, "收答中右键人物");
                    await Until(() => Math.Abs(ScreenBounds(menuView).Center.X - DiscCenter().X) <= 1 &&
                        Math.Abs(ScreenBounds(menuView).Center.Y - DiscCenter().Y) <= 1, "宽取景时快捷圆环与课堂圆盘重合");
                    Click(actions.Single(b => b.ActionId == "大小"));
                    await Until(() => pet.PetMenu.Sizing && Field<Slider>(pet,"_sizeSlider").IsFocused, "同盘大小滑杆");
                    var sizeFooter = menuView.GetVisualDescendants().OfType<BanbanToolSector>().Where(b => b.IsEffectivelyVisible).ToArray();
                    var limits = menuView.GetVisualDescendants().OfType<TextBlock>().Where(b => b.Text is "25%" or "150%").ToArray();
                    Check(sizeFooter.Length == 2 && sizeFooter.All(FaceFits) && limits.Length == 2 && limits.All(label =>
                        new[] { new Rect(label.Bounds.Size).BottomLeft, new Rect(label.Bounds.Size).BottomRight }.All(p =>
                            sizeFooter.All(b => !b.Clip!.FillContains(label.TranslatePoint(p, b)!.Value)))),
                        "大小页刻度与两块底弧分开，返回和默认图文完整");
                    SnapshotMenu("native-pet-context-size.png");
                    Field<Slider>(pet,"_sizeSlider").RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
                    var sizeEntry = actions.Single(b => b.ActionId == "大小");
                    Check(sizeEntry.IsFocused && !pet.PetMenu.Sizing, "收答中返回原大小扇面");
                    sizeEntry.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
                    Check(!pet.PetMenu.IsOpen && talk.IsFocused && pet.ClassroomExpanded && DiscStayed() &&
                        await Read("document.getElementById('camera').srcObject?.active===true") &&
                        Field<CardQuizWheelState>(wheel,"_state").Lesson is { Number:1, Phase:"collect" },
                        "收起右键菜单后焦点回到人物，当前题和相机继续收答");
                    var collectSectors = Field<Canvas>(wheel,"_lessonActions").Children.OfType<BanbanToolSector>().Where(b=>b.IsEffectivelyVisible).ToArray();
                    Snapshot("native-pet-collect.png");
                    Check(collectSectors.Length == 4 && collectSectors.Select((b,i)=>ArcTarget(b,i*Math.PI/2,Math.PI/4,true)).All(fits=>fits),
                        "收答四块扇面的图文和整块触控目标都在圆内 " + arcIssue);
                    var liveState = Field<CardQuizWheelState>(wheel,"_state");
                    var track = wheel.Progress.Rail;
                    var progress = wheel.Progress.Segment;
                    bool ProgressClearsSector(Visual disc, BanbanToolSector sector, BanbanClassroomProgress ring)
                    {
                        // This ray crosses the top sector and the painted part of both partial progress arcs.
                        Point Local(double radius, Visual target) => disc.TranslatePoint(OnRing(radius, Math.PI / 12), target)!.Value;
                        bool StrokeFits(Avalonia.Controls.Shapes.Shape shape)
                        {
                            if (!shape.IsEffectivelyVisible || shape.StrokeThickness != 5 ||
                                shape.RenderedGeometry is not { } geometry) return false;
                            var pen = new Pen(shape.Stroke, shape.StrokeThickness);
                            bool Painted(double r) => geometry.StrokeContains(pen, Local(r, shape));
                            return !Painted(110.5) && Painted(112) && Painted(115) && !Painted(117);
                        }
                        return sector.Clip is { } clip && clip.FillContains(Local(insideClassroomRim, sector)) &&
                            !clip.FillContains(Local(110.5, sector)) && StrokeFits(ring.Rail) && StrokeFits(ring.Segment);
                    }
                    void ShowCount(int received, int expected) => wheel.Update(liveState with {
                        Lesson = liveState.Lesson with { Received = received, Expected = expected,
                            Missing = Enumerable.Range(received+1, expected-received).ToArray() } });
                    ShowCount(0,60);
                    Check(track.IsVisible && !progress.IsVisible, "零人已收只显示空轨");
                    ShowCount(42,60);
                    await Until(() => ProgressClearsSector(wheel, collectSectors[0], wheel.Progress),
                        "收答扇面外沿与 5 DIP 进度轨之间留 1 DIP 缝");
                    Check(progress.IsVisible && progress.StartAngle == -90 && Math.Abs(progress.SweepAngle - 252) < .01 &&
                        progress.Stroke is ISolidColorBrush ink && ink.Color == Field<ISolidColorBrush>(wheel,"_accentInk").Color &&
                        track.Stroke is ISolidColorBrush rail && rail.Color != ink.Color,
                        "外圈用主题蓝从正上方按整圈比例显示 42/60");
                    Snapshot("native-pet-collect-progress.png");
                    Touch(bottom,bottom);
                    await Until(() => pet.PetMenu.IsOpen && menuCenter.IsFocused, "收答中轻点更多");
                    var wheelCenter = wheel.PointToScreen(new Point(120,120));
                    var popupCenter = menuView.PointToScreen(new Rect(menuView.Bounds.Size).Center);
                    Check(Math.Abs(popupCenter.X-wheelCenter.X)<=2 && Math.Abs(popupCenter.Y-wheelCenter.Y)<=2 &&
                        pet.PetMenu.Actions.Count()==6 && pet.PetMenu.Actions.All(FaceFits) &&
                        AutomationProperties.GetName(menuCenter)=="返回课堂", "原位六扇面，圆心返回");
                    await Until(MenuRimHits, "收答更多沿用开课盘外缘，进度轨不命中扇面");
                    ShowCount(43,60);
                    await Until(() => Math.Abs(menuProgress.Segment.SweepAngle - 360d * 43 / 60) < .01 &&
                        ProgressClearsSector(((Viewbox)menuView).Child!, pet.PetMenu.Actions.First(), menuProgress),
                        "更多保持打开，已收从 42 增至 43 时进度实时更新，扇面和轨道之间仍有留缝");
                    ShowCount(0,0);
                    await Until(() => !menuProgress.Rail.IsEffectivelyVisible && MenuRimHits(),
                        "失去进度分母时隐藏轨道，原位触点保持不变");
                    ShowCount(44,60);
                    await Until(() => menuProgress.Rail.IsEffectivelyVisible && MenuRimHits(),
                        "进度恢复时显示轨道，原位触点保持不变");
                    Check(menuProgress.Segment.IsEffectivelyVisible && Math.Abs(menuProgress.Segment.SweepAngle-264)<.01 &&
                        await Read("document.getElementById('camera').srcObject?.active===true"), "更多打开期间相机继续，外圈实时更新到 44/60");
                    SnapshotMenu("native-pet-collect-more.png");
                    Click(menuCenter);
                    Check(ButtonFor("更多操作").IsFocused && DiscStayed() && Field<TextBlock>(wheel,"_number").Text=="44",
                        "圆心返回原题、人数与更多按钮");
                    ShowCount(60,60);
                    Check(track.IsVisible && !progress.IsVisible && Equals(track.Stroke, progress.Stroke) &&
                        Find("已收齐，查看卡号") == collectSectors[1], "全部收齐时闭合整圈，右侧仍可查看卡号");
                    ShowCount(0,0);
                    Check(!track.IsVisible && !progress.IsVisible && Find("全员免答，查看卡号") == collectSectors[1],
                        "全班免答时无进度分母，右侧保留查卡入口");
                    wheel.Update(liveState);
                    lesson = new Window { Width=600,Height=420,Position=pet.Position,ShowInTaskbar=false,Content=new Border { Background=Brushes.White } };
                    lesson.Show(); lesson.Activate(); await Task.Delay(3400);
                    Check(await Read("document.getElementById('camera').srcObject?.active && document.getElementById('camera-status').textContent==='相机已开启'"),"课件取焦后采集继续");
                    lesson.Close(); lesson=null; pet.Activate();
                    Click(ButtonFor("课堂工具"));
                    var pause = ButtonFor("暂停收答");
                    Check(Tool("pause") == pause && Field<TextBlock>(pause,"_caption").Text == "暂停" && Tool("camera") == null &&
                        Tool("exempt") == null && Tool("options") == null && Tool("seal") == null &&
                        await RingFits() && VisibleTools().All(FaceFits), "单选收答时工具显示暂停，结束收答和查卡各在主盘原位");
                    Snapshot("native-pet-collect-tools.png");
                    var questionTool = ButtonFor("查看题目");
                    Click(questionTool); await Wait("document.body.dataset.pane==='question'");
                    Check(wheel.DetailVisible && DiscStayed() && wheel.Bounds.Size == new Size(240,240) && LensAboveWheel() &&
                        await Read("document.getElementById('camera').srcObject?.active === true"), "查看题目在原圆盘内打开并保持采集");
                    await WaitForBrowserBounds("同步查看题目正文像素边界并确认四角在圆内", checkCorners: true);
                    Check(true, "网页原生子窗口及四角完全位于圆内");
                    var screen = pet.ClassroomHost!.Browser.PointToScreen(new Point(50,70));
                    var childPoint = new NativePoint { X=screen.X,Y=screen.Y }; var handle=pet.TryGetPlatformHandle()!.Handle;
                    ScreenToClient(handle,ref childPoint); var child=ChildWindowFromPointEx(handle,childPoint,1);
                    Check(child!=IntPtr.Zero && child!=handle && OnlyPet(),"阅读详情位于同一窗口并命中原生网页控件");
                    await SnapshotDetail("native-pet-question-detail.png");
                    Click(ButtonFor("返回")); await Until(() => !wheel.DetailVisible && questionTool.IsFocused, "看题返回原扇区");
                    Click(pause); await Primary("继续收答");
                    await Wait("!document.getElementById('camera').srcObject");
                    Check(!lens.IsEffectivelyVisible && Field<CardQuizWheelState>(wheel,"_state").Lesson.Received == liveState.Lesson.Received,
                        "暂停工具释放取景并保留本轮已收卡");
                    Click(PrimaryButton()); await Primary("结束收答");
                    var cardEntry = await OpenAllCards();
                    await Until(()=>Find("1-10 号卡") != null && !wheel.BrowserDetailVisible,"按印刷号段排成扇面");
                    var cardRing = Field<BanbanCardOverview>(wheel, "_cardRing");
                    var cardState = Field<CardQuizWheelState>(wheel, "_state");
                    var cardPanel = cardState.CardPanel!;
                    Check(wheel.DetailVisible && wheel.Bounds.Size == new Size(240,240) && LensAboveWheel() &&
                        !wheel.ContainsInteractive(new Point(15,15)) && cardPanel is { Overview:true, Grouped:true, PendingOnly:false } &&
                        Field<TextBlock>(cardRing,"_count").Text == cardState.Lesson.Received.ToString() &&
                        Field<TextBlock>(cardRing,"_total").Text == "/ 60" && Find("下一页卡号") == null &&
                        await Read("document.querySelectorAll('#card-map [data-card]').length===60 && !document.getElementById('card-overview').hidden"),
                        "核卡在原圆盘一次展示全班 60 张卡及本项已收人数");
                    Snapshot("native-pet-card-check.png");
                    var dots = Field<Avalonia.Controls.Primitives.UniformGrid>(ButtonFor("1-10 号卡"),"_cardDots");
                    Point Dot(int column) => dots.TranslatePoint(new Point(dots.Bounds.Width*(column+.5)/5,dots.Bounds.Height/4),wheel)!.Value;
                    Touch(Dot(3),Dot(3)); await Task.Delay(120);
                    Check(Find("1-10 号卡")!=null,"跳号处留空，点空位停留在整班核卡");
                    Touch(Dot(4),Dot(4)); await Until(()=>Find("5 号卡，待收")?.IsFocused==true,"点阵中的 5 号定位对应卡");
                    PressEnter(ButtonFor("5 号卡，待收"));
                    await Until(() => Find("5 号卡，免答")?.IsFocused == true &&
                        Field<CardQuizWheelState>(wheel,"_state").Lesson is { Expected:59, Busy:false }, "全班明细用键盘设为免答");
                    PressEnter(ButtonFor("5 号卡，免答"));
                    await Until(() => Find("5 号卡，待收")?.IsFocused == true &&
                        Field<CardQuizWheelState>(wheel,"_state").Lesson is { Expected:60, Busy:false }, "再次回车恢复 5 号应答");
                    Click(ButtonFor("返回")); await Until(()=>Find("1-10 号卡")?.IsFocused==true,"点阵返回原号段");
                    Click(ButtonFor("61 号卡"));
                    await Until(()=>Find("61 号卡，待收")?.IsFocused==true && !wheel.BrowserDetailVisible,"大班从点阵定位末页扇面");
                    Check(NoCardFilter() && Find("下一页卡号") == null && HitButton(OnRing(82, 6 * Math.Tau / 7)) == ButtonFor("上一页卡号"),
                        "六张明细和唯一可用的翻页键在末页等分整圈");
                    Snapshot("native-card-detail-60.png");
                    Click(ButtonFor("返回")); await Until(()=>Find("61 号卡")?.IsFocused==true,"回到整班号段");
                    // The host can refresh its 60-card roster while Avalonia commits a synthetic page for hit testing.
                    var ringParent = (Panel)cardRing.Parent!;
                    var ringSlot = ringParent.Children.IndexOf(cardRing);
                    var sampleRing = new BanbanCardOverview { IsVisible = true };
                    ringParent.Children[ringSlot] = sampleRing;
                    try
                    {
                        sampleRing.Update(cardPanel with { Cards = cardPanel.Cards.Take(53).ToArray() }, cardState.Lesson);
                        Check(Field<Canvas>(sampleRing, "_ring").Children.Count == 6 && Find("下一页卡号") == null, "53 张普通纸卡仍在一圈显示六个号段");
                        var sparseMarks = Enumerable.Range(0, 16).Where(row => row is not (7 or 12 or 14)).SelectMany(row => new[] {
                            new CardQuizCardMark(10 * row + 2, "pending"), new CardQuizCardMark(Math.Min(157, 10 * row + 9), "received")
                        }).ToArray();
                        var sparsePanel = cardPanel with { Cards = sparseMarks, Located = null, PendingOnly = false, ReadOnly = false };
                        var optionC = cardState.Lesson with { Kind="multiple", Option="C", Received=13, Expected=26 };
                        Task WaitForCardPage(params string[] clockwise)
                        {
                            var sectors = clockwise.Select(ButtonFor).ToArray();
                            var sweep = Math.Tau / sectors.Length;
                            // The input scene can still describe the previous page after UpdateLayout.
                            return Until(() => sectors.Select((sector, i) => ArcTarget(sector, i * sweep, sweep / 2)).All(hit => hit),
                                "核卡末页扇面 " + string.Join("、", clockwise), () => arcIssue);
                        }
                        sampleRing.Update(sparsePanel, optionC);
                        Click(ButtonFor("下一页卡号"));
                        sampleRing.Update(sparsePanel, optionC);
                        Check(Field<TextBlock>(sampleRing, "_pageLabel").Text == "2/3", "实时收答更新保留稀疏总览页");
                        Click(ButtonFor("下一页卡号"));
                        await WaitForCardPage("151-157 号卡", "上一页卡号");
                        Check(Field<TextBlock>(sampleRing, "_pageLabel").Text == "3/3" && Field<Canvas>(sampleRing, "_ring").Children.Count == 1 &&
                            Field<TextBlock>(sampleRing, "_title").Text!.Contains("C 项") && Find("下一页卡号") == null,
                            "跨十三个非空号段逐页核对，末页一个实际号段与上页各占半圈");
                        sampleRing.Update(sparsePanel with { Overview=false, Grouped=false, Page=4, Pages=5, Located=157,
                            ReadOnly=true, Cards=sparseMarks[^2..] }, optionC);
                        await WaitForCardPage("152 号卡，待收", "157 号卡，已收", "上一页卡号");
                        Check(ButtonFor("157 号卡，已收").IsFocused && Field<TextBlock>(sampleRing, "_title").Text!.Contains("只读") &&
                            Field<Canvas>(sampleRing, "_ring").Children.Count == 2 && Find("下一页卡号") == null,
                            "稀疏明细末页按两张卡和上页重排，聚焦真实卡号并保留只读");
                        sampleRing.Update(sparsePanel with { Located=157 }, optionC);
                        Check(ButtonFor("151-157 号卡").IsFocused && Field<TextBlock>(sampleRing, "_pageLabel").Text == "3/3",
                            "从明细返回时定位实际卡号所在的总览末页");
                        sampleRing.Update(sparsePanel with { Located=157, Grouped=false, PendingOnly=true, ReadOnly=true,
                            Cards=sparseMarks[^2..].Select(mark => mark with { State="pending" }).ToArray() },
                            optionC with { Missing=[152,157] });
                        Check(ButtonFor("157 号卡，待收").IsFocused, "待收缩到十二张以内时保留原号段内所选的实际卡号");
                        sampleRing.Update(cardPanel with { PendingOnly=true, Grouped=false, ReadOnly=true, Cards=[] },
                            cardState.Lesson with { Missing=[] });
                        Check(Field<Canvas>(sampleRing, "_ring").Children.Count == 0 && Field<TextBlock>(sampleRing, "_title").Text!.Contains("已收齐") &&
                            ButtonFor("返回").IsFocused && Find(allCards)?.IsEnabled == true, "大班已收齐时焦点回到圆心，空圆周仍可切回全班");
                    }
                    finally
                    {
                        ringParent.Children[ringSlot] = cardRing;
                        cardRing.FocusCard(61);
                    }
                    Click(ButtonFor(pendingCards));
                    await Until(() => Field<CardQuizWheelState>(wheel,"_state").CardPanel is { Overview:true, PendingOnly:true, ReadOnly:true } &&
                        Find(allCards)?.IsEnabled == true, "从全班切回只读待收总览");
                    Click(ButtonFor("返回"));
                    await Until(()=>!wheel.DetailVisible && cardEntry.IsFocused,"核卡返回右侧入口");
                    Check(Field<CardQuizWheelState>(wheel,"_state").Lesson is { Number:1, Phase:"collect" } && NoCardFilter(),
                        "核卡逐层返回本题收答，主盘隐藏筛选入口");
                    pet.SetClassroomExpanded(false);
                    await Wait("document.getElementById('round-status').textContent.includes('已暂停') && !document.getElementById('camera').srcObject");
                    Check(Math.Abs(pet.Width-restSize.Width)<1 && Math.Abs(pet.Height-restSize.Height)<1 && pet.IsVisible,"收起后释放相机，课中人物仍在");
                    pet.SetClassroomExpanded(true); await Primary("继续收答"); Click(PrimaryButton()); await Primary("结束收答");
                    if (twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    var store = CardQuizService.For(config).Store;
                    var journal = store.Load()["journals"]!.AsArray().Single()!["session"]!;
                    var id = journal["id"]!.GetValue<string>(); var file=Path.Combine(Field<string>(store,"_root"),"sessions",id+".json");
                    using (var locked=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read))
                    {
                        Click(PrimaryButton()); await Primary("重读记录");
                        Check(await Read("!document.getElementById('round-status').textContent.includes('封存')"),"落盘失败不会展示虚假分布");
                    }
                    Click(PrimaryButton()); await Primary("恢复课堂"); Click(PrimaryButton()); await Primary("继续收答");
                    Check(store.Load()["journals"]!.AsArray().Count==1 && (twoCardVideo==null || await Read("document.getElementById('received').textContent==='2'")),"重读恢复同一轮及已收卡");
                    var sealedPrimary = twoCardVideo is null ? "重收" : "下一题";
                    Button Advance() => Find("跳过本题") ?? ButtonFor("下一题");
                    Click(PrimaryButton()); await Primary("结束收答"); Click(PrimaryButton()); await Primary(sealedPrimary);
                    var state=Field<CardQuizWheelState>(wheel,"_state");
                    Check(state.Lesson.Phase=="result" && state.Panel=="" && !lens.IsVisible && lensFrame.Source == null &&
                        (twoCardVideo==null || state.Lesson.Bars.Select(bar => bar.Count).SequenceEqual([1,1,0,0])),"封存关闭取景并在圆环展示匿名条形图");
                    Check(ChartMatches(state.Lesson.Received == 0 ? [] : state.Lesson.Bars, state.Lesson.Received),
                        "有作答时按真实人数画条，并列最多的选项同时加重");
                    Snapshot("native-pet-wheel.png");
                    var resultPrimary = PrimaryButton();
                    var resultToolsEntry = ButtonFor("课堂工具");
                    var resultFinish = ButtonFor("结课");
                    var resultButtons = new[] { resultToolsEntry, resultPrimary, resultFinish };
                    var finishTouch = OnRing(83, Math.PI * .8);
                    Check(await FooterFits(resultButtons) && (Find("跳过本题") is not { } skip || HitButton(new Point(120, 36)) == skip),
                        "圆底三个扇面各容纳直径 44 DIP 的触点，跳题可用时仍在顶弧");
                    var chartEntry = ButtonFor("查看作答分布");
                    var chartPoint = chartEntry.TranslatePoint(new Rect(chartEntry.Bounds.Size).Center, wheel)!.Value;
                    Check(HitButton(chartPoint) == chartEntry && chartEntry.Focusable, "原生图表可触摸并支持键盘焦点");
                    Touch(chartPoint, chartPoint);
                    await Wait("document.body.dataset.pane==='distribution' && !document.getElementById('distribution').hidden");
                    await Until(() => wheel.BrowserDetailVisible && Find("返回") != null, "原生图表打开本题分布");
                    await CheckReaderFooter(detailFace, pet.ClassroomHost!.Browser, "返回");
                    Click(ButtonFor("返回"));
                    await Until(() => !wheel.DetailVisible && chartEntry.IsFocused, "分布返回图表入口");
                    Touch(finishTouch, OnRing(83, Math.PI * 161 / 180));
                    Check(Find("确认结课") == null && Find(sealedPrimary) == resultPrimary, "从结课滑到弧间留白松手，仍停在分布");
                    resultToolsEntry.Focus(NavigationMethod.Tab);
                    resultToolsEntry.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Tab });
                    Check(resultPrimary.IsFocused, "Tab 从左侧工具到圆底主操作");
                    resultPrimary.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Tab, KeyModifiers = KeyModifiers.Shift });
                    Check(resultToolsEntry.IsFocused, "Shift+Tab 按弧面顺序返回");
                    wheel.FocusAction(resultPrimary, Key.Left); Check(resultToolsEntry.IsFocused, "结果页向左键到工具");
                    wheel.FocusAction(resultPrimary, Key.Right); Check(resultFinish.IsFocused, "结果页向右键到结课");
                    Touch(finishTouch, finishTouch); await Primary("确认结课");
                    var cancel = ButtonFor("取消");
                    await FooterFits(cancel, PrimaryButton());
                    Snapshot("native-pet-result-confirm.png");
                    var cancelTouch = OnRing(83, Math.PI * 1.15);
                    Touch(cancelTouch, cancelTouch);
                    Check(resultFinish.IsFocused, "触控取消结课后焦点回到结课入口");
                    wheel.Update(state with { Lesson = state.Lesson with { Busy = true, Enabled = false } });
                    Check(resultButtons.All(b => b.IsEffectivelyVisible && !b.IsEnabled), "保存时结果页三个按钮原位禁用");
                    wheel.Update(state with { Lesson = state.Lesson with { Number=100, Heading="第 100 题", Primary="finish", Label="结课" } });
                    pet.UpdateLayout();
                    Check(FooterTargets([resultToolsEntry, resultPrimary]), "末题保留两个对称的底弧");
                    Check(!resultFinish.IsEffectivelyVisible && Find("结课")==resultPrimary,
                        "达到题目上限后主操作改为结课，仅保留一个结课入口");
                    Click(resultPrimary); Click(ButtonFor("取消")); Check(resultPrimary.IsFocused, "末题取消结课后回到主操作");
                    var empty = Field<TextBlock>(wheel,"_emptyResult");
                    var emptyCount = Field<TextBlock>(wheel,"_emptyCount");
                    var tally = Field<TextBlock>(wheel,"_answered");
                    var note = Field<TextBlock>(wheel,"_caption");
                    var emptyState = state with { Lesson = state.Lesson with { Received=0, Expected=12, Bars=[new("A",0),new("B",0),new("C",0),new("D",0)], Caption="弃权 12", Incomplete=0, Abstained=12, Primary="collect", Label="重收" } };
                    wheel.Update(emptyState); pet.UpdateLayout();
                    Check(empty.IsEffectivelyVisible && empty.Text=="弃权 12 人" && !note.IsEffectivelyVisible &&
                        emptyCount.IsEffectivelyVisible && emptyCount.Text=="0 / 12" && track.IsVisible && !progress.IsVisible &&
                        !tally.IsEffectivelyVisible && ChartMatches([],0), "12 人弃权显示作答比例、空轨和简短状态");
                    Snapshot("native-pet-result-empty.png");
                    Check(ButtonFor("重收")==PrimaryButton() && ButtonFor("跳过本题").IsEnabled && ButtonFor("结课").IsEnabled,
                        "无人作答可在原页重收、跳过本题或结课");
                    Click(ButtonFor("课堂工具"));
                    Check(Tool("collect") == null && Tool("distribution") == null && await RingFits(),
                        "无人作答的结果工具隐藏主盘已有的重收与分布");
                    Click(ButtonFor("返回课堂"));
                    wheel.Update(emptyState with { Lesson = emptyState.Lesson with { QuestionCount=100 } });
                    Check(Find("跳过本题")==null && ButtonFor("重收")==PrimaryButton() && ButtonFor("结课").IsEnabled, "末题无人作答可重收或结课");
                    wheel.Update(emptyState with { Error=true, Feedback="学校连接暂时中断" });
                    Check(note.IsEffectivelyVisible && note.Text=="学校连接暂时中断", "空状态仍显示操作错误");
                    wheel.Update(emptyState with { Lesson = emptyState.Lesson with { Expected=0, Caption="", Primary="advance", Label="下一题" } });
                    Check(empty.Text=="全员免答" && !emptyCount.IsVisible && !note.IsVisible && !tally.IsVisible &&
                        !track.IsVisible && ChartMatches([],0), "全员免答有独立状态且无进度分母");
                    CardQuizBar[] singleBars = [new("A",27), new("B",18), new("C",9), new("D",6)];
                    wheel.Update(state with { Lesson = state.Lesson with { Expected=60, Received=60, Bars=singleBars, Caption="", Primary="advance", Label="下一题" } });
                    pet.UpdateLayout();
                    Check(!empty.IsVisible && ChartMatches(singleBars,60) && tally.Text=="已答 60 / 60" &&
                        AutomationProperties.GetName(tally)=="已答 60 人，应答 60 人" &&
                        track.IsVisible && !progress.IsVisible && Equals(track.Stroke, progress.Stroke),
                        "全班作答后在原处显示四行人数和闭合的外圈");
                    Snapshot("native-pet-result-full.png");
                    wheel.Update(state);
                    Click(ButtonFor("课堂工具")); pet.UpdateLayout();
                    var resultTools = VisibleTools();
                    var answerTool = ButtonFor("设置与揭晓答案");
                    var sealedCards = ButtonFor("核对卡号");
                    Check(Tool("edit") == answerTool && Field<TextBlock>(answerTool,"_caption").Text == "答案" &&
                        Tool("exempt") == sealedCards && Tool("distribution") == null && Tool("camera") == null &&
                        (Tool("collect") != null) == (state.Lesson.Primary != "collect") &&
                        await RingFits() && Find("更多操作") != null && Find("添加题目") != null,
                        "结果工具按当前动作等分圆周，保留答案、卡号与更多，各有直径 44 的点击区");
                    Snapshot("native-pet-result-tools.png");
                    Check(resultTools.All(FaceFits) && FaceFits(ButtonFor("返回课堂")), "结果页工具和返回的图文均在按钮内");
                    Click(answerTool);
                    await Wait("document.body.dataset.pane==='question'");
                    await Until(() => DetailSector("edit")?.IsEnabled == true && DetailSector("reveal")?.IsEnabled == true,
                        "结果答案入口可设置答案或揭晓讲解");
                    Click(ButtonFor("返回")); await Until(() => answerTool.IsFocused, "答案页返回答案扇面");
                    Click(sealedCards);
                    await Until(() => Field<CardQuizWheelState>(wheel,"_state").CardPanel is { Overview:true, ReadOnly:true } &&
                        Find("61 号卡") != null, "封存后卡号总览只读");
                    Check(NoCardFilter(), "封存总览保留全班范围");
                    Click(ButtonFor("61 号卡"));
                    await Until(() => Find("61 号卡，弃权")?.IsFocused == true, "定位封存后的末张弃权卡");
                    Click(ButtonFor("61 号卡，弃权"));
                    Check(NoCardFilter() && await Read("[...document.querySelectorAll('#exempt-cards input')].every(input=>input.disabled)") &&
                        Field<CardQuizWheelState>(wheel,"_state").CardPanel is { Overview:false, ReadOnly:true },
                        "封存明细中的卡号只读");
                    Click(ButtonFor("返回")); await Until(() => Find("61 号卡")?.IsFocused == true, "封存明细返回原号段");
                    Click(ButtonFor("返回")); await Until(() => sealedCards.IsFocused, "封存卡号返回工具");
                    var resultMore = ButtonFor("更多操作");
                    Click(resultMore);
                    await Until(() => pet.PetMenu.IsOpen && menuCenter.IsFocused, "从封存后的工具进入更多");
                    Check(menuProgress.Rail.IsEffectivelyVisible && menuProgress.Fraction is double participation &&
                        Math.Abs(participation - (double)state.Lesson.Received / state.Lesson.Expected) < .001,
                        "从结果工具打开更多仍显示这道题的实际参与率");
                    Click(menuCenter);
                    Check(!pet.PetMenu.IsOpen && resultMore.IsFocused && VisibleTools().SequenceEqual(resultTools), "圆心返回封存后的原工具和焦点");
                    foreach (var button in resultTools)
                    {
                        button.Focus(NavigationMethod.Tab);
                        pet.UpdateLayout();
                        if (!button.IsFocused || !FaceFits(button))
                            throw new InvalidOperationException("焦点或图文位置有误：" + AutomationProperties.GetName(button));
                    }
                    Check(true, "每个结果页工具均可获得键盘焦点，图文保持对齐");
                    wheel.Update(state with { Actions = [], Lesson = state.Lesson with { Busy=true } });
                    Check(VisibleTools().SequenceEqual(resultTools) && resultTools.All(b => !b.IsEnabled && FaceFits(b)) &&
                        ButtonFor("返回课堂").IsEnabled, "保存时各扇区和标签原位可见，圆心仍能返回");
                    wheel.Update(state);
                    Click(ButtonFor("说话")); Click(ButtonFor("返回工具"));
                    Check(ButtonFor("说话").IsFocused, "从说话返回同一圈的麦克风");
                    Click(ButtonFor("添加题目"));
                    await Until(() => wheel.DetailVisible && DetailSector("add-single-4")?.IsEnabled == true, "打开加题扇面");
                    var activeBeforeBack = pet.IsActive;
                    Click(ButtonFor("返回"));
                    await Until(()=>!wheel.DetailVisible && Find("添加题目")?.IsFocused==true,"题目设置返回加题扇区", () => {
                        var focused = pet.FocusManager?.GetFocusedElement() as Control;
                        var opener = Field<Button?>(wheel,"_returnTo");
                        return $"菜单={Field<string>(wheel,"_view")}，详情={Field<CardQuizWheelState>(wheel,"_state").Panel}，" +
                            $"窗口活动={pet.IsActive}，当前焦点={focused?.GetType().Name} {((focused is null) ? "" : AutomationProperties.GetName(focused))}，" +
                            $"入口={((opener is null) ? "" : AutomationProperties.GetName(opener))}";
                    });
                    Check(activeBeforeBack || !pet.IsActive, "从详情恢复原扇面焦点时保留课件的前台状态");
                    Check(VisibleTools().SequenceEqual(resultTools), "退出详情后仍是同一组扇区及顺序");
                    pet.RaiseEvent(new KeyEventArgs { RoutedEvent=InputElement.KeyDownEvent, Key=Key.Escape });
                    Check(OnlyPet() && ButtonFor("课堂工具").IsFocused && Find(sealedPrimary)==PrimaryButton(), "Esc 退出工具后仍在本题匿名分布");
                    Click(Advance()); await Primary("开始收答");
                    var judgmentPoint = OnRing(82, 0); Touch(judgmentPoint, judgmentPoint);
                    await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson is { Kind:"boolean",Busy:false },"判断题");
                    Check(ButtonFor("判断").Classes.Contains("selected") && !ButtonFor("单选").Classes.Contains("selected"),
                        "题型切换使用同组的共享选中状态");
                    Click(PrimaryButton()); await Primary("结束收答"); if(twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    Click(ButtonFor("课堂工具")); Click(ButtonFor("暂停收答")); await Primary("继续收答");
                    Click(ButtonFor("课堂工具"));
                    Check(Tool("seal") == ButtonFor("封存本轮") && Tool("pause") == null && Tool("options") == null &&
                        await RingFits(), "暂停时可从工具封存当前轮");
                    Click(ButtonFor("封存本轮")); await Primary(sealedPrimary);
                    var judgment = Field<CardQuizWheelState>(wheel, "_state").Lesson;
                    if (twoCardVideo != null)
                    {
                        pet.UpdateLayout();
                        var labels = Field<StackPanel>(wheel, "_bars").Children.Where(row => row.IsVisible)
                            .Cast<Grid>().Select(row => (TextBlock)row.Children[0]).ToArray();
                        Check(ChartMatches(judgment.Bars, 2) && labels.Select(label => label.Text).SequenceEqual(["A 对", "B 错"]) &&
                            labels.All(label => label.TextLayout.TextLines.Count == 1 &&
                                label.TextLayout.WidthIncludingTrailingWhitespace <= label.Bounds.Width + .5), "判断题显示两行，选项与对错标签同行");
                        Snapshot("native-pet-result-boolean.png");
                    }
                    Click(Advance()); await Primary("开始收答");
                    var multiplePoint = OnRing(82, Math.PI / 3); Touch(multiplePoint, multiplePoint);
                    await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson is { Kind:"multiple",Busy:false },"多选题");
                    Click(PrimaryButton()); await Primary("下一项 B");
                    if(twoCardVideo!=null) await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson.Received==2,"A 项两人");
                    var currentOption = Field<TextBlock>(wheel, "_currentOption");
                    Check(currentOption.IsEffectivelyVisible && currentOption.Text == "收 A 项" && currentOption.FontWeight == FontWeight.Bold &&
                        Field<TextBlock>(PrimaryButton(), "_caption").Text == "下一项" && (string?)ToolTip.GetTip(PrimaryButton()) == "下一项 B",
                        "收 A 项醒目，下一项只在悬停和读屏时提示目标 B");
                    var directions = Field<StackPanel>(wheel, "_cardDirections");
                    Check(directions.IsEffectivelyVisible && AutomationProperties.GetName(directions) == "选才举卡，A 朝上。改为不选时举 B。" &&
                        directions.GetVisualDescendants().OfType<TextBlock>().Where(t => t.IsEffectivelyVisible).Select(t => t.Text).SequenceEqual(["A", "选才举卡"]),
                        "多选显示 A 朝上和选才举卡，读屏可获得改答提示");
                    Check(!heading.TextLayout.TextLines.Any(line => line.HasCollapsed) && directions.Bounds.Width <= 92,
                        "多选题号完整，举卡图示收在圆心内");
                    Snapshot("native-pet-multiple.png");
                    var collectingState = Field<CardQuizWheelState>(wheel,"_state");
                    wheel.Update(collectingState with { Lesson = collectingState.Lesson with { Expected = 157, Received = 120 } });
                    pet.UpdateLayout();
                    var countRow = Field<StackPanel>(wheel, "_count");
                    Check(countRow.Bounds.Width <= bodyScroll.Viewport.Width && countRow.Children.All(child =>
                            child is TextBlock value && value.TextLayout.TextLines.Count == 1 &&
                            value.TextLayout.WidthIncludingTrailingWhitespace <= value.Bounds.Width + .5),
                        "收答中的三位数人数和单位在一行显示");
                    wheel.Update(collectingState);
                    Click(PrimaryButton()); await Primary("下一项 C"); await Task.Delay(1600);
                    Check(currentOption.Text == "收 B 项" && !directions.IsEffectivelyVisible &&
                        Field<TextBlock>(wheel, "_directions").Text == "放下再举", "切到 B 项显示新项和重新举卡提示");
                    Check(await Read("document.getElementById('camera').srcObject?.active===true") && Field<CardQuizWheelState>(wheel,"_state").Lesson.Received==0,
                        "一键切到 B 项，相机已开启，持续举着的旧卡均未计入");
                    await TouchPet(PointerType.Pen, hold:true);
                    await Until(() => pet.PetMenu.IsOpen && menuCenter.IsFocused, "用笔长按收 B 项中的班班");
                    Click(menuCenter);
                    Check(talk.IsFocused && currentOption.Text=="收 B 项" && await Read("document.getElementById('camera').srcObject?.active===true"),
                        "笔长按返回保留多选 B 项、相机和人物焦点");
                    var beforeDrag = Anchor();
                    await TouchPet(PointerType.Touch, hold:true, move:true);
                    pet.UpdateLayout();
                    var afterDrag = Anchor();
                    var stillScanning = await Read("document.getElementById('camera').srcObject?.active===true");
                    Check(!pet.PetMenu.IsOpen && pet.ClassroomExpanded && afterDrag.Y < beforeDrag.Y && currentOption.Text=="收 B 项" && stillScanning,
                        $"长按后拖动只移动人物，松手仍收 B 项（{beforeDrag} → {afterDrag}，菜单 {pet.PetMenu.IsOpen}，相机 {stillScanning}）");
                    Click(ButtonFor($"待收 {cardNumbers.Length} 人，查看卡号"));
                    await Until(()=>Find("1-10 号卡")!=null && Field<TextBlock>(cardRing,"_title").Text?.Contains("B 项待收")==true,"待收入口保留当前 B 项");
                    Check(await Read("document.querySelectorAll('#card-map [data-state=pending]').length===60") &&
                        Field<CardQuizWheelState>(wheel,"_state").CardPanel?.ReadOnly == true,"待收展示 B 项的六十张缺收卡且只读");
                    Click(ButtonFor("1-10 号卡"));
                    await Until(() => Find("1 号卡，待收")?.IsFocused == true, "待收明细定位到 B 项实际卡号");
                    Click(ButtonFor("1 号卡，待收"));
                    Check(NoCardFilter() && await Read("document.querySelector('#exempt-cards input').disabled && !document.querySelector('#exempt-cards input').checked") &&
                        Find("1 号卡，免答") == null, "待收入口点明细仅查看，不能切换免答");
                    Click(ButtonFor("返回")); await Until(() => Find("1-10 号卡")?.IsFocused == true, "只读明细返回原号段");
                    Click(ButtonFor("返回")); await Until(()=>!wheel.DetailVisible,"返回当前收答项");
                    pet.SetClassroomExpanded(false); await Wait("document.getElementById('round-status').textContent.includes('已暂停')");
                    pet.SetClassroomExpanded(true); await Primary("继续收答");
                    Check(Field<TextBlock>(wheel,"_directions").Text?.Contains("已暂停") == true && currentOption.Text == "收 B 项" &&
                        currentOption.IsEffectivelyVisible,"暂停后仍能看到已保存状态和当前 B 项");
                    Click(PrimaryButton()); await Primary("下一项 C"); await Task.Delay(1200);
                    Check(Field<CardQuizWheelState>(wheel,"_state").Lesson is {Option:"B",Received:0},"B 项收起后恢复仍要求重新举卡");
                    Click(ButtonFor("课堂工具"));
                    var optionsTool = ButtonFor("调整收答项");
                    Check(Tool("options") == optionsTool && Tool("seal") == ButtonFor("封存本轮") && Tool("pause") == ButtonFor("暂停收答") &&
                        Tool("source") == null && Tool("camera") == null && Tool("exempt") == null &&
                        await RingFits() && VisibleTools().All(FaceFits), "多选收答时工具可暂停、封存和改项，取景条负责相机来源");
                    Click(optionsTool);
                    await Wait("document.body.dataset.pane==='options'");
                    await Until(() => DetailSector("collect-a") != null && DetailSector("collect-c") != null &&
                        DetailSector("collect-d") != null, "B 项可切换至 A、C、D");
                    Check(DetailSector("collect-b") == null && detailFace.GetVisualDescendants().OfType<TextBlock>()
                        .Any(label => label.IsEffectivelyVisible && label.Text == "收 B"), "当前 B 项显示在圆心");
                    Click(ButtonFor("返回"));
                    await Until(() => !wheel.DetailVisible && optionsTool.IsFocused &&
                        Field<CardQuizWheelState>(wheel,"_state").Lesson.Option == "B", "手动返回保留 B 项，焦点回到改项扇面");
                    Click(optionsTool);
                    await EnterDetail("collect-c");
                    await Until(() => !wheel.DetailVisible && Field<CardQuizWheelState>(wheel,"_state").Lesson is { Option:"C", Busy:false } &&
                        Find("下一项 D") == PrimaryButton() && PrimaryButton().IsEnabled && PrimaryButton().IsFocused,
                        "选择 C 后自动回到收答主盘，焦点落在顶弧下一项 D");
                    Check(currentOption.IsEffectivelyVisible && currentOption.Text == "收 C 项", "第三轮显示收 C 项");
                    PressEnter(PrimaryButton()); await Primary("结束收答");
                    Check(currentOption.Text == "收 D 项", "最后一轮显示收 D 项");
                    Click(PrimaryButton()); await Primary(sealedPrimary);
                    var resultState = Field<CardQuizWheelState>(wheel,"_state");
                    if (twoCardVideo != null)
                        Check(resultState.Lesson is { Received:2, Abstained:58, Incomplete:0 } && !empty.IsVisible &&
                            resultState.Lesson.Bars.Select(bar => (bar.Label,bar.Count)).SequenceEqual([("A",1),("全不选",1)]) &&
                            ChartMatches(resultState.Lesson.Bars,2) && note.Text=="弃权 58", "只举首项的两张卡各计一人，其余 58 人弃权");
                    else Check(empty.IsEffectivelyVisible && empty.Text=="弃权 60 人" && ChartMatches([],0), "无人举卡时全班弃权");
                    CardQuizBar[] noneSelected = [new("全不选",1)];
                    wheel.Update(resultState with { Lesson = resultState.Lesson with { Received=1, Expected=1, Bars=noneSelected, Incomplete=0, Caption="", Primary="advance", Label="下一题" } });
                    Check(!empty.IsVisible && ChartMatches(noneSelected,1) && tally.Text=="已答 1 / 1", "逐项全不选计一人，单独显示一组");
                    CardQuizBar[] groups = [new("AC",8), new("AB",6), new("ACD",4), new("AD",2)];
                    var example = resultState.Lesson with { Number=1, Heading="第 1 题", Received=20, Expected=22, Bars=groups,
                        Incomplete=1, Caption="未完成 1 · 未答 1", Primary="advance", Label="下一题" };
                    wheel.Update(resultState with { Lesson=example }); pet.UpdateLayout();
                    Check(ChartMatches(groups,20) && tally.Text=="已答 20 / 22" && FullyVisibleInChart(note) && TextClearsArcs(note),
                        "每位完整作答者只占一个组合，未完成和未答在图外可读");
                    Snapshot("native-pet-result-combinations.png");
                    CardQuizBar[] moreGroups = [new("AB",5), new("AC",5), new("AD",4), new("全不选",3), new("ABCD",2), new("ACD",1)];
                    wheel.Update(resultState with { Lesson=example with { Bars=moreGroups } }); pet.UpdateLayout();
                    var chartButton = ButtonFor("查看全部 6 种作答组合");
                    Check(ChartMatches(moreGroups,20) && heading.Text!.Contains("6 组") && chartButton.IsEnabled &&
                        chartButton.Bounds.Height >= 44 && FooterTargets([ButtonFor("课堂工具"), PrimaryButton(), ButtonFor("结课")]),
                        "超过四组时主盘保留前四行及并列最多，圆心可展开全部，底弧仍翻题");
                    CardQuizBar[] multipleBars = [new("ABCD",100), new("全不选",10), new("ACD",6), new("AD",4)];
                    var largeResult = resultState with { Lesson = resultState.Lesson with {
                        Number = 99, QuestionCount = 99, Heading = "第 99 题", Received = 120, Expected = 157, Primary="advance", Label="下一题",
                        Bars = multipleBars, Caption = "未完成 26 · 未答 11" } };
                    wheel.Update(largeResult); pet.UpdateLayout();
                    Check(FooterTargets([ButtonFor("课堂工具"), PrimaryButton(), ButtonFor("结课")]), "三位数结果仍可点到三个完整的底弧");
                    Check(TextClearsArcs(note) && FullyVisibleInChart(note) && bodyScroll.Extent.Height <= bodyScroll.Viewport.Height + .5,
                        $"四行分布、未完成与未答均在底弧上方（内容 {bodyScroll.Extent.Height:0.##}，视口 {bodyScroll.Viewport.Height:0.##}）");
                    wheel.Update(largeResult with { Lesson = largeResult.Lesson with {
                        Number = 100, QuestionCount = 100, Heading = "第 100 题", Primary="finish", Label="结课" } });
                    pet.UpdateLayout();
                    var bars = Field<StackPanel>(wheel,"_bars");
                    bool HeaderFitsInsideTrack(TextBlock label)
                    {
                        var textWidth = label.TextLayout.WidthIncludingTrailingWhitespace;
                        var left = label.TranslatePoint(new Point((label.Bounds.Width - textWidth) / 2, 0), wheel)!.Value;
                        var half = BanbanClassroomWheel.Diameter / 2;
                        var innerRadius = track.Bounds.Width / 2 - track.StrokeThickness;
                        return new[] { left, left + new Point(textWidth, 0) }.All(p =>
                            (p.X - half) * (p.X - half) + (p.Y - half) * (p.Y - half) <= innerRadius * innerRadius);
                    }
                    Snapshot("native-pet-participation.png");
                    Check(ChartMatches(multipleBars, 120) && bars.Children.Cast<Grid>().All(row =>
                        row.Children.OfType<TextBlock>().All(text => text.TextLayout.TextLines.Count == 1 &&
                            text.TextLayout.WidthIncludingTrailingWhitespace <= text.Bounds.Width + .5)),
                        "四字母组合、全不选和三位数人数可读，各组按完整作答人数绘条");
                    Check(tally.Text == "已答 120 / 157" && Field<TextBlock>(wheel, "_barMax").Text == "120 人" && progress.IsVisible && Math.Abs(progress.SweepAngle - 360d * 120 / 157) < .01,
                        "三位数比例和外圈进度一致");
                    Check(
                        !heading.TextLayout.TextLines.Any(line=>line.HasCollapsed) &&
                        tally.TextLayout.TextLines.Count == 1 && tally.TextLayout.WidthIncludingTrailingWhitespace <= tally.Bounds.Width + .5 &&
                        HeaderFitsInsideTrack(heading) && HeaderFitsInsideTrack(tally),
                        $"三位数题号和人数完整位于外圈内（题号 {heading.Bounds}，人数 {tally.Bounds}）");
                    Check(bodyScroll.Extent.Height <= bodyScroll.Viewport.Height + 0.5 &&
                        FullyVisibleInChart(note) && TextClearsArcs(note) && bars.Children.All(FullyVisibleInChart),
                        $"未完成、未答和四项分布在同一屏内可见（内容 {bodyScroll.Extent.Height:0.##}，视口 {bodyScroll.Viewport.Height:0.##}）");
                    wheel.Update(resultState);
                    Click(ButtonFor("结课")); Click(ButtonFor("取消")); await Primary(sealedPrimary); Click(ButtonFor("结课"));
                    await Primary("确认结课"); Click(PrimaryButton()); await Primary("返回班班");
                    Snapshot("native-pet-done.png");
                    var doneState = Field<CardQuizWheelState>(wheel, "_state");
                    Check(await FooterFits(ButtonFor("课堂记录"), ButtonFor("重试同步")), "记录和重试沿结课页底弧并列");
                    Check(TextClearsArcs(heading) && TextClearsArcs(note) && bodyScroll.Extent.Height <= bodyScroll.Viewport.Height + .5,
                        $"已结课和保存状态与上下扇面分开（标题 {heading.TranslatePoint(default, wheel)}，状态 {note.TranslatePoint(default, wheel)}）");
                    wheel.Update(doneState with { Lesson = doneState.Lesson with { Records = [doneState.Lesson.Records[0]], QuestionCount = 1 } });
                    Click(ButtonFor("课堂记录"));
                    Check(!ButtonFor("上一题").IsEnabled && !PrimaryButton().IsEnabled && ButtonFor("返回汇总").IsFocused,
                        "只有一题的记录可从键盘返回，两侧页界不会推进课堂");
                    Click(ButtonFor("返回汇总"));
                    wheel.Update(doneState);
                    Click(ButtonFor("课堂记录")); Check(Find("下一题")==PrimaryButton() && PrimaryButton().IsEnabled && !ButtonFor("上一题").IsEnabled,"课堂记录从第一题开始，中键翻页");
                    pet.UpdateLayout();
                    Check(await FooterFits(ButtonFor("上一题"), PrimaryButton(), ButtonFor("返回汇总")) &&
                        HitButton(OnRing(83, Math.PI)) == PrimaryButton(), "课堂记录在六点钟方向翻题，两侧图标和三字标签完整");
                    Check(ChartMatches(state.Lesson.Received == 0 ? [] : state.Lesson.Bars, state.Lesson.Received), "课堂记录沿用当题的匿名分布");
                    Snapshot("native-pet-record.png");
                    Click(PrimaryButton()); PrimaryButton().Focus(); Click(PrimaryButton());
                    Check(!ButtonFor("下一题").IsEnabled && (twoCardVideo == null
                        ? empty.IsVisible && empty.Text=="弃权 60 人" && ChartMatches([],0)
                        : !empty.IsVisible && note.Text=="弃权 58" && ChartMatches(resultState.Lesson.Bars,2)), "课堂记录保留本题的作答组合与弃权人数");
                    Check(ButtonFor("返回汇总").IsFocused && ButtonFor("上一题").IsEnabled, "末页禁用下一题后仍可用键盘返回或翻回上一题");
                    Click(ButtonFor("返回汇总")); Check(OnlyPet() && Field<CardQuizWheelState>(wheel,"_state").Lesson.NeedsSync &&
                        note.Text=="已存本机 · 待同步","离线结课在原窗保留同步状态与重试入口");
                    Click(PrimaryButton()); await Until(()=>!pet.ClassroomExpanded,"返回贴边班班");
                    talk.Focus(); talk.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyDownEvent,Key=Key.Left});
                    pet.UpdateLayout(); var left=Anchor();
                    ((IInvokeProvider)ControlAutomationPeer.CreatePeerForElement(talk)).Invoke();
                    await Until(() => pet.ClassroomExpanded, "拖动过人物后仍可从辅助功能展开班班");
                    await Primary("开始课堂");
                    Check(Math.Abs(Anchor().X-left.X)<=2 && Math.Abs(Anchor().Y-left.Y)<=2 && Canvas.GetLeft(wheel)>0,"左侧停靠时从辅助功能原地向右展开");
                    pet.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyDownEvent,Key=Key.Escape});
                    Check(!pet.ClassroomExpanded && pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single()==mascot,"Esc 收起同一个班班");
                    Check(await pet.ClassroomHost!.PrepareToCloseAsync(), "退出仍通过原课堂暂停落盘");
                }
                catch (Exception error) { failure = error; Console.Error.WriteLine(error); }
                finally
                {
                    await File.WriteAllTextAsync(Path.Combine(outputDirectory, "native-wheel-result.json"), JsonSerializer.Serialize(new { passed, error = failure?.ToString() }, new JsonSerializerOptions { WriteIndented = true }));
                    lesson?.Close(); pet.Shutdown(); CardQuizService.Stop(); desktop.Shutdown(failure is null ? 0 : 1);
                }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        File.Delete(petSettingsPath);
        if (failure is not null) Environment.ExitCode = 1;
    }
}

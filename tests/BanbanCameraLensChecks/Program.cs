using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Embedding;
using Avalonia.Controls.Embedding.Offscreen;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.Markup.Xaml.Styling;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using SkiaSharp;
using Pointer = Avalonia.Input.Pointer;

AppBuilder.Configure<Application>().UseSkia()
    .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false }).SetupWithoutStarting();
Application.Current!.Styles.Add(new FluentTheme());
var styles = new Uri("avares://ICeClass/NativeControls.axaml");
Application.Current.Styles.Add(new StyleInclude(styles) { Source = styles });

var lens = new BanbanCameraLens();
var window = new Window { Width = BanbanCameraLens.PreviewSize.Width + 16, Height = BanbanCameraLens.PreviewSize.Height + 16,
    Content = new Canvas { Children = { lens } } };
var commands = new List<CardQuizWheelCommand>();
lens.ActionRequested += commands.Add;
window.Show(); // Avalonia.Headless has no desktop window or physical input device.
try
{
    var squareFrame = MakeJpeg(288, 288);
    var wideFrame = MakeJpeg(288, 162);
    var wrongSizes = new[] { MakeJpeg(288, 161), MakeJpeg(288, 163), MakeJpeg(287, 162), MakeJpeg(288, 289) };
    foreach (var phone in new[] { false, true })
    {
        var state = new CardQuizCameraPreview(phone ? "phone-session" : "board-session", phone, false);
        UpdatePreview(state);
        var image = lens.GetVisualDescendants().OfType<Image>().Single();
        var device = phone ? "手机" : "电脑";
        var other = phone ? "电脑" : "手机";
        var source = ButtonNamed(device + "取景，选择相机来源");
        var fold = ButtonNamed("收起取景，继续扫码");
        var stop = ButtonNamed("关闭当前相机");
        Require(IconFace(source, 2) && IconFace(fold, 1) && IconFace(stop, 1),
            device + "取景栏仅显示设备、展开指示和操作图标，各自保留中文提示");
        var video = BanbanCameraLens.VideoSize;
        Require(video.Width > BanbanClassroomWheel.Diameter && video.Width * 9 == video.Height * 16 &&
            lens.Width == video.Width && lens.Height >= video.Height + 44 &&
            !lens.ContainsInteractive(new Point(1, 1)) && lens.ContainsInteractive(new Point(15, 2)), "宽画面和独立操作条");
        Rect ButtonBounds(Button button) => new(button.TranslatePoint(default, lens)!.Value, button.Bounds.Size);
        var controls = new[] { source, fold, stop }.Select(ButtonBounds).ToArray();
        Require(controls.All(r => r.Top >= video.Height && new Rect(lens.Footprint).Contains(r)) &&
            controls.All(r => Math.Abs(r.Top - controls[0].Top) <= 1) &&
            controls[0].Right <= controls[1].Left && controls[1].Right <= controls[2].Left,
            $"{device}来源、收起与关闭应在画面外同一行：{string.Join(" / ", controls)}，取景框 {lens.Bounds}");
        lens.ShowFrame("expired-session", wideFrame);
        foreach (var invalid in wrongSizes) lens.ShowFrame(state.Key, invalid);
        Require(image.Source is null, "拒绝旧连接或错误尺寸的帧");
        lens.ShowFrame(state.Key, squareFrame);
        Layout();
        CheckPicture(lens, wide: false);
        lens.ShowFrame(state.Key, wideFrame);
        var firstFrame = image.Source;
        lens.Update(state);
        Require(firstFrame is not null && ReferenceEquals(image.Source, firstFrame), "同一取景状态保留画面");
        Layout();
        CheckPicture(lens, wide: true);
        var raw = new byte[BanbanCameraLens.PixelBytes];
        using (var stream = new MemoryStream(raw, writable:false))
        {
            lens.ShowPixels("old",stream);
            Require(stream.Position == 0 && ReferenceEquals(image.Source,firstFrame), "过期视频不能替换当前画面");
            foreach (byte red in new byte[] { 220, 37 })
            {
                for (var pixel=0; pixel<raw.Length; pixel+=4)
                { raw[pixel]=red; raw[pixel+1]=72; raw[pixel+2]=116; raw[pixel+3]=255; }
                stream.Position=0; lens.ShowPixels(state.Key,stream); Layout();
                using var scene=new RenderTargetBitmap(new PixelSize(352,242));
                scene.Render(lens);
                using var png=new MemoryStream(); scene.Save(png); png.Position=0;
                using var drawn=SKBitmap.Decode(png);
                var center=drawn.GetPixel(176,99);
                Require(center.Red==red && center.Green==72 && center.Blue==116,"连续更新后原生窗口绘制了正确颜色的新帧");
            }
        }

        Touch(source);
        var alternative = ButtonNamed("暂停本轮，改用" + other + "扫码");
        var selected = ButtonNamed(device + "，当前来源");
        var back = ButtonNamed("返回取景");
        Require(IconFace(alternative, 1) && IconFace(selected, 2) && IconFace(back, 1) && ToolTip.GetShowOnDisabled(selected),
            device + "选择器保留两个设备图标，仅当前来源显示勾号");
        Require(alternative.IsFocused && !selected.IsEnabled && AutomationProperties.GetItemStatus(selected) == "当前来源" &&
            alternative.Bounds.Y == selected.Bounds.Y && alternative.Bounds.Y == back.Bounds.Y, "单行来源选择及焦点");
        Require(ButtonBounds(back).Right <= ButtonBounds(fold).Left && ButtonBounds(selected).Top >= video.Height,
            "展开切换来源时仍能看到完整画面并操作收起按钮");
        KeyStroke(PhysicalKey.ArrowRight);
        Require(back.IsFocused, "方向键跳过已选来源");
        KeyStroke(PhysicalKey.Escape);
        Require(source.IsFocused && !back.IsEffectivelyVisible && commands.Count == 0, "取消选择恢复来源焦点");
        KeyStroke(PhysicalKey.Enter);
        Touch(alternative);
        Expect(phone ? "preview-board" : "preview-phone", state.Key);
        Require(source.IsFocused, "切换请求等待原采集流程确认");

        Touch(stop);
        Expect("preview-stop", state.Key);
        fold.Focus();
        KeyStroke(PhysicalKey.Space);
        Expect("preview-fold", state.Key);
        UpdatePreview(state with { Folded = true });
        var dock = ButtonNamed("展开取景，正在扫码");
        lens.ShowFrame(state.Key, wideFrame);
        lens.ShowFrame(state.Key, squareFrame);
        Require(image.Source is null && dock.IsFocused && IconFace(dock, 1) &&
            lens.Footprint.Width == lens.Footprint.Height && lens.Footprint.Width >= 44 &&
            !lens.ContainsInteractive(new Point(3, 3)) && lens.ContainsInteractive(new Point(5, lens.Footprint.Height / 2)),
            "折叠清帧后可从圆形扫描图标恢复，焦点和触控范围有效");
        Touch(dock);
        Expect("preview-open", state.Key);
        UpdatePreview(state);
        lens.ShowFrame(state.Key, wideFrame);
        Require(fold.IsFocused && image.Source is not null, "展开恢复画面及收起按钮焦点");
        if (phone)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3.5));
            Dispatcher.UIThread.MainLoop(timeout.Token);
            Require(image.Source is null, "停帧超时恢复等待画面");
            lens.ShowFrame(state.Key, squareFrame);
            Require(image.Source is not null, "同一连接来帧后恢复");
        }
        UpdatePreview(null);
        lens.ShowFrame(state.Key, wideFrame);
        Require(!lens.IsVisible && image.Source is null && !lens.ContainsInteractive(new Point(50, 20)), "撤去取景后忽略迟到帧并穿透");
        Console.WriteLine("PASS " + device + "取景、触控、键盘、命令与帧生命周期");
    }
    CheckPlacement();
    foreach (var dpi in new[] { 1d, 1.5, 2 })
    foreach (var wheelPercent in new[] { 80, 100, 200 })
        CheckScaledPreview(dpi, wheelPercent, wideFrame, squareFrame);
}
finally { window.Close(); }

void UpdatePreview(CardQuizCameraPreview? state)
{
    lens.Update(state);
    lens.SetFootprint(lens.Footprint); // Unconstrained layout at the default wheel zoom.
    Layout();
}

void Layout()
{
    Dispatcher.UIThread.RunJobs();
    window.UpdateLayout();
    AvaloniaHeadlessPlatform.ForceRenderTimerTick(1);
}

Button ButtonNamed(string name) => lens.GetVisualDescendants().OfType<Button>()
    .Single(b => b.IsEffectivelyVisible && AutomationProperties.GetName(b) == name);

static bool IconFace(Button button, int glyphs)
{
    var visible = button.GetVisualDescendants().Where(v => v.IsEffectivelyVisible).ToList();
    return visible.OfType<Viewbox>().Count() == glyphs &&
        !visible.OfType<TextBlock>().Any(t => !string.IsNullOrWhiteSpace(t.Text)) &&
        Equals(ToolTip.GetTip(button), AutomationProperties.GetName(button));
}

void Touch(Button button)
{
    var point = button.TranslatePoint(new Point(button.Bounds.Width / 2, button.Bounds.Height - 3), window)!.Value;
    var hit = window.InputHitTest(point) as Visual;
    Require(button.Bounds.Width >= 44 && button.Bounds.Height >= 44 &&
        (hit == button || hit?.GetVisualAncestors().Contains(button) == true),
        $"按钮外沿触点 {AutomationProperties.GetName(button)} {button.Bounds} @ {point}, 命中 {hit}");
    using var pointer = new Pointer(Pointer.GetNextFreeId(), PointerType.Touch, true);
    var down = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed);
    var up = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased);
    button.RaiseEvent(new PointerPressedEventArgs(button, pointer, window, point, 1, down, KeyModifiers.None));
    button.RaiseEvent(new PointerReleasedEventArgs(button, pointer, window, point, 2, up, KeyModifiers.None, MouseButton.Left));
    Layout();
}

void KeyStroke(PhysicalKey key)
{
    window.KeyPressQwerty(key, RawInputModifiers.None);
    window.KeyReleaseQwerty(key, RawInputModifiers.None);
    Layout();
}

void Expect(string action, string key)
{
    Require(commands.SequenceEqual([new CardQuizWheelCommand(action, Key: key)]), "单次原协议命令 " + action);
    commands.Clear();
}

static void CheckPlacement()
{
    static PixelPoint ScreenPoint(PixelPoint origin, Point local, double dpi) =>
        new(origin.X + (int)Math.Round(local.X * dpi), origin.Y + (int)Math.Round(local.Y * dpi));
    static bool CenterFits(int actual, int requested, int start, int end, int low, int high) =>
        Math.Abs(actual - requested) <= 1 || (actual > requested ? Math.Abs(start - low) : Math.Abs(end - high)) <= 1;

    const double rest = 100, petScale = .8;
    var wheelSize = new Size(BanbanClassroomWheel.Diameter, BanbanClassroomWheel.Diameter);
    var full = BanbanCameraLens.PreviewSize;
    var roomy = new PixelRect(-2600, -2100, 2400, 2000);
    foreach (var dpi in new[] { 1d, 1.5, 2 })
    foreach (var wheelPercent in new[] { 80, 100, 200 })
    foreach (var right in new[] { false, true })
    foreach (var work in new[] { roomy, new PixelRect(-1200, -800, 1200, 800), new PixelRect(30, 20, 320, 240),
        new PixelRect(30, 20, 270, 1024) })
    foreach (int y in new[] { work.Y + 3, work.Y + work.Height / 2, work.Bottom - 3 })
    {
        var pet = new PixelPoint(right ? work.Right - 22 : work.X + 22, y);
        var context = $"{work} @ {dpi:P0} DPI，圆盘 {wheelPercent}%，右停靠 {right}，锚点 {pet}";
        var initial = BanbanPetWindow.FitClassroom(pet, work, dpi, rest, petScale, right, wheelSizePercent: wheelPercent);
        var initialDisc = new Rect(initial.Wheel, wheelSize * initial.Scale);
        var initialCenter = ScreenPoint(initial.Position, initialDisc.Center, dpi);
        var open = BanbanPetWindow.FitClassroom(pet, work, dpi, rest, petScale, right, full, initialCenter, wheelPercent);
        var disc = new Rect(open.Wheel, wheelSize * open.Scale);
        var preview = new Rect(open.Lens, open.LensSize);
        var bounds = new Rect(open.Size).Inflate(.001);
        var window = new PixelRect(open.Position, PixelSize.FromSize(open.Size, dpi));
        var petWidth = rest * open.CompanionScale;
        var petBounds = new Rect(right ? disc.Right : disc.Left - petWidth, open.PetTop,
            petWidth, Math.Max(44, 130 * petScale) * open.CompanionScale);
        var video = BanbanCameraLens.VideoSize * open.Scale;
        Require(open.CompanionScale is > 0 and <= 1 && (work != roomy || open.CompanionScale == 1) &&
            Math.Abs(open.Scale - open.CompanionScale * wheelPercent / 100) < .001 &&
            Math.Abs(preview.Width - video.Width) < .001 && Math.Abs(preview.Height - video.Height - BanbanCameraLens.ToolbarHeight) < .001,
            $"圆盘、画面及操作条尺寸异常 {context}");
        Require(work.Contains(window) && bounds.Contains(preview) && bounds.Contains(disc) && bounds.Contains(petBounds) &&
            Math.Abs(disc.Center.X - preview.Center.X) < .001 && Math.Abs(disc.Top - preview.Bottom - 8 * open.CompanionScale) < .001,
            $"上下布局越界或偏心 {context}");
        var openCenter = ScreenPoint(open.Position, disc.Center, dpi);
        Require(CenterFits(openCenter.X, initialCenter.X, window.X, window.Right, work.X, work.Right) &&
            CenterFits(openCenter.Y, initialCenter.Y, window.Y, window.Bottom, work.Y, work.Bottom),
            $"开镜头仅按工作区边缘移动圆心 {initialCenter} -> {openCenter}，{context}");
        var petAnchor = ScreenPoint(open.Position, petBounds.Center, dpi);
        var dock = BanbanCameraLens.DockSize;
        var folded = BanbanPetWindow.FitClassroom(petAnchor, work, dpi, rest, petScale, right, dock, openCenter, wheelPercent);
        var foldedDisc = new Rect(folded.Wheel, wheelSize * folded.Scale);
        var foldedDock = new Rect(folded.Lens, folded.LensSize);
        var foldedCenter = ScreenPoint(folded.Position, foldedDisc.Center, dpi);
        Require(work.Contains(new PixelRect(folded.Position, PixelSize.FromSize(folded.Size, dpi))) &&
            new Rect(folded.Size).Inflate(.001).Contains(foldedDock) && foldedDock.Size == dock &&
            Math.Abs(foldedDock.Center.X - foldedDisc.Center.X) < .001 && folded.Scale == open.Scale &&
            Math.Abs(foldedCenter.X - openCenter.X) <= 1 && Math.Abs(foldedCenter.Y - openCenter.Y) <= 1,
            $"折叠保持圆心与缩放 {openCenter} -> {foldedCenter}，{context}");
    }
    Console.WriteLine("PASS 双侧停靠、负坐标、边缘限位、80% / 100% / 200% 圆盘与三档 DPI");
}

static string MakeJpeg(int width, int height)
{
    using var bitmap = new SKBitmap(width, height);
    using var canvas = new SKCanvas(bitmap);
    canvas.Clear(SKColors.White);
    using var paint = new SKPaint { Color = SKColors.Red };
    canvas.DrawRect(0, 0, width, 25, paint);
    paint.Color = SKColors.Blue;
    canvas.DrawRect(0, height - 25, width, 25, paint);
    paint.Color = SKColors.Lime;
    canvas.DrawRect(0, height / 2 - 14, 24, 28, paint);
    paint.Color = SKColors.Magenta;
    canvas.DrawRect(width - 24, height / 2 - 14, 24, 28, paint);
    using var image = SKImage.FromBitmap(bitmap);
    using var jpeg = image.Encode(SKEncodedImageFormat.Jpeg, 85);
    return "data:image/jpeg;base64," + Convert.ToBase64String(jpeg.AsSpan());
}

static void CheckScaledPreview(double dpi, int wheelPercent, string wideFrame, string squareFrame)
{
    var lens = new BanbanCameraLens();
    lens.Update(new("scaled", false, false));
    var wheel = new BanbanClassroomWheel { IsVisible = true };
    var fit = BanbanPetWindow.FitClassroom(new PixelPoint(1000, 600), new PixelRect(0, 0, 1600, 1200),
        dpi, 78, .6, right: true, lens: lens.Footprint, wheelSizePercent: wheelPercent);
    lens.SetFootprint(fit.LensSize);
    wheel.RenderTransformOrigin = RelativePoint.TopLeft;
    wheel.RenderTransform = new ScaleTransform(fit.Scale, fit.Scale);
    Canvas.SetLeft(lens, fit.Lens.X);
    Canvas.SetTop(lens, fit.Lens.Y);
    Canvas.SetLeft(wheel, fit.Wheel.X);
    Canvas.SetTop(wheel, fit.Wheel.Y);
    var scene = new Canvas { Children = { lens, wheel } };
    var surface = new LensSurface { ClientSize = fit.Size, RenderScaling = dpi };
    using var root = new EmbeddableControlRoot(surface) { Content = scene };
    root.Prepare();
    root.UpdateLayout();
    PixelRect SurfaceBounds(Control control)
    {
        var topLeft = control.TranslatePoint(default, scene)!.Value;
        var bottomRight = control.TranslatePoint(new Point(control.Bounds.Width, control.Bounds.Height), scene)!.Value;
        return new PixelRect(PixelPoint.FromPoint(topLeft, dpi), PixelPoint.FromPoint(bottomRight, dpi));
    }
    var frame = SurfaceBounds(lens);
    var disc = SurfaceBounds(wheel);
    var size = lens.Bounds.Size;
    var video = BanbanCameraLens.VideoSize * fit.Scale;
    var previewHeight = video.Height + BanbanCameraLens.ToolbarHeight;
    var gapHeight = 8 * fit.CompanionScale;
    var context = $"{dpi:P0} DPI，圆盘 {wheelPercent}%";
    // Layout rounds the preview bottom and the wheel top to physical pixels independently.
    Require(Math.Abs(frame.Width - video.Width * dpi) <= 1 &&
        Math.Abs(frame.Height - previewHeight * dpi) <= 1 &&
        Math.Abs(disc.Width - BanbanClassroomWheel.Diameter * fit.Scale * dpi) <= 1 &&
        frame.Width > disc.Width && Math.Abs(frame.Center.X - disc.Center.X) <= 1 && disc.Y > frame.Bottom &&
        Math.Abs(disc.Y - frame.Y - (previewHeight + gapHeight) * dpi) <= 1,
        $"{context} 取景 {frame}、圆盘 {disc}、布局 {lens.Bounds}");
    var gap = new Point(frame.Center.X / dpi, (frame.Bottom + disc.Y) / (2 * dpi));
    Require(lens.ContainsInteractive(new Point(20, 3)), $"{context} 取景框内侧应接收点击");
    foreach (var corner in new[] { new Point(1, 1), new Point(size.Width - 1, 1),
        new Point(1, size.Height - 1), new Point(size.Width - 1, size.Height - 1) })
        Require(!lens.ContainsInteractive(corner), $"{context} 取景圆角 {corner} 应穿透");
    Require(!lens.ContainsInteractive(scene.TranslatePoint(gap, lens)!.Value) &&
        !wheel.ContainsInteractive(scene.TranslatePoint(gap, wheel)!.Value), $"{context} 盘间空隙应穿透");
    foreach (var (data, wide) in new[] { (wideFrame, true), (squareFrame, false) })
    {
        lens.ShowFrame("scaled", data);
        root.UpdateLayout();
        CheckPicture(lens, wide, dpi);
    }
    lens.Update(null);
    Console.WriteLine($"PASS {context} 离屏取景 {frame.Width} × {frame.Height} px，盘间 {disc.Y - frame.Bottom} px，横帧和旧方帧");
}

static void CheckPicture(Visual scene, bool wide, double dpi = 1)
{
    var size = scene.Bounds.Size;
    var video = new Size(size.Width, size.Width * 9 / 16);
    using var target = new RenderTargetBitmap(PixelSize.FromSize(new Size(size.Width, size.Height + 8), dpi),
        new Vector(96 * dpi, 96 * dpi));
    target.Render(scene);
    using var png = new MemoryStream();
    target.Save(png);
    png.Position = 0;
    using var bitmap = SKBitmap.Decode(png);
    SKColor Pixel(double x, double y) => bitmap.GetPixel((int)(x * dpi), (int)(y * dpi));
    var midX = video.Width / 2;
    var midY = video.Height / 2;
    var inset = wide ? 0 : (video.Width - video.Height) / 2;
    var top = Pixel(midX, 5);
    var bottom = Pixel(midX, video.Height - 5);
    var left = Pixel(inset + 6, midY);
    var right = Pixel(video.Width - inset - 6, midY);
    var center = Pixel(midX, midY);
    Require(top.Red > 200 && top.Blue < 50 && bottom.Blue > 200 && bottom.Red < 50 &&
        left.Green > 200 && left.Red < 50 && right.Red > 200 && right.Blue > 200 && right.Green < 50 &&
        center.Red > 200 && center.Green > 200 && center.Blue > 200,
        $"{dpi:P0} 取景四边完整 wide={wide}, top={top}, bottom={bottom}, left={left}, right={right}, center={center}");
    if (!wide)
        Require(Pixel(8, midY) == Pixel(video.Width - 8, midY) && Pixel(8, midY) != center, $"{dpi:P0} 旧方帧左右留边");
    Require(Pixel(0, 0).Alpha == 0 && Pixel(size.Width - 1, 0).Alpha == 0 && Pixel(0, size.Height - 1).Alpha == 0 &&
        Pixel(size.Width - 1, size.Height - 1).Alpha == 0 && Pixel(midX, size.Height + 4).Alpha == 0,
        $"{dpi:P0} 取景四角或盘间空隙有可见像素");
}

static void Require(bool value, string message)
{
    if (!value) throw new InvalidOperationException(message);
}

sealed class LensSurface : OffscreenTopLevelImplBase
{
    public override IMouseDevice MouseDevice => throw new NotSupportedException();
    public override IEnumerable<object> Surfaces => [];
}

using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Embedding;
using Avalonia.Controls.Embedding.Offscreen;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.Markup.Xaml.Styling;
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
        lens.Update(state);
        Layout();
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
        lens.Update(state with { Folded = true });
        Layout();
        var dock = ButtonNamed("展开取景，正在扫码");
        lens.ShowFrame(state.Key, wideFrame);
        lens.ShowFrame(state.Key, squareFrame);
        Require(image.Source is null && dock.IsFocused && IconFace(dock, 1) &&
            lens.Footprint.Width == lens.Footprint.Height && lens.Footprint.Width >= 44 &&
            !lens.ContainsInteractive(new Point(3, 3)) && lens.ContainsInteractive(new Point(5, lens.Footprint.Height / 2)),
            "折叠清帧后可从圆形扫描图标恢复，焦点和触控范围有效");
        Touch(dock);
        Expect("preview-open", state.Key);
        lens.Update(state);
        Layout();
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
        lens.Update(null);
        lens.ShowFrame(state.Key, wideFrame);
        Require(!lens.IsVisible && image.Source is null && !lens.ContainsInteractive(new Point(50, 20)), "撤去取景后忽略迟到帧并穿透");
        Console.WriteLine("PASS " + device + "取景、触控、键盘、命令与帧生命周期");
    }
    CheckPlacement();
    foreach (var dpi in new[] { 1d, 1.5, 2 })
        CheckScaledPreview(dpi, wideFrame, squareFrame);
}
finally { window.Close(); }

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
    const double rest = 100, petScale = .8;
    var full = BanbanCameraLens.PreviewSize;
    foreach (var dpi in new[] { 1d, 1.5, 2 })
    foreach (var right in new[] { false, true })
    foreach (var work in new[] { new PixelRect(-1200, -800, 1200, 800), new PixelRect(30, 20, 320, 240),
        new PixelRect(30, 20, 270, 1024) })
    foreach (int y in new[] { work.Y + 3, work.Y + work.Height / 2, work.Bottom - 3 })
    {
        var pet = new PixelPoint(right ? work.Right - 22 : work.X + 22, y);
        var initial = BanbanPetWindow.FitClassroom(pet, work, dpi, rest, petScale, right);
        var centerY = initial.Position.Y + (int)Math.Round(120 * initial.Scale * dpi);
        var open = BanbanPetWindow.FitClassroom(pet, work, dpi, rest, petScale, right, full, centerY);
        var disc = new Rect(open.Wheel, new Size(240, 240) * open.Scale);
        var preview = new Rect(open.Lens, full * open.Scale);
        var bounds = new Rect(open.Size);
        var petBounds = new Rect(right ? disc.Right : disc.Left - rest * open.Scale, open.PetTop,
            rest * open.Scale, Math.Max(44, 130 * petScale) * open.Scale);
        Require(work.Contains(new PixelRect(open.Position, PixelSize.FromSize(open.Size, dpi))) &&
            bounds.Inflate(.001).Contains(preview) && bounds.Inflate(.001).Contains(disc) && bounds.Inflate(.001).Contains(petBounds) &&
            Math.Abs(disc.Center.X - preview.Center.X) < .001 && Math.Abs(disc.Top - preview.Bottom - 8 * open.Scale) < .001,
            $"上下布局越界或偏心 {work} {dpi} {right} {y}");
        if (open.Scale == initial.Scale)
        {
            var oldTop = initial.Position.Y;
            var newTop = open.Position.Y + open.Wheel.Y * dpi;
            Require(Math.Abs(newTop - Math.Max(oldTop, work.Y + (full.Height + 8) * dpi * open.Scale)) <= 1,
                "开镜头仅按上方空间缺口移动圆盘");
        }
        var currentY = open.Position.Y + (int)Math.Round(disc.Center.Y * dpi);
        var petAnchor = new PixelPoint(open.Position.X + (int)Math.Round(petBounds.Center.X * dpi), pet.Y);
        var dock = BanbanCameraLens.DockSize;
        var folded = BanbanPetWindow.FitClassroom(petAnchor, work, dpi, rest, petScale, right, dock, currentY);
        Require(folded.Scale == open.Scale && Math.Abs(folded.Position.Y + (folded.Wheel.Y + 120 * folded.Scale) * dpi - currentY) <= 1 &&
            Math.Abs(folded.Position.X + (folded.Wheel.X + 120 * folded.Scale) * dpi - (open.Position.X + disc.Center.X * dpi)) <= 1 &&
            Math.Abs(folded.Lens.X + dock.Width * folded.Scale / 2 - (folded.Wheel.X + 120 * folded.Scale)) < .001, "折叠保持圆心与缩放");
    }
    Console.WriteLine("PASS 双侧停靠、负坐标、顶底边缘与 100% / 150% / 200% 缩放");
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

static void CheckScaledPreview(double dpi, string wideFrame, string squareFrame)
{
    var lens = new BanbanCameraLens();
    lens.Update(new("scaled", false, false));
    var wheel = new BanbanClassroomWheel { IsVisible = true };
    var fit = BanbanPetWindow.FitClassroom(new PixelPoint(1000, 600), new PixelRect(0, 0, 1600, 1200),
        dpi, 78, .6, right: true, lens: lens.Footprint);
    Canvas.SetLeft(lens, fit.Lens.X);
    Canvas.SetTop(lens, fit.Lens.Y);
    Canvas.SetLeft(wheel, fit.Wheel.X);
    Canvas.SetTop(wheel, fit.Wheel.Y);
    var scene = new Canvas { Children = { lens, wheel } };
    var surface = new LensSurface { ClientSize = fit.Size, RenderScaling = dpi };
    using var root = new EmbeddableControlRoot(surface) { Content = scene };
    root.Prepare();
    root.UpdateLayout();
    PixelRect SurfaceBounds(Control control) => new(PixelPoint.FromPoint(control.Bounds.TopLeft, dpi),
        PixelPoint.FromPoint(control.Bounds.BottomRight, dpi));
    var frame = SurfaceBounds(lens);
    var disc = SurfaceBounds(wheel);
    var size = lens.Footprint;
    Require(Math.Abs(frame.Width - size.Width * dpi) <= 1 && Math.Abs(frame.Height - size.Height * dpi) <= 1 &&
        frame.Width > disc.Width && Math.Abs(frame.Center.X - disc.Center.X) <= 1 &&
        Math.Abs(disc.Y - frame.Bottom - 8 * dpi) <= 1, $"{dpi:P0} 取景 {frame}、圆盘 {disc}、布局 {lens.Bounds}");
    var gap = new Point(fit.Lens.X + size.Width / 2, fit.Lens.Y + size.Height + 4);
    Require(lens.ContainsInteractive(new Point(20, 3)), $"{dpi:P0} 取景框内侧应接收点击");
    foreach (var corner in new[] { new Point(1, 1), new Point(size.Width - 1, 1),
        new Point(1, size.Height - 1), new Point(size.Width - 1, size.Height - 1) })
        Require(!lens.ContainsInteractive(corner), $"{dpi:P0} 取景圆角 {corner} 应穿透");
    Require(!lens.ContainsInteractive(scene.TranslatePoint(gap, lens)!.Value) &&
        !wheel.ContainsInteractive(scene.TranslatePoint(gap, wheel)!.Value), $"{dpi:P0} 盘间空隙应穿透");
    foreach (var (data, wide) in new[] { (wideFrame, true), (squareFrame, false) })
    {
        lens.ShowFrame("scaled", data);
        root.UpdateLayout();
        CheckPicture(lens, wide, dpi);
    }
    lens.Update(null);
    Console.WriteLine($"PASS {dpi:P0} 离屏取景 {frame.Width} × {frame.Height} px，盘间 {disc.Y - frame.Bottom} px，横帧和旧方帧");
}

static void CheckPicture(Visual scene, bool wide, double dpi = 1)
{
    var size = BanbanCameraLens.PreviewSize;
    var video = BanbanCameraLens.VideoSize;
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

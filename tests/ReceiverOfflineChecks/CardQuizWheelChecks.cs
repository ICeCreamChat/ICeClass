using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Input.Raw;
using Avalonia.Interactivity;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;
using Pointer = Avalonia.Input.Pointer;

/// <summary>Exercise the original pet's gestures and real classroom bridge with an isolated identity.</summary>
internal static class CardQuizWheelChecks
{
    private const BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;
    internal static void Run(string outputDirectory)
    {
        Directory.CreateDirectory(outputDirectory);
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--use-fake-device-for-media-stream --use-fake-ui-for-media-stream");
        Exception? failure = null;
        var passed = new List<string>();
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:9/", ClassId = Guid.NewGuid().ToString(), DeviceId = Guid.NewGuid().ToString(), DeviceToken = "isolated-wheel-check", ClassName = "原班班圆环隔离验收" };
                CardQuizService.For(config).Store.SaveCache("context", new JsonObject {
                    ["classId"] = config.ClassId, ["deviceId"] = config.DeviceId, ["className"] = config.ClassName,
                    ["students"] = new JsonArray(new JsonObject { ["id"] = "s1", ["name"] = "演示同学", ["cardNumber"] = 1 }), ["publications"] = new JsonArray()
                });
                var window = new CardQuizWindow(config);
                var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
                desktop.MainWindow = window;
                var talks = 0; var chats = 0;
                var pet = new BanbanPetWindow(() => chats++, () => talks++, () => { }, _ => { }, Path.Combine(outputDirectory, "pet-check-" + Guid.NewGuid().ToString("N") + ".json"));
                Task? initialization = null;
                pet.ClassroomRequested += () => initialization = window.StartInBackgroundAsync();
                pet.ClassroomActionRequested += window.ActivateCompanionAction;
                window.CompanionStateChanged += pet.SetClassroomState;
                window.CompanionModeRequested += (enabled, expanded) => pet.SetClassroomExpanded(enabled && expanded);
                Window? lesson = null;
                try
                {
                    var browser = Field<ReadingBrowser>(window, "_browser");
                    async Task<bool> Read(string expression) => browser.Core is { } core && await core.ExecuteScriptAsync(expression) == "true";
                    async Task Wait(string expression)
                    {
                        for (var count = 0; count < 150; count++) { if (await Read(expression)) return; await Task.Delay(100); }
                        throw new InvalidOperationException("Timed out: " + expression);
                    }
                    void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); passed.Add(name); Console.WriteLine("PASS " + name); }
                    pet.ShowPet(true); await Task.Delay(100); pet.UpdateLayout();
                    var talk = Field<Button>(pet, "_talk");
                    var mascot = Field<BanbanPetMascot>(pet, "_mascot"); mascot.Animate = false;
                    var restWidth = pet.Width; var restHeight = pet.Height;
                    using var pointer = new Pointer(Pointer.GetNextFreeId(), PointerType.Touch, true);
                    var point = new Point(pet.Width - 12, pet.Height - 80);
                    var down = new PointerPointProperties(RawInputModifiers.LeftMouseButton, PointerUpdateKind.LeftButtonPressed);
                    var up = new PointerPointProperties(RawInputModifiers.None, PointerUpdateKind.LeftButtonReleased);
                    talk.RaiseEvent(new PointerPressedEventArgs(talk, pointer, pet, point, 1, down, KeyModifiers.None));
                    pointer.Capture(talk); await Task.Delay(700);
                    talk.RaiseEvent(new PointerReleasedEventArgs(talk, pointer, pet, point, 2, up, KeyModifiers.None, MouseButton.Left));
                    talk.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    Check(pet.ClassroomExpanded && talks == 0 && chats == 0, "触屏长按原班班展开圆环且不误触语音或对话");
                    if (initialization is not null) await initialization;
                    await Wait("document.getElementById('create-session')?.disabled===false");
                    Check(!window.IsVisible && window.Width == 1120 && !window.Topmost, "开课前不显示另一只班班或独立控制窗");
                    Check(pet.Width == 320 && pet.Height == 392, "圆环整体缩为320乘392，原桌宠窗口不新增");
                    Check(pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single() == mascot && mascot.AssetsLoaded, "圆心复用同一个原班班及动态资源");
                    var wheel = Field<BanbanClassroomWheel>(pet, "_classroomWheel");
                    Check(wheel.GetVisualDescendants().OfType<Avalonia.Controls.Shapes.Path>().Count() >= 8, "八个功能加载原有Lucide图标");
                    Check(wheel.Children.OfType<Button>().Count() == 8 && wheel.Children.OfType<Button>().All(button => !button.IsEnabled), "开课前八个原课堂功能全部禁用");
                    var screenPoint = pet.PointToScreen(new Point(1, 1));
                    var packed = (long)(ushort)screenPoint.X | ((long)(ushort)screenPoint.Y << 16);
                    object[] arguments = [IntPtr.Zero, (uint)0x0084, IntPtr.Zero, new IntPtr(packed), false];
                    var hit = (IntPtr)typeof(BanbanPetWindow).GetMethod("HitTest", Private)!.Invoke(pet, arguments)!;
                    Check(hit == new IntPtr(-1) && (bool)arguments[4], "圆环外透明区域继续穿透到课件");
                    Field<Button>(wheel, "_workbench").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    await Task.Delay(80);
                    Check(window.IsVisible && !pet.ClassroomExpanded && pet.Width == restWidth && pet.Height == restHeight, "开始课堂返回工作台且班班恢复原大小");
                    await browser.Core!.ExecuteScriptAsync("document.getElementById('create-session').click()");
                    await Wait("document.getElementById('workspace').hidden===false && !document.getElementById('start').disabled");
                    await Task.Delay(100); pet.UpdateLayout();
                    Check(pet.ClassroomExpanded, "手动开课后回到原班班圆环");
                    Button Sector(string id) => wheel.Children.OfType<Button>().Single(button => button.Name == "ClassroomWheel_" + id.Replace('-', '_'));
                    var input = pet.InputHitTest(new Point(160, 47));
                    var physicalButton = input as Button ?? (input as Visual)?.GetVisualAncestors().OfType<Button>().FirstOrDefault();
                    Check(ReferenceEquals(physicalButton, Sector("collect")), "缩小后的扇区仍按真实形状命中");
                    Sector("collect").Focus(); Sector("collect").RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Right });
                    Check(Sector("source").IsKeyboardFocusWithin, "方向键跳过不可用扇区并保留键盘焦点");
                    using (var bitmap = new RenderTargetBitmap(new PixelSize(640, 784), new Vector(192, 192)))
                    { bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(outputDirectory, "native-pet-wheel.png")); }
                    Sector("collect").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    await Wait("document.querySelector('#camera')?.srcObject?.getVideoTracks()[0]?.readyState==='live'");
                    Check(!pet.ClassroomExpanded && pet.Width == restWidth, "开始收答后收起圆环并恢复原来的班班");
                    lesson = new Window { Width = window.Width, Height = window.Height, Position = window.Position,
                        ShowInTaskbar = false, Content = new Border { Background = Brushes.White } };
                    lesson.Show(); lesson.Activate(); await Task.Delay(4200);
                    Check(await Read("document.querySelector('#camera')?.srcObject?.getVideoTracks()[0]?.readyState==='live' && document.getElementById('camera-status').textContent==='相机已开启'"), "课件覆盖工作台后相机仍持续采集");
                    lesson.Close(); lesson = null;
                    pet.SetClassroomExpanded(true); await Task.Delay(100);
                    Check(!Sector("next").IsEnabled && !Sector("source").IsEnabled, "收答中的原班班同步禁用换题和来源");
                    pet.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Escape });
                    Check(!pet.ClassroomExpanded && pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single() == mascot, "Esc收起后仍是原班班实例");
                    talk.Focus();
                    talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyDownEvent, Key = Key.Enter });
                    talk.RaiseEvent(new KeyEventArgs { RoutedEvent = InputElement.KeyUpEvent, Key = Key.Enter });
                    Check(talks == 1, "原班班的单击与键盘说话入口保留");
                    Check(await window.PrepareToCloseAsync(), "退出仍通过原课堂暂停落盘");
                }
                catch (Exception error) { failure = error; Console.Error.WriteLine(error); }
                finally
                {
                    await File.WriteAllTextAsync(Path.Combine(outputDirectory, "native-wheel-result.json"), JsonSerializer.Serialize(new { passed, error = failure?.ToString() }, new JsonSerializerOptions { WriteIndented = true }));
                    lesson?.Close(); pet.Shutdown(); window.CloseWithoutPrompt(); CardQuizService.Stop(); desktop.Shutdown(failure is null ? 0 : 1);
                }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) Environment.ExitCode = 1;
    }
}

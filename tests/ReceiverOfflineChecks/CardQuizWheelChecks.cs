using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Automation;
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
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
    [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr parent, NativePoint point, uint flags);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref NativePoint point);
    internal static void Run(string outputDirectory, string? twoCardVideo = null)
    {
        Directory.CreateDirectory(outputDirectory);
        var petSettingsPath = Path.Combine(outputDirectory, $"pet-check-{Guid.NewGuid():N}.json");
        var mediaArgs = "--use-fake-device-for-media-stream --use-fake-ui-for-media-stream";
        if (twoCardVideo is not null) mediaArgs += " --use-file-for-fake-video-capture=\"" + Path.GetFullPath(twoCardVideo) + "\"";
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", mediaArgs);
        Exception? failure = null;
        var passed = new List<string>();
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                var config = new ReceiverConfig { Endpoint = "http://127.0.0.1:9/", ClassId = Guid.NewGuid().ToString(), DeviceId = Guid.NewGuid().ToString(), DeviceToken = "isolated-wheel-check", ClassName = "原班班圆环隔离验收" };
                CardQuizService.For(config).Store.SaveCache("context", new JsonObject {
                    ["classId"] = config.ClassId, ["deviceId"] = config.DeviceId, ["className"] = config.ClassName,
                    ["students"] = new JsonArray(new JsonObject { ["id"] = "s1", ["name"] = "演示甲", ["cardNumber"] = 1 },
                        new JsonObject { ["id"] = "s2", ["name"] = "演示乙", ["cardNumber"] = 2 }), ["publications"] = new JsonArray()
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
                    var main = Field<Button>(wheel,"_main");
                    var restSize = new Size(pet.Width,pet.Height);
                    foreach (var dpi in new[] {1d,1.5,2d})
                    foreach (var right in new[] { false,true })
                    {
                        var work = new PixelRect(-600,0,600,480);
                        var anchorX = right ? work.Right-55 : work.X+55;
                        var fit = BanbanPetWindow.FitClassroom(new PixelPoint(anchorX,475),work,dpi,100,.8,right);
                        var bounds = new PixelRect(fit.Position,new PixelSize((int)Math.Round(fit.Size.Width*dpi),(int)Math.Round(fit.Size.Height*dpi)));
                        if (!work.Contains(bounds) || fit.PetTop<0 || fit.PetTop+140*fit.Scale>fit.Size.Height+.01)
                            throw new InvalidOperationException("紧凑屏幕定位 "+dpi);
                    }
                    Check(true,"窄工作区左右停靠及 100%、150%、200% 缩放均在屏内");
                    PixelPoint Anchor() => mascot.PointToScreen(new Point(mascot.Bounds.Width/2,mascot.Bounds.Height/2));
                    var anchor = Anchor();
                    void Click(Button b) { if (!b.IsEffectivelyVisible || !b.IsEnabled) throw new InvalidOperationException("不可用按钮 "+b.Content); b.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); }
                    Button? Find(string label) => wheel.GetVisualDescendants().OfType<Button>().FirstOrDefault(b=>b.IsEffectivelyVisible &&
                        (AutomationProperties.GetName(b)==label || b.Content as string==label));
                    Button ButtonFor(string label) => Find(label) ?? throw new InvalidOperationException("未找到 "+label);
                    async Task Until(Func<bool> ready,string label)
                    {
                        for (var i=0;i<150;i++) { pet.UpdateLayout(); if (ready()) return; await Task.Delay(80); }
                        throw new InvalidOperationException("等待 "+label+"，当前主操作 "+main.Content+"，"+Field<TextBlock>(wheel,"_caption").Text);
                    }
                    Task Primary(string label) => Until(()=>main.Content as string==label && main.IsEnabled,label);
                    void Snapshot(string filename)
                    {
                        pet.UpdateLayout();
                        using var bitmap = new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(pet.Width*2),(int)Math.Ceiling(pet.Height*2)),new Vector(192,192));
                        bitmap.Render((Visual)pet.Content!); bitmap.Save(Path.Combine(outputDirectory,filename));
                    }
                    Click(talk); await Primary("开始课堂");
                    Check(OnlyPet() && pet.ClassroomExpanded && talks==0 && chats==0 && mascot.AssetsLoaded,"课中单击原人物即展开同窗课堂");
                    Check(main.Background is ILinearGradientBrush && main.MinHeight >= 44 && main.CornerRadius == new CornerRadius(13),
                        "主操作命中教室端共享样式与触控高度");
                    Snapshot("native-pet-home.png");
                    Check(Math.Abs(Anchor().X-anchor.X)<=2 && Math.Abs(Anchor().Y-anchor.Y)<=2,"展开时人物屏幕坐标稳定");
                    var screenPoint = pet.PointToScreen(new Point(1,1));
                    var packed = (long)(ushort)screenPoint.X | ((long)(ushort)screenPoint.Y << 16);
                    object[] hitArgs = [IntPtr.Zero,(uint)0x0084,IntPtr.Zero,new IntPtr(packed),false];
                    Check((IntPtr)typeof(BanbanPetWindow).GetMethod("HitTest",Private)!.Invoke(pet,hitArgs)! == new IntPtr(-1) && (bool)hitArgs[4],"圆环外透明角可穿透课件");
                    var mainPoint = main.TranslatePoint(new Point(main.Bounds.Width/2,main.Bounds.Height/2),pet)!.Value;
                    var hit = pet.InputHitTest(mainPoint);
                    Check(hit==main || (hit as Visual)?.GetVisualAncestors().Contains(main)==true,"顶部操作真实命中");
                    Click(ButtonFor("课表")); Check(Field<StackPanel>(wheel,"_schedule").Children.Count>0,"课表读取现有快照或显示缺少课表");
                    Click(main); Click(ButtonFor("说话")); Click(main); Check(talks==1 && OnlyPet(),"圆环说话使用原语音回调");
                    Click(ButtonFor("返回课堂")); Click(ButtonFor("开课设置"));
                    var setup = Field<BanbanClassroomSetup>(wheel,"_setup");
                    Check(setup.IsVisible && OnlyPet(),"开课设置保留在班班内");
                    Click(ButtonFor("学科，语文")); Click(ButtonFor("数学")); Check(Find("学科，数学")!=null,"同窗选择学科");
                    Snapshot("native-pet-setup.png");
                    Click(ButtonFor("开始课堂")); await Primary("开始收答");
                    await Wait("document.getElementById('class-name').textContent.includes('数学')");
                    var position = pet.Position;
                    main.Focus(); main.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyDownEvent,Key=Key.Enter});
                    main.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyUpEvent,Key=Key.Enter});
                    await Primary("结束收答");
                    await Wait("document.getElementById('camera').srcObject?.active===true");
                    if (twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    Check(OnlyPet() && pet.Position==position,"键盘开始收答，相机在原位置启动");
                    lesson = new Window { Width=600,Height=420,Position=pet.Position,ShowInTaskbar=false,Content=new Border { Background=Brushes.White } };
                    lesson.Show(); lesson.Activate(); await Task.Delay(3400);
                    Check(await Read("document.getElementById('camera').srcObject?.active && document.getElementById('camera-status').textContent==='相机已开启'"),"课件取焦后采集继续");
                    lesson.Close(); lesson=null; pet.Activate();
                    Click(ButtonFor("课堂工具")); Click(ButtonFor("核对卡号"));
                    await Wait("document.getElementById('exempt-dialog').open && innerWidth>220 && !document.hidden");
                    var screen = pet.ClassroomHost!.Browser.PointToScreen(new Point(50,70));
                    var childPoint = new NativePoint { X=screen.X,Y=screen.Y }; var handle=pet.TryGetPlatformHandle()!.Handle;
                    ScreenToClient(handle,ref childPoint); var child=ChildWindowFromPointEx(handle,childPoint,1);
                    Check(child!=IntPtr.Zero && child!=handle && OnlyPet(),"核卡详情位于同一窗口并命中原生网页控件");
                    await pet.ClassroomHost.Browser.Core!.ExecuteScriptAsync("document.querySelector('[data-dismiss=\"exempt-dialog\"]').click()");
                    await Until(()=>!wheel.DetailVisible,"退出核卡"); Click(main);
                    pet.SetClassroomExpanded(false);
                    await Wait("document.getElementById('round-status').textContent.includes('已暂停') && !document.getElementById('camera').srcObject");
                    Check(Math.Abs(pet.Width-restSize.Width)<1 && Math.Abs(pet.Height-restSize.Height)<1 && pet.IsVisible,"收起后释放相机，课中人物仍在");
                    pet.SetClassroomExpanded(true); await Primary("继续收答"); Click(main); await Primary("结束收答");
                    if (twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    var store = CardQuizService.For(config).Store;
                    var journal = store.Load()["journals"]!.AsArray().Single()!["session"]!;
                    var id = journal["id"]!.GetValue<string>(); var file=Path.Combine(Field<string>(store,"_root"),"sessions",id+".json");
                    using (var locked=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read))
                    {
                        Click(main); await Primary("重读记录");
                        Check(await Read("!document.getElementById('round-status').textContent.includes('封存')"),"落盘失败不会展示虚假分布");
                    }
                    Click(main); await Primary("恢复课堂"); Click(main); await Primary("继续收答");
                    Check(store.Load()["journals"]!.AsArray().Count==1 && (twoCardVideo==null || await Read("document.getElementById('received').textContent==='2'")),"重读恢复同一轮及已收卡");
                    Click(main); await Primary("结束收答"); Click(main); await Primary("下一题");
                    var state=Field<CardQuizWheelState>(wheel,"_state");
                    Check(state.Lesson.Phase=="result" && state.Panel=="" && (twoCardVideo==null || state.Lesson.Counts.SequenceEqual([1,1,0,0])),"封存即在圆环展示匿名条形图");
                    Snapshot("native-pet-wheel.png");
                    Click(main); await Primary("开始收答"); Click(ButtonFor("判断"));
                    await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson is { Kind:"boolean",Busy:false },"判断题");
                    Check(ButtonFor("判断").Classes.Contains("selected") && !ButtonFor("单选").Classes.Contains("selected"),
                        "题型切换使用同组的共享选中状态");
                    Click(main); await Primary("结束收答"); if(twoCardVideo!=null) await Wait("document.getElementById('received').textContent==='2'");
                    Click(main); await Primary("下一题"); Click(main); await Primary("开始收答"); Click(ButtonFor("多选"));
                    await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson is { Kind:"multiple",Busy:false },"多选题");
                    Click(main); await Primary("收 B 项");
                    if(twoCardVideo!=null) await Until(()=>Field<CardQuizWheelState>(wheel,"_state").Lesson.Received==2,"A 项两人");
                    Snapshot("native-pet-multiple.png");
                    Click(main); await Primary("收 C 项"); await Task.Delay(1600);
                    Check(await Read("document.getElementById('camera').srcObject?.active===true") && Field<CardQuizWheelState>(wheel,"_state").Lesson.Received==0,
                        "一键切到 B 项，相机已开启，持续举着的旧卡均未计入");
                    Click(ButtonFor("待收 2 人")); Check(Field<WrapPanel>(wheel,"_cards").Children.Count==2,"待收展示两张匿名卡号"); Click(main);
                    pet.SetClassroomExpanded(false); await Wait("document.getElementById('round-status').textContent.includes('已暂停')");
                    pet.SetClassroomExpanded(true); await Primary("继续收答"); Click(main); await Primary("收 C 项"); await Task.Delay(1200);
                    Check(Field<CardQuizWheelState>(wheel,"_state").Lesson is {Option:"B",Received:0},"B 项收起后恢复仍要求重新举卡");
                    Click(main); await Primary("收 D 项"); Click(main); await Primary("结束收答"); Click(main); await Primary("下一题");
                    if (twoCardVideo!=null) Check(Field<CardQuizWheelState>(wheel,"_state").Lesson.Caption.Contains("未完成 2"),"缺少分项的两张卡均记未完成");
                    Click(ButtonFor("结束课堂")); Click(ButtonFor("取消")); await Primary("下一题"); Click(ButtonFor("结束课堂"));
                    await Primary("确认结课"); Click(main); await Primary("返回班班");
                    Click(ButtonFor("课堂记录")); Check(Find("返回汇总")==main && Find("下一题")?.IsEnabled==true,"结课后在圆环翻看多题记录");
                    Click(ButtonFor("下一题")); Click(ButtonFor("下一题")); Check(!ButtonFor("下一题").IsEnabled,"记录翻页停在最后一道题");
                    Click(main); Check(OnlyPet() && Field<CardQuizWheelState>(wheel,"_state").Lesson.NeedsSync,"离线结课在原窗保留重试同步");
                    Click(main); await Until(()=>!pet.ClassroomExpanded,"返回贴边班班");
                    talk.Focus(); talk.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyDownEvent,Key=Key.Left});
                    pet.UpdateLayout(); var left=Anchor(); Click(talk); await Primary("开始课堂");
                    Check(Math.Abs(Anchor().X-left.X)<=2 && Math.Abs(Anchor().Y-left.Y)<=2 && Canvas.GetLeft(wheel)>0,"左侧停靠时原地向右展开");
                    pet.RaiseEvent(new KeyEventArgs {RoutedEvent=InputElement.KeyDownEvent,Key=Key.Escape});
                    Check(!pet.ClassroomExpanded && pet.GetVisualDescendants().OfType<BanbanPetMascot>().Single()==mascot,"Esc 收起同一个班班");
                    Check(await pet.ClassroomHost.PrepareToCloseAsync(), "退出仍通过原课堂暂停落盘");
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

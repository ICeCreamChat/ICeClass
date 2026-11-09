using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class NativeSelfStudyFeedbackChecks
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check(string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<string>();
        void Assert(bool value,string name) { if(!value)throw new InvalidOperationException(name);checks.Add(name); }
        ClassroomIslandWindow? window = null;
        try
        {
            var profile = new IslandProfile { Reminders=new(){Enabled=false},Slots=[
                new(){Id="e1",Label="第一节晚自习",Start=1110,End=1185},new(){Id="e2",Label="第二节晚自习",Start=1200,End=1290}],
                Lessons=[new(){SlotId="e1",Weekday=1,Subject="自主学习"},new(){SlotId="e2",Weekday=1,Subject="自主学习"}] };
            var now = new DateTimeOffset(2026,11,9,20,5,0,TimeSpan.FromHours(8));
            var view = IslandRibbonChecks.View();
            window = new(()=>Task.CompletedTask,()=>{},()=>{},()=>{},()=>{});
            var ribbon=(ClassroomIslandRibbon)typeof(ClassroomIslandWindow).GetField("_ribbon",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(window)!;
            var phases=new[]{"listening","observing","analyzing","teaching","warning","reported","budget","ai_paused","paused","inactive","error",
                "observing-warning","analyzing-warning","observing-reported"};
            ribbon.ReviewPhase=1;
            window.Show();
            foreach(var light in new[]{true,false}) foreach(var width in new[]{380,640,1000}) foreach(var phaseKey in phases)
            {
                var parts=phaseKey.Split('-',2);var phase=parts[0];var alert=parts.Length>1?parts[1]:"";
                var capturing=phase is not ("paused" or "inactive" or "error");
                var feedback=new SelfStudyFeedback(phase,"合成输入，用于原生浮岛回归验收",capturing,Alert:alert);
                window.UpdateSelfStudyFeedback(feedback);
                var currentView=view with { Notice=phase=="warning"?new("晚自习提醒","请保持安静","info","晚自习通知",1):null };
                window.Update(currentView,false,true);
                window.ApplyProfile(new(){Width=width,HideFullscreen=false,Theme=light?"light":"dark",Material="solid"},profile,now,"","已连接");
                await Task.Delay(20);
                for(var i=0;i<43;i++)ribbon.SetSelfStudyLevel(SelfStudySoundMeter.Measure(Enumerable.Repeat((float)(.005+.12*(i%9)/9),800).ToArray()));
                window.UpdateLayout();
                Assert(window.ClientSize.Height<=60 && Math.Abs(ribbon.Bounds.Height-48)<.1,$"48 DIP shell: {light}/{width}/{phase}");
                Assert(ribbon.Frame is {Text.Length:0,SelfStudy:not null},$"state stays in current course cell: {light}/{width}/{phase}");
                Assert(ribbon.Frame!.Items.Single(i=>i.Current).Subject=="自主学习",$"course identity retained: {light}/{width}/{phase}");
                var expand = (Button)typeof(ClassroomIslandWindow).GetField("_expand", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(window)!;
                Assert(AutomationProperties.GetName(expand)?.Contains(feedback.Label) == true,
                    $"current phase is accessible through the island button: {light}/{width}/{phase}");
                var visibleCaption=ribbon.Frame.SelfStudy!.Caption;
                Assert(AutomationProperties.GetName(expand)?.Contains(visibleCaption) == true && ribbon.Frame.AccessibleText.Contains(visibleCaption),
                    $"current operation is accessible: {light}/{width}/{phase}");
                var root=(Control)window.Content!;
                using var bitmap=new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width),(int)Math.Ceiling(root.Bounds.Height)),new Vector(96,96));
                bitmap.Render(root);bitmap.Save(Path.Combine(output,$"{(light?"light":"dark")}-{width}-{phaseKey}.png"));
            }
            ribbon.Animate=true;
            var observing=new SelfStudyFeedback("observing","持续有效人声",true);
            window.UpdateSelfStudyFeedback(observing);window.Update(view,false,true);
            ribbon.ReviewPhase=.5;
            var displayed=ribbon.SelfStudyPaintColor(observing,5);
            var learning=new SelfStudyFeedback("teaching","正常学习交流",true);
            window.UpdateSelfStudyFeedback(learning);
            Assert(ribbon.SelfStudyPaintColor(learning,0)==displayed,"interrupted color transition starts at the current blended color");
            var analyzing=new SelfStudyFeedback("analyzing","正在复核",true);
            window.UpdateSelfStudyFeedback(analyzing);ribbon.ReviewPhase=1;
            displayed=ribbon.SelfStudyPaintColor(analyzing,10);
            var reminder=analyzing with {Reminder=true};
            ribbon.Present(ribbon.Frame! with {SelfStudy=reminder});
            Assert(ribbon.SelfStudyPaintColor(reminder,0)==displayed,"first reminder overlay starts a continuous color transition even without a monitor phase change");
            Assert(ribbon.Frame!.AccessibleText.Contains("请降低交谈音量"),"first reminder keeps its visible instruction accessible");
            ribbon.Present(ribbon.Frame with {SelfStudy=observing});
            ribbon.ReviewPhase=null;
            var flags=BindingFlags.NonPublic|BindingFlags.Instance;
            typeof(ClassroomIslandRibbon).GetField("_selfStudyStarted",flags)!.SetValue(ribbon,Stopwatch.GetTimestamp()-2*Stopwatch.Frequency);
            var animating=typeof(ClassroomIslandRibbon).GetProperty("SelfStudyAnimating",flags)!;
            Assert(animating.GetValue(ribbon) is true,"observation keeps repainting after the old 800ms animation window");
            typeof(ClassroomIslandRibbon).GetField("_selfStudyStarted",flags)!.SetValue(ribbon,Stopwatch.GetTimestamp()-11*Stopwatch.Frequency);
            Assert(animating.GetValue(ribbon) is false,"completed observation gradient stops its own frame loop");
            ribbon.Present(ribbon.Frame with {SelfStudy=analyzing,Shout=new("老师","请看黑板","urgent","text",0,1)});
            Assert(animating.GetValue(ribbon) is false,"teacher shout suppresses a hidden self-study animation loop");
            ribbon.Present(ribbon.Frame with {SelfStudy=analyzing,Shout=null});
            window.Hide();
            Assert(animating.GetValue(ribbon) is false,"hidden window suppresses self-study animation");
            window.Show();
            using(var monitor=new SelfStudyMonitor(_=>Task.FromResult(false),()=>false,()=>{}))
            {
                void Set(string name,object? value)=>typeof(SelfStudyMonitor).GetField(name,flags)!.SetValue(monitor,value);
                SelfStudyFeedback? published=null;monitor.FeedbackChanged+=value=>published=value;
                Set("_period",new SelfStudyPeriod{Key="test"});Set("_state","warning");Set("_eventAttention","warning");
                Set("_analysisEnabled",true);Set("_voiceSince",Environment.TickCount64-800);
                Set("_lastVoiceAt",Environment.TickCount64-100);
                Set("_audio",System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SelfStudyAudio)));
                try
                {
                    typeof(SelfStudyMonitor).GetMethod("QueueSound",flags)!.Invoke(monitor,[new SelfStudySound(.6,true),0]);
                    await Task.Delay(30);
                    Assert(published is {State:"observing",Attention:"warning"},"real sound after a shown reminder enters new observation without losing the warning");
                    Set("_audio",null);monitor.Pause();
                    Assert(published is {State:"paused",Capturing:false,Attention:""},"local pause clears warning attention and stops capture feedback");
                }
                finally{Set("_audio",null);}
            }
            using(var monitor=new SelfStudyMonitor(_=>Task.FromResult(false),()=>false,()=>{}))
            {
                void Set(string name,object? value)=>typeof(SelfStudyMonitor).GetField(name,flags)!.SetValue(monitor,value);
                SelfStudyFeedback? published=null;monitor.FeedbackChanged+=value=>published=value;
                Set("_period",new SelfStudyPeriod{Key="natural-speech"});Set("_state","listening");Set("_analysisEnabled",true);
                Set("_audio",System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SelfStudyAudio)));
                async Task Sound(bool speech,int wait)
                {
                    typeof(SelfStudyMonitor).GetMethod("QueueSound",flags)!.Invoke(monitor,[new SelfStudySound(.3,speech),0]);
                    await Task.Delay(wait);
                }
                try
                {
                    await Sound(true,150);
                    Assert(published is null or {State:"listening"},"a single short voice burst does not immediately enter observation");
                    await Sound(false,150);await Sound(true,150);await Sound(false,150);await Sound(true,30);
                    Assert(published is {State:"observing"},"normal short pauses between voiced syllables do not keep resetting observation");
                    Set("_lastVoiceAt",Environment.TickCount64-2100);await Sound(false,30);
                    Assert(published is {State:"listening"},"two seconds without valid speech restore listening after observation");
                    Set("_voiceSince",Environment.TickCount64-1000);Set("_lastVoiceAt",Environment.TickCount64-500);await Sound(true,30);
                    Assert(published is {State:"listening"},"a new burst after a long gap cannot reuse the previous observation span");
                    Set("_snapshot",new SelfStudySnapshot { Config=new SelfStudyConfig { VoiceTriggerMs=1200,ObservationSeconds=30 } });
                    Set("_voiceSince",Environment.TickCount64-800);Set("_lastVoiceAt",Environment.TickCount64);
                    await Sound(true,30);
                    Assert(published is {State:"listening"},"saved voice trigger delay prevents an early observation");
                    Set("_voiceSince",Environment.TickCount64-1300);await Sound(true,30);
                    Assert(published is {State:"observing",ObservationSeconds:30},"saved rules drive observation and the native color horizon together");
                }
                finally{Set("_audio",null);}
            }
            var events=0;ribbon.MaterialGeometryChanged+=()=>events++;
            ribbon.Animate=false;ribbon.ReviewPhase=1;
            window.UpdateSelfStudyFeedback(new("listening","本地声音",true));
            events=0;var started=Stopwatch.StartNew();var allocated=GC.GetAllocatedBytesForCurrentThread();
            for(var i=0;i<1000;i++)ribbon.SetSelfStudyLevel((i%10)/10d);
            started.Stop();
            var allocation=GC.GetAllocatedBytesForCurrentThread()-allocated;
            Assert(events==0,"1000 live levels never rebuild glass geometry");
            var history=(double[])typeof(ClassroomIslandRibbon).GetField("_soundHistory",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(ribbon)!;
            Assert(history.Any(v=>v>0),"measured input reaches native waveform history");
            window.UpdateSelfStudyFeedback(new("budget","AI 暂停，本地声音继续",true));ribbon.SetSelfStudyLevel(.6);
            Assert(history.Any(v=>v>.1),"AI budget stop preserves a responsive waveform");
            window.UpdateSelfStudyFeedback(new("paused","本节已暂停",false));ribbon.SetSelfStudyLevel(.9);
            Assert(history.All(v=>v==0),"stopped capture clears history and rejects late samples");
            var shout=view with {Notice=new("老师","请阅读通知","urgent","班级通知",2)};
            Assert(IslandRibbonPresentation.Build(profile,now,shout,"",new("analyzing","",true)).Shout is not null,"teacher shout retains presentation priority");
            File.WriteAllText(Path.Combine(output,"result.json"),JsonSerializer.Serialize(new { passed=checks.Count,meterUpdates=1000,meterElapsedMs=started.Elapsed.TotalMilliseconds,meterAllocatedBytes=allocation,materialChanges=events,hardware=false,paidAi=false },new JsonSerializerOptions{WriteIndented=true}));
            Console.WriteLine($"Native self-study feedback checks passed: {checks.Count}; screenshots: {output}");
        }
        catch(Exception error){Console.Error.WriteLine(error);Environment.ExitCode=1;}
        finally
        {
            File.WriteAllLines(Path.Combine(output,"checks.txt"),checks);window?.DisposeWindow();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

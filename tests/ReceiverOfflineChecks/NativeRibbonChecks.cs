using System.Reflection;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Receiver;

internal static class NativeRibbonChecks
{
    public static void Run(bool light = false) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(light)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Check(bool light)
    {
        var output=Path.GetFullPath(light ? "output/island-spacing-20261019/native-light" : "output/island-motion-20261019"); Directory.CreateDirectory(output);
        var checks=new List<string>();
        void Assert(bool value,string label) { if(!value) throw new Exception(label); checks.Add(label); Console.WriteLine("PASS "+label); }
        void Capture(Control root,string name)
        {
            using var bitmap=new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width),(int)Math.Ceiling(root.Bounds.Height)),new Vector(96,96));
            bitmap.Render(root); bitmap.Save(Path.Combine(output,name+".png"));
        }
        ClassroomIslandWindow? window=null; Window? host=null;
        try
        {
            var p=IslandRibbonChecks.Fixture(); var now=IslandRibbonChecks.At(10,38,50); var view=IslandRibbonChecks.View();
            var opened=0;
            window=new ClassroomIslandWindow(()=> { opened++; return Task.CompletedTask; },()=>{},()=>{},()=>{},()=>{});
            var ribbon=(ClassroomIslandRibbon)typeof(ClassroomIslandWindow).GetField("_ribbon",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(window)!;
            ribbon.Animate=false;
            window.Update(view,false); window.ApplyProfile(new(){Width=1000,HideFullscreen=false},p,now,"","已连接"); window.Show();
            await Task.Delay(100);
            foreach(var width in light ? new[]{380,560,640,1000} : new[]{380,640,1000})
            {
                window.ApplyProfile(new(){Width=width,HideFullscreen=false},p,now,"","已连接"); await Task.Delay(40);
                Assert(window.ClientSize.Height<=60 && Math.Abs(ribbon.Bounds.Height-48)<.1,$"native ribbon stays 48 DIP tall at {width} DIP width");
                Assert(ribbon.Bounds.Width>=width-12 && ribbon.Frame is not null,$"native button stretches and renders its ribbon content at {width} DIP");
                Capture((Control)window.Content!,"native-compact-"+width);
                window.Update(view with {Notice=new("准备上课","请准备课本", "info","教室提醒",1)},false);
                window.ApplyProfile(new(){Width=width,HideFullscreen=false},p,IslandRibbonChecks.At(10,39),"","已连接"); await Task.Delay(40);
                Assert(!window.IsExpanded && window.ClientSize.Height<=60,$"notification never expands the operations panel at {width} DIP");
                Capture((Control)window.Content!,"native-cue-"+width);
                window.Update(view,false);
            }
            window.ApplyProfile(new(){Width=380,Theme="light",HideFullscreen=false},p,now,"距运动会 8 天","已连接");
            window.SetExpanded(true); await Task.Delay(650);
            var root=(Control)window.Content!;
            Assert(window.IsExpanded && root.GetVisualDescendants().OfType<Button>().Where(b=>b.IsEffectivelyVisible).All(b=>{
                var point=b.TranslatePoint(default,root)!.Value; return point.X>=-1 && point.X+b.Bounds.Width<=root.Bounds.Width+1;
            }),"manual operations remain accessible without horizontal overflow at 380 DIP");
            Capture(root,"native-details-light-380");
            root.GetVisualDescendants().OfType<Button>().Single(b=>b.Content?.ToString()=="打开早读").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Task.Delay(650);
            Assert(opened==1 && !window.IsExpanded,"existing early-reading action still opens once and retracts controls");
            using(var pulse=new IslandAttentionPulseWindow())
                Assert(!pulse.ShowActivated && !pulse.Focusable && !pulse.IsHitTestVisible,"desktop attention wave neither activates nor receives pointer input");
            window.DisposeWindow(); window=null;

            var stage=new Grid { Width=1280,Height=720,Background=new SolidColorBrush(Color.Parse(light ? "#F2F5FA" : "#07101F")) };
            var wave=new IslandAttentionPulse { Center=new Point(640,24), Color=light ? "#65B2ED" : "#14FFFA" }; stage.Children.Add(wave);
            var visual=new ClassroomIslandRibbon { Width=light ? 560 : 1000,Light=light,VerticalAlignment=VerticalAlignment.Top,HorizontalAlignment=HorizontalAlignment.Center,ReviewPhase=1 };
            stage.Children.Add(visual); host=new Window { Content=stage,Width=1280,Height=720,ShowActivated=false,SystemDecorations=SystemDecorations.None };
            ClassroomStyle.Apply(host); host.Show(); await Task.Delay(80);
            var normal=IslandRibbonPresentation.Build(p,now,view);
            var cue=normal with {Key="cue",Text="即将上课",Accent=true};
            var countdown=IslandRibbonPresentation.Build(p,IslandRibbonChecks.At(10,39,6),view);
            var sentence=IslandRibbonPresentation.Build(p,IslandRibbonChecks.At(10,39,16),view);
            var started=cue with {Key="start",Text="上课"};
            var restored=IslandRibbonPresentation.Build(p,IslandRibbonChecks.At(10,40),view);
            foreach(var (name,frame) in new[]{("01-timetable",normal),("02-prepare",cue),("03-countdown",countdown),("04-message",sentence),("05-start",started),("06-restored",restored)})
            { visual.Present(frame); visual.ReviewPhase=1; Capture(stage,name); }
            visual.Present(normal); visual.Present(cue); visual.ReviewPhase=.16; wave.Progress=.25; Capture(stage,"07-wipe-wave"); wave.Progress=0;
            visual.Present(countdown); visual.Present(sentence); visual.ReviewPhase=.12; Capture(stage,"08-text-transition");
            visual.Present(started); visual.Present(restored); visual.ReviewPhase=.16; Capture(stage,"09-retract-wipe");
            // Render the actual native painter at deterministic times for a review clip.
            var frames=Path.Combine(output,"frames"); Directory.CreateDirectory(frames);
            for(var index=0;index<660;index++)
            {
                var t=index/30.0; var frame=t<2?normal:t<5?cue:t<10?countdown:t<14?sentence:t<17?countdown:t<20?started:restored;
                if(frame==countdown) frame=countdown with {Text=$"距上课还有 {Math.Max(1,(int)Math.Ceiling((17-t)*5))} 秒",Progress=Math.Clamp((17-t)/12,0,1)};
                var boundary=t<2?0:t<5?2:t<10?5:t<14?10:t<17?14:t<20?17:20;
                visual.Present(frame);
                visual.ReviewPhase=boundary==0 ? 1 : Math.Clamp((t-boundary)/.55,0,1);
                wave.Progress=(boundary==2 || boundary==17) && t-boundary<.7 ? (t-boundary)/.7 : 0;
                Capture(stage,"frames/"+index.ToString("0000"));
            }
            visual.Dispose();
            Assert(File.Exists(Path.Combine(frames,"0659.png")),"native motion review covers attention, countdown, text transition and timetable restoration");
            Console.WriteLine($"{checks.Count} native ribbon checks passed. {output}");
        }
        catch(Exception error) { Console.Error.WriteLine(error); Environment.ExitCode=1; }
        finally
        {
            window?.DisposeWindow(); host?.Close(); File.WriteAllLines(Path.Combine(output,"native-checks.txt"),checks);
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

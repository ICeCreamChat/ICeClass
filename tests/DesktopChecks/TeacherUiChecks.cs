using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Avalonia.VisualTree;
using ICeClass.Desktop;
using ICeClass.Receiver;
using ICeClass.Updates;

internal static class TeacherUiChecks
{
    internal static string Output = "";
    internal static void Run(string output)
    {
        Output = Path.GetFullPath(output);
        var thread = new Thread(() => AppBuilder.Configure<TeacherUiCheckApp>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}

public sealed class TeacherUiCheckApp : Application
{
    private readonly App _product = new();
    public override void Initialize()
    {
        _product.Initialize(); RequestedThemeVariant = Avalonia.Styling.ThemeVariant.Light;
        foreach (var resource in _product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = _product.Styles.ToArray(); _product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted(); Dispatcher.UIThread.Post(() => _ = Check());
    }
    private async Task Check()
    {
        var checks = new List<string>(); var failures = new List<string>(); var windows = new List<Window>();
        void Assert(bool condition, string label) { (condition ? checks : failures).Add(label); }
        static T Field<T>(object owner, string name) => (T)owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(owner)!;
        async Task Until(Func<bool> ready)
        {
            for (var i=0; i<300 && !ready(); i++) await Task.Delay(50);
            if (!ready()) throw new Exception("Native teacher UI condition timed out");
        }
        async Task Render(Window window, string name, double width, double height)
        {
            window.Width=width; window.Height=height; window.Opacity=0; window.ShowActivated=false; window.ShowInTaskbar=false;
            windows.Add(window); window.Show(); await Task.Delay(90); window.UpdateLayout();
            var root=(Control)window.Content!;
            if (Environment.GetEnvironmentVariable("ICECLASS_CAPTURE_UI") == "1")
                foreach(var scale in new[] {1d,1.5})
                {
                    using var bitmap=new RenderTargetBitmap(new PixelSize((int)Math.Ceiling(root.Bounds.Width*scale),(int)Math.Ceiling(root.Bounds.Height*scale)),new Vector(96*scale,96*scale));
                    bitmap.Render(root); bitmap.Save(Path.Combine(TeacherUiChecks.Output,$"{name}-{width:0}-{scale*100:0}.png"));
                }
            foreach(var button in window.GetVisualDescendants().OfType<Button>().Where(b=>b.IsEffectivelyVisible && b.Content is string {Length:>0}))
            {
                var label=(string)button.Content!;
                var text=button.GetVisualDescendants().OfType<TextBlock>().FirstOrDefault(t=>t.Text==label);
                if(text is not null)Assert(text.TextLayout.WidthIncludingTrailingWhitespace<=text.Bounds.Width+1,$"{name}/{width}: action fits: {label}");
            }
        }
        using var listener=new HttpListener(); using var lifetime=new CancellationTokenSource();
        var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requested=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failPage=false;
        try
        {
            Directory.CreateDirectory(TeacherUiChecks.Output);
            using var port=new TcpListener(IPAddress.Loopback,0);port.Start();
            var endpoint="http://127.0.0.1:"+((IPEndPoint)port.LocalEndpoint).Port;port.Stop();
            listener.Prefixes.Add(endpoint+"/");listener.Start();
            async Task Reply(HttpListenerContext request)
            {
                try
                {
                    requested.TrySetResult();await release.Task.WaitAsync(lifetime.Token);
                    if(failPage)request.Response.StatusCode=503;
                    var bytes=Encoding.UTF8.GetBytes("<!doctype html><html lang=zh><meta charset=utf-8><title>隔离检查</title><body>本地教师工作台</body></html>");
                    request.Response.ContentType="text/html; charset=utf-8";request.Response.ContentLength64=bytes.Length;
                    await request.Response.OutputStream.WriteAsync(bytes,lifetime.Token);
                }
                catch(Exception error) when(error is OperationCanceledException or HttpListenerException or ObjectDisposedException){}
                finally{request.Response.Close();}
            }
            _=Task.Run(async()=>{try{while(!lifetime.IsCancellationRequested){var context=await listener.GetContextAsync().WaitAsync(lifetime.Token);_=Reply(context);}}catch(Exception error)when(error is OperationCanceledException or HttpListenerException or ObjectDisposedException){}});
            typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!.GetProperty("Options",BindingFlags.Static|BindingFlags.NonPublic)!
                .SetValue(null,LaunchOptions.Parse(["--server",endpoint,"--data-dir",Path.Combine(TeacherUiChecks.Output,"profile")]));
            var main=new DesktopWindow(_product,endpoint,false);
            var browser=Field<ReadingBrowser>(main,"_browser");
            Assert(!browser.IsVisible,"Native WebView begins hidden behind the loading message");
            await Render(main,"workspace-loading",800,560);
            await requested.Task.WaitAsync(TimeSpan.FromSeconds(15));
            Assert(!browser.IsVisible && Field<StackPanel>(main,"_error").IsVisible,"Slow navigation preserves the native loading message");
            Assert(AutomationProperties.GetLiveSetting(Field<TextBlock>(main,"_errorTitle"))==AutomationLiveSetting.Polite,"Loading and error title has an accessible status notification");
            release.TrySetResult();await Until(()=>Field<bool>(main,"_navigated"));
            Assert(browser.IsVisible,"Real WebView becomes visible after successful navigation");
            failPage=true;browser.Core!.Navigate(endpoint+"/unavailable");
            await Until(()=>Field<Button>(main,"_retry").IsVisible);
            Assert(!browser.IsVisible && Field<StackPanel>(main,"_error").IsVisible,"A failed real navigation exposes the native retry action");
            await Render(main,"workspace-error",800,560);
            failPage=false;Field<Button>(main,"_retry").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            await Until(()=>Field<bool>(main,"_navigated"));Assert(browser.IsVisible,"Native retry returns to the loaded workbench");main.Close();
            using var preparation=new VoicePreparation(ClassroomVoiceTranscriber.Resources,()=>new Uri(endpoint),(_,_)=>Task.FromResult(false));
            foreach(var width in new[]{520d,380d})
            {
                var settings=new SettingsWindow(new(){Endpoint=endpoint},preparation);await Render(settings,"desktop-settings",width,480);
                Assert(settings.GetVisualDescendants().OfType<Button>().Single(b=>b.Content as string=="取消").IsCancel,"Settings cancellation keeps the native cancel action");
                var field=settings.GetVisualDescendants().OfType<TextBox>().First();field.Text="http://school.example";
                settings.GetVisualDescendants().OfType<Button>().Single(b=>b.Content as string=="保存设置").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                var error=settings.GetVisualDescendants().OfType<TextBlock>().First(t=>t.Text?.Contains("HTTPS")==true);
                Assert(AutomationProperties.GetLiveSetting(error)==AutomationLiveSetting.Polite,"Invalid endpoint has an accessible error notification");settings.Close();
            }
            var confirmation=Dialogs.CreateConfirmation("重新打开工作台","请先保存尚未提交的内容，登录资料会保留。","重新打开");
            await Render(confirmation,"confirmation",480,240);
            Assert(confirmation.GetVisualDescendants().OfType<Button>().Single(b=>b.Content as string=="取消").IsCancel,"Confirmation uses the safe native cancel action");confirmation.Close();
            using var client=new TeacherFeedbackClient(endpoint,()=>Task.FromResult<string?>("fixture"));
            var feedback=new TeacherFeedbackWindow(client,new("fixture","fixture","fixture","测试教师"),()=>throw new InvalidOperationException("Capture is outside the test"),()=>endpoint,_=>Task.FromResult("Isolated diagnostic fixture"));
            await Render(feedback,"feedback",600,520);feedback.Close();
            var about=Dialogs.Window("关于教师端",740);about.Height=660;about.SizeToContent=SizeToContent.Manual;
            about.Content=AboutContent.Build("教师端",DesktopUpdates.CurrentVersion,()=>about.Close(),()=>{},_=>Task.FromResult("隔离诊断"),(_,_)=>Task.FromResult(""));
            await Render(about,"about",740,660);about.Close();
        }
        catch(Exception error){failures.Add(error.ToString());}
        finally
        {
            release.TrySetResult();lifetime.Cancel();listener.Close();foreach(var window in windows)if(window.IsVisible)window.Close();
            File.WriteAllText(Path.Combine(TeacherUiChecks.Output,"checks.json"),JsonSerializer.Serialize(new{checks,failures},new JsonSerializerOptions{WriteIndented=true}));
            foreach(var failure in failures)Console.WriteLine("FAIL "+failure);
            Console.WriteLine($"{checks.Count} native teacher UI checks passed; {failures.Count} failed.");
            Environment.ExitCode=failures.Count==0?0:1;((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

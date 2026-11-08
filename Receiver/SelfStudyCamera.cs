using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace ICeClass.Receiver;

/// <summary>A single, server-claimed photograph. No preview; OS camera indicators remain intact.</summary>
internal static class SelfStudyCamera
{
    private const string Origin = "https://selfstudy.iceclass.local/capture";
    internal static async Task<string> CaptureAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var parent = CreateWindowEx(0, "STATIC", "", 0x80000000, 0, 0, 1, 1,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (parent == IntPtr.Zero) throw new InvalidOperationException("无法初始化教室摄像头。");
        CoreWebView2Controller? controller = null;
        var result = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ICeClass", "SelfStudyCamera");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            token.ThrowIfCancellationRequested();
            controller = await environment.CreateCoreWebView2ControllerAsync(parent);
            token.ThrowIfCancellationRequested();
            controller.Bounds = new System.Drawing.Rectangle(0, 0, 1, 1);
            var core = controller.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.NavigationStarting += (_, e) => { if (e.Uri != Origin || token.IsCancellationRequested) e.Cancel = true; };
            core.PermissionRequested += (_, e) =>
            {
                e.SavesInProfile = false;
                e.State = !token.IsCancellationRequested && e.Uri.StartsWith(Origin, StringComparison.Ordinal) &&
                    e.PermissionKind == CoreWebView2PermissionKind.Camera
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                e.Response = environment.CreateWebResourceResponse(
                    new MemoryStream(Encoding.UTF8.GetBytes(e.Request.Uri == Origin ? Html : "")),
                    e.Request.Uri == Origin ? 200 : 403, "OK",
                    "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; media-src blob:; connect-src 'none'");
            };
            core.WebMessageReceived += (_, e) =>
            {
                if (e.Source != Origin || token.IsCancellationRequested) return;
                try
                {
                    using var json = JsonDocument.Parse(e.WebMessageAsJson);
                    var root = json.RootElement;
                    if (!root.GetProperty("ok").GetBoolean()) throw new InvalidOperationException("教室摄像头不可用。");
                    var image = root.GetProperty("image").GetString() ?? "";
                    if (image.Length == 0 || image.Length > 426668) throw new InvalidDataException();
                    result.TrySetResult(image);
                }
                catch { result.TrySetException(new InvalidOperationException("本次拍摄未完成。")); }
            };
            core.Navigate(Origin);
            return await result.Task.WaitAsync(TimeSpan.FromSeconds(18), token);
        }
        finally
        {
            // Closing the isolated controller also releases a getUserMedia request still awaiting a driver.
            controller?.Close();
            DestroyWindow(parent);
        }
    }
    private const string Html = """
        <!doctype html><meta charset="utf-8"><script>
        (async()=>{
          let stream;
          try {
            stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:1280},height:{ideal:720}}});
            const video=document.createElement('video');video.muted=true;video.srcObject=stream;
            await video.play();
            await new Promise((resolve,reject)=>{
              const timer=setTimeout(()=>reject(new Error('frame')),5000);
              const ready=()=>{clearTimeout(timer);resolve()};
              if(video.readyState>=2)ready();else video.addEventListener('loadeddata',ready,{once:true});
            });
            if(!video.videoWidth||!video.videoHeight)throw new Error('frame');
            const canvas=document.createElement('canvas');
            const scale=Math.min(1,1280/video.videoWidth,720/video.videoHeight);
            canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
            canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
            let image=canvas.toDataURL('image/jpeg',.65).split(',')[1];
            if(image.length>426668)image=canvas.toDataURL('image/jpeg',.4).split(',')[1];
            if(image.length>426668)throw new Error('size');
            window.chrome.webview.postMessage({ok:true,image});
          } catch {window.chrome.webview.postMessage({ok:false})}
          finally {if(stream)stream.getTracks().forEach(track=>track.stop())}
        })();
        </script>
        """;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(int exStyle, string className, string name, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
}

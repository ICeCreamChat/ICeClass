using System.IO.Pipes;
using ICeClass.VideoBooth;
using ICeClass.VideoBooth.Transport;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class CameraPermissionChecks
{
    internal static async Task Run(Form owner)
    {
        var previousArguments = Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        // Fake only the hardware. Do not use fake-ui: the real permission event must run.
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--use-fake-device-for-media-stream");
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass.VideoBooth.CameraPermission", Guid.NewGuid().ToString("N"));
        Console.WriteLine("Isolated camera permission artifacts: " + directory);
        try
        {
            await CheckWindow(owner, Path.Combine(directory, "preview"), managed: false);
            await CheckWindow(owner, Path.Combine(directory, "managed"), managed: true);
        }
        finally { Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", previousArguments); }
    }

    private static async Task CheckWindow(Form owner, string directory, bool managed)
    {
        var mode = managed ? "managed" : "preview";
        var pipeName = "ICeClass.VideoBooth.CameraChecks." + Guid.NewGuid().ToString("N");
        using var host = new NamedPipeServerStream(pipeName,
            PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var readerLifetime = new CancellationTokenSource();
        IceClassPipeClient? client = null;
        Task? reader = null;
        if (managed)
        {
            var accepting = host.WaitForConnectionAsync();
            var connecting = IceClassPipeClient.Connect(pipeName);
            await accepting.WaitAsync(TimeSpan.FromSeconds(10));
            reader = Task.Run(async () =>
            {
                try { while (await IceClassProtocol.ReadAsync(host, readerLifetime.Token) is not null) { } }
                catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException) { }
            });
            client = await connecting.WaitAsync(TimeSpan.FromSeconds(10));
        }
        try
        {
            await using var server = await Task.Run(() => BoothServer.Start(directory));
            if (managed)
            {
                // Reproduce a previous version persisting Deny in this exact profile/origin.
                using var seed = new WebView2();
                owner.Controls.Add(seed);
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(directory, "browser-profile"));
                await seed.EnsureCoreWebView2Async(environment);
                await seed.CoreWebView2.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Camera,
                    new Uri(server.DesktopUrl).GetLeftPart(UriPartial.Authority), CoreWebView2PermissionState.Deny);
            }
            using var window = new WorkbenchForm(server, client);
            window.Show(owner);
            await window.Initialized.WaitAsync(TimeSpan.FromSeconds(35));
            var core = window.Browser.CoreWebView2;
            Task<string> Script(string code) => core.ExecuteScriptAsync(code);
            var permissions = new List<(string Uri, CoreWebView2PermissionKind Kind, CoreWebView2PermissionState State, bool Saved)>();
            core.PermissionRequested += (_, e) =>
            {
                permissions.Add((e.Uri, e.PermissionKind, e.State, e.SavesInProfile));
                Console.WriteLine($"{mode} permission: origin={e.Uri}; kind={e.PermissionKind}; state={e.State}; saved={e.SavesInProfile}");
            };
            Program.Expect(await Script("!document.getElementById('video').srcObject") == "true" && permissions.Count == 0,
                mode + " opens without starting capture");

            var origin = new Uri(server.DesktopUrl).GetLeftPart(UriPartial.Authority);
            Program.Expect(window.IsCameraPermissionAllowed(origin + "/", CoreWebView2PermissionKind.Camera),
                mode + " permits camera only while the exact trusted desktop is current");
            foreach (var (name, rejected) in new[]
            {
                ("different port", $"https://127.0.0.1:{server.HttpPort}/"),
                ("insecure scheme", $"http://127.0.0.1:{server.HttpsPort}/"),
                ("different host", $"https://localhost:{server.HttpsPort}/"),
                ("credentials", $"https://other@127.0.0.1:{server.HttpsPort}/"),
                ("external host", "https://example.com/"),
                ("file", "file:///c:/windows/win.ini"),
                ("relative URL", "/desktop"),
                ("invalid URL", "")
            })
                Program.Expect(!window.IsCameraPermissionAllowed(rejected, CoreWebView2PermissionKind.Camera), mode + " denies camera for " + name);
            Program.Expect(Enum.GetValues<CoreWebView2PermissionKind>().Where(kind => kind != CoreWebView2PermissionKind.Camera)
                .All(kind => !window.IsCameraPermissionAllowed(origin, kind)), mode + " denies every non-camera permission kind");
            Program.Expect(!window.IsTrustedDesktop(origin + "/") && !window.IsTrustedDesktop(server.DesktopUrl + "&other=1")
                && window.IsTrustedDesktop(server.DesktopUrl + (managed ? "&managed=1" : "")), mode + " navigation still requires the exact desktop path and query");

            await Script("document.getElementById('startCamera').click()");
            await Wait(() => Script("document.getElementById('status').classList.contains('error') || (document.getElementById('video').videoWidth>0 && !document.getElementById('requestReview').disabled)"));
            Console.WriteLine(mode + " camera result: " + await Script("({status:document.getElementById('status').textContent,width:document.getElementById('video').videoWidth,height:document.getElementById('video').videoHeight})"));
            Program.Expect(permissions.Any(item => item.Kind == CoreWebView2PermissionKind.Camera)
                && permissions.Where(item => item.Kind == CoreWebView2PermissionKind.Camera).All(item => item.State == CoreWebView2PermissionState.Allow),
                mode + " native permission handler allows the real camera request from the booth origin");
            Program.Expect(permissions.All(item => !item.Saved), mode + " camera permission decision is not persisted");
            Program.Expect(await Script("document.getElementById('video').srcObject?.getVideoTracks().some(track=>track.readyState==='live') && document.getElementById('video').videoWidth>0 && !document.getElementById('requestReview').disabled") == "true",
                mode + " camera button produces live frames through unmodified getUserMedia");

            await Script("window.__captureTracks=document.getElementById('video').srcObject.getTracks();document.getElementById('stopVideo').click()");
            Program.Expect(await Script("window.__captureTracks.every(track=>track.readyState==='ended') && !document.getElementById('video').srcObject") == "true",
                mode + " stop releases browser capture tracks");
            Program.Expect(!(await core.Profile.GetNonDefaultPermissionSettingsAsync()).Any(setting => setting.PermissionKind == CoreWebView2PermissionKind.Camera
                && new Uri(setting.PermissionOrigin).GetLeftPart(UriPartial.Authority) == origin), mode + " leaves no saved camera denial or grant for this origin");

            await Script("window.__microphoneResult='pending';navigator.mediaDevices.getUserMedia({audio:true,video:false}).then(stream=>{stream.getTracks().forEach(track=>track.stop());window.__microphoneResult='allowed'},error=>{window.__microphoneResult=error.name})");
            await Wait(() => Script("window.__microphoneResult!=='pending'"));
            Program.Expect(await Script("window.__microphoneResult==='NotAllowedError'") == "true",
                mode + " real microphone request remains blocked by the page's permissions policy");
            window.Close();
            Program.Expect(!window.IsCameraPermissionAllowed(origin, CoreWebView2PermissionKind.Camera), mode + " closing window refuses camera permission");
            await Wait(() => Task.FromResult(window.IsDisposed ? "true" : "false"));
        }
        finally
        {
            readerLifetime.Cancel();
            client?.Dispose();
            host.Dispose();
            if (reader is not null) await reader.WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    private static async Task Wait(Func<Task<string>> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (await condition() != "true")
        {
            if (DateTime.UtcNow >= deadline) throw new TimeoutException("Camera check did not reach the expected state.");
            await Task.Delay(60);
        }
    }
}

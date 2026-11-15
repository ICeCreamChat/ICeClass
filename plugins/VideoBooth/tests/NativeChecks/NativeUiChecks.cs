using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading.Channels;
using ICeClass.VideoBooth;
using ICeClass.VideoBooth.Transport;

internal static class NativeUiChecks
{
    private static readonly string Root = FindPluginRoot();
    private static readonly string DirectoryRoot = Path.Combine(Root, "..", "..", ".tools", "video-booth-workbench", "native-checks", DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..6]);

    internal static async Task Run(Form owner)
    {
        Directory.CreateDirectory(DirectoryRoot);
        await EarlyProcess("exit");
        await EarlyProcess("disconnect");
        await EarlyProcess("ready-exit");
        await ManagedWindow(owner);
        Console.WriteLine("Isolated native UI artifacts: " + Path.GetFullPath(DirectoryRoot));
    }

    private static async Task EarlyProcess(string mode)
    {
        var pipeName = "ICeClass.VideoBooth.Early." + Guid.NewGuid().ToString("N");
        using var host = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var accepting = host.WaitForConnectionAsync();
        var executable = Path.Combine(AppContext.BaseDirectory, "ICeClass.VideoBooth.exe");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root };
        start.ArgumentList.Add("--data"); start.ArgumentList.Add(Path.Combine(DirectoryRoot, "early-" + mode));
        start.ArgumentList.Add("--iceclass-pipe"); start.ArgumentList.Add(pipeName);
        start.Environment["DOTNET_ROOT"] = Path.GetDirectoryName(Environment.ProcessPath)!;
        // NativeChecks is launched via dotnet run; the explicit runtime root avoids depending on global .NET 10 installation.
        if (!File.Exists(Path.Combine(start.Environment["DOTNET_ROOT"]!, "dotnet.exe")))
            start.Environment["DOTNET_ROOT"] = Path.GetDirectoryName(GetCurrentRuntimeHost());
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start new native executable.");
        try
        {
            await accepting.WaitAsync(TimeSpan.FromSeconds(12));
            var hello = await IceClassProtocol.ReadAsync(host, default).WaitAsync(TimeSpan.FromSeconds(12));
            Program.Expect(hello?.GetProperty("type").GetString() == "hello" && hello.Value.GetProperty("payload").GetProperty("processId").GetInt32() == process.Id, "real new executable sends early verified hello: " + mode);
            if (mode == "ready-exit")
            {
                var gotReady = false;
                using var readyDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(35));
                while (await IceClassProtocol.ReadAsync(host, readyDeadline.Token) is { } message)
                    if (message.GetProperty("type").GetString() == "ready") { gotReady = true; break; }
                Program.Expect(gotReady, "real new executable loads complete new page and reports managed ready");
            }
            if (mode is "exit" or "ready-exit")
            {
                var id = Guid.NewGuid().ToString("N");
                await host.WriteAsync(IceClassProtocol.Encode("exit", new { }, id)); await host.FlushAsync();
                var gotAck = false;
                while (await IceClassProtocol.ReadAsync(host, default).WaitAsync(TimeSpan.FromSeconds(10)) is { } message)
                {
                    if (mode == "exit") Program.Expect(message.GetProperty("type").GetString() != "ready", "early exit never reports page ready");
                    if (message.GetProperty("requestId").GetString() == id) { gotAck = message.GetProperty("type").GetString() == "ack"; break; }
                }
                Program.Expect(gotAck, mode == "exit" ? "exit before browser creation acknowledges exact request ID" : "real new executable acknowledges managed exit after page ready");
            }
            else host.Dispose();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Program.Expect(process.ExitCode == 0, "early " + mode + " releases startup and exits within host deadline");
        }
        finally
        {
            // A failed assertion must not leave this test-owned process alive.
            if (!process.HasExited) { host.Dispose(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
        }
    }

    private static string GetCurrentRuntimeHost()
    {
        var runtime = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        return Path.GetFullPath(Path.Combine(runtime, "..", "..", "..", "dotnet.exe"));
    }

    private static async Task ManagedWindow(Form owner)
    {
        var pipeName = "ICeClass.VideoBooth.NativeChecks." + Guid.NewGuid().ToString("N");
        using var host = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var accepting = host.WaitForConnectionAsync();
        var connecting = IceClassPipeClient.Connect(pipeName);
        await accepting;
        var messages = Channel.CreateUnbounded<JsonElement>();
        _ = Task.Run(async () =>
        {
            try { while (await IceClassProtocol.ReadAsync(host, default) is { } message) await messages.Writer.WriteAsync(message); }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            finally { messages.Writer.TryComplete(); }
        });
        async Task<JsonElement> Next() => await messages.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20));
        using var client = await connecting;
        var hello = await Next();
        Program.Expect(hello.GetProperty("type").GetString() == "hello" && hello.GetProperty("payload").GetProperty("processId").GetInt32() == Environment.ProcessId, "managed hello precedes new window and media server");
        var directory = Path.Combine(DirectoryRoot, "managed-data");
        await using var server = await Task.Run(() => BoothServer.Start(directory));
        using var window = new WorkbenchForm(server, client);
        window.Show(owner);
        await window.Initialized.WaitAsync(TimeSpan.FromSeconds(35));
        async Task<string> Script(string code) => await window.Browser.CoreWebView2.ExecuteScriptAsync(code);
        var ready = await Next();
        Program.Expect(ready.GetProperty("type").GetString() == "ready" && await Script("window.booth.ready && new URLSearchParams(location.search).get('managed')==='1'") == "true", "ready follows actual new CSS/modules/API and synchronous booth contract");
        Program.Expect(await Script("document.title === '视频展台' && document.querySelectorAll('video').length === 1 && !document.getElementById('video').srcObject") == "true", "new branded page loads with one idle video and no startup camera");
        Program.Expect(!Directory.Exists(Path.Combine(directory, "managed-preparation")) && !File.Exists(Path.Combine(directory, "hotspot.json")), "ordinary open creates neither phone identity nor hotspot");
        Program.Expect(!window.IsTrustedDesktop(server.DesktopUrl) && !window.IsTrustedDesktop("file:///c:/windows/win.ini") && !window.IsTrustedDesktop(server.DesktopUrl + "&managed=1&other=1"), "trusted desktop requires exact managed URL and rejects files/modified query");
        long generation = 0;
        async Task<JsonElement> Event(string type)
        {
            for (var n = 0; n < 50; n++)
            {
                var item = await Next();
                if (item.GetProperty("payload").TryGetProperty("generation", out var next)) generation = next.GetInt64();
                if (item.GetProperty("type").GetString() == type) return item;
            }
            throw new InvalidOperationException("Missing event " + type);
        }
        async Task<JsonElement> Command(string type, object? value = null, string? requestId = null)
        {
            var id = requestId ?? Guid.NewGuid().ToString("N");
            var payload = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(value ?? new { }))!;
            if (type is "freeze_frame" or "review_state" or "resume" && !payload.ContainsKey("generation")) payload["generation"] = JsonSerializer.SerializeToElement(generation);
            await host.WriteAsync(IceClassProtocol.Encode(type, payload, id)); await host.FlushAsync();
            for (var n = 0; n < 50; n++)
            {
                var item = await Next();
                if (item.GetProperty("payload").TryGetProperty("generation", out var next)) generation = next.GetInt64();
                if (item.GetProperty("requestId").GetString() == id) return item;
            }
            throw new InvalidOperationException("No command reply " + type);
        }
        static bool Is(JsonElement message, string type) => message.GetProperty("type").GetString() == type;
        Program.Expect(Is(await Command("freeze_frame"), "error"), "idle native freeze rejects missing live frame");
        Program.Expect(Is(await Command("arbitrary_command"), "error"), "unknown native command rejected");
        var duplicate = Guid.NewGuid().ToString("N");
        Program.Expect(Is(await Command("activate", requestId: duplicate), "ack") && Is(await Command("activate", requestId: duplicate), "error"), "native command ID preserved and duplicates rejected");
        await Script("""
            (()=>{
              const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
              const context=canvas.getContext('2d');let count=0;
              function draw(){context.fillStyle='#ee2020';context.fillRect(0,0,160,180);context.fillStyle='#2020ee';context.fillRect(160,0,160,180);context.fillStyle='white';context.font='15px sans-serif';context.fillText('SYNTHETIC VIDEO',25,32);context.fillRect(20+(count++%80),50,5,5);}
              draw();const stream=canvas.captureStream(24);const timer=setInterval(draw,40);
              const track=stream.getVideoTracks()[0];const stop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);stop();};
              window.__synthetic=stream;navigator.mediaDevices.getUserMedia=async()=>stream;
              document.getElementById('startCamera').click();
            })()
            """);
        await Wait(async () => await Script("document.getElementById('video').videoWidth===320 && !document.getElementById('requestReview').disabled") == "true");
        await Script("document.getElementById('requestReview').click()");
        await Event("review_requested");
        var frame = await Command("freeze_frame");
        Program.Expect(Is(frame,"frame"), "real synchronous WebView2 freeze returns frame instead of Promise empty object");
        var payload = frame.GetProperty("payload"); var firstGeneration = payload.GetProperty("generation").GetInt64();
        Program.Expect(payload.GetProperty("width").GetInt64() == 320 && payload.GetProperty("height").GetInt64() == 180
            && payload.GetProperty("capturedAt").GetInt64() > 0 && firstGeneration == generation
            && payload.GetProperty("rotation").GetInt64() == 0 && !payload.GetProperty("mirrored").GetBoolean(), "frame fields and normalized integer timestamps/generation traverse native pipe");
        using (var bytes = new MemoryStream(Convert.FromBase64String(payload.GetProperty("dataUrl").GetString()!.Split(',')[1])))
        using (var image = new Bitmap(bytes))
            Program.Expect(image.GetPixel(120,100).R > 200 && image.GetPixel(240,100).B > 200, "exported PNG contains actual synthetic video pixels");
        Program.Expect(JsonSerializer.Deserialize<string>(await Script("document.getElementById('frozenFrame').src")) == payload.GetProperty("dataUrl").GetString(), "displayed fixed image exactly matches pipe PNG");
        Program.Expect(Is(await Command("review_state", new { state="complete", verdict="incorrect", strength="步骤清晰。", nextStep="请检查定义域。", knowledgePoints=new[]{"定义域"} }), "ack")
            && JsonSerializer.Deserialize<string>(await Script("document.getElementById('reviewTitle').textContent")) == "有需修正的地方", "native review result updates actual page");
        var normal = window.Bounds;
        await Script("document.getElementById('floatWindow').click()");
        await Wait(() => Task.FromResult(window.IsFloating));
        var dpiScale = window.DeviceDpi / 96d;
        Program.Expect(window.TopMost && window.ClientSize.Width == (int)Math.Round(580*dpiScale) && window.MinimumSize == new Size((int)Math.Round(360*dpiScale),(int)Math.Round(280*dpiScale)), "page window message creates actual topmost float with DPI-aware minimum client area");
        window.ClientSize = window.MinimumSize;
        await Task.Delay(200);
        Console.WriteLine("DPI/layout: " + window.DeviceDpi + ", " + window.ClientSize + ", " + await Script("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"));
        Program.Expect(await Script("['restoreWindow','resumeReview','stopVideo'].every(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return !e.hidden && r.width>0 && r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1})") == "true", "360x280 native WebView keeps restore/resume/stop visible");
        await Script("document.getElementById('restoreWindow').click()");
        await Wait(async () => !window.IsFloating && await Script("!document.body.classList.contains('floating')") == "true");
        Console.WriteLine("Restore bounds: before=" + normal + ", after=" + window.Bounds + ", minimum=" + window.MinimumSize);
        Program.Expect(!window.TopMost && window.Bounds == normal && await Script("!document.body.classList.contains('floating')") == "true", "native restore returns prior workbench bounds and DOM state");
        await Script("document.getElementById('resumeReview').click()"); await Event("resume_requested");
        Program.Expect(Is(await Command("resume"),"ack"), "native host resume after teacher resume is idempotent");
        await Script("document.getElementById('requestReview').click()"); await Event("review_requested");
        Program.Expect(Is(await Command("freeze_frame",new { generation=firstGeneration }),"error")
            && Is(await Command("review_state",new { generation=firstGeneration,state="complete",verdict="correct",strength="旧结论",knowledgePoints=new[]{"定义域"} }),"error")
            && Is(await Command("resume",new { generation=firstGeneration }),"error"), "native commands reject old generation freeze/result/resume against actual page");
        Program.Expect(Is(await Command("freeze_frame"),"frame"), "current generation still freezes after stale commands rejected");
        await Script("window.__realFreeze=window.booth.freezeFrame;window.booth.freezeFrame=async()=>({});");
        Program.Expect(Is(await Command("freeze_frame"),"error"), "native bridge explicitly rejects Promise methods");
        await Script("window.booth.freezeFrame=window.__realFreeze;");
        Program.Expect(Is(await Command("stop"),"ack") && await Script("window.__synthetic.getTracks().every(track=>track.readyState==='ended') && !document.getElementById('video').srcObject") == "true", "native stop releases synthetic tracks before ack");
        Program.Expect(Is(await Command("exit"),"ack"), "managed exit acknowledges exact request after page stop");
        await Wait(() => Task.FromResult(window.IsDisposed));
        Program.Expect(window.IsDisposed, "managed exit disposes actual window");
        await DisconnectedWindow(owner);
    }

    private static async Task DisconnectedWindow(Form owner)
    {
        var pipeName = "ICeClass.VideoBooth.Disconnect." + Guid.NewGuid().ToString("N");
        using var host = new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        var accepting=host.WaitForConnectionAsync(); var connecting=IceClassPipeClient.Connect(pipeName); await accepting;
        _ = Task.Run(async () => { try { while (await IceClassProtocol.ReadAsync(host, default) is not null) { } } catch (Exception error) when (error is IOException or ObjectDisposedException) { } });
        using var client=await connecting;
        await using var server=await Task.Run(()=>BoothServer.Start(Path.Combine(DirectoryRoot,"disconnect-data")));
        using var window=new WorkbenchForm(server,client);window.Show(owner);await window.Initialized.WaitAsync(TimeSpan.FromSeconds(35));
        host.Dispose();
        await Wait(()=>Task.FromResult(window.IsDisposed));
        Program.Expect(window.IsDisposed,"ready window exits and releases browser when managed pipe disconnects");
    }

    private static async Task Wait(Func<Task<bool>> condition)
    {
        var deadline=DateTime.UtcNow.AddSeconds(15);
        while(!await condition()) { if(DateTime.UtcNow>=deadline) throw new TimeoutException("Native page did not reach expected state."); await Task.Delay(80); }
    }
    private static string FindPluginRoot()
    {
        for(var directory=new DirectoryInfo(AppContext.BaseDirectory);directory is not null;directory=directory.Parent)
            if(File.Exists(Path.Combine(directory.FullName,"ICeClass.VideoBooth.csproj"))) return directory.FullName;
        throw new DirectoryNotFoundException("Plugin project root not found.");
    }
}

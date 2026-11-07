using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;
using Microsoft.Web.WebView2.Core;

internal static class IdeasBrowserChecks
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly JsonSerializerOptions JsonOptions = new()
        { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private sealed record Result(string Name, bool Passed, object? Details = null);
    private static T Field<T>(object target, string name) =>
        (T)(target.GetType().GetField(name, Private)?.GetValue(target)
            ?? throw new InvalidOperationException($"Missing native field: {name}"));
    private static string Js(string value) => JsonSerializer.Serialize(value);

    internal static void Run(string bindingPath, string output)
    {
        output = Path.GetFullPath(output);
        Directory.CreateDirectory(output);
        try
        {
            if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding)
                || string.IsNullOrWhiteSpace(binding.ClassId))
                throw new InvalidOperationException("Ideas browser checks require an explicit loopback preview binding.");
            Exception? startupError = null;
            var thread = new Thread(() =>
            {
                try
                {
                    AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
                        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(binding, output)))
                        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);
                }
                catch (Exception error) { startupError = error; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start(); thread.Join();
            if (startupError is not null) throw startupError;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("FAIL native ideas startup: " + error.Message);
            Environment.ExitCode = 1;
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(new
                { completed = false, error = error.Message, checks = Array.Empty<Result>() }, JsonOptions));
        }
    }

    private static async Task Until(Func<Task<bool>> condition, string reason, int seconds = 35)
    {
        var clock = Stopwatch.StartNew();
        var nextProgress = 5;
        while (!await condition())
        {
            if (clock.Elapsed.TotalSeconds > seconds) throw new TimeoutException(reason);
            if (clock.Elapsed.TotalSeconds >= nextProgress)
            {
                Console.WriteLine($"WAIT {reason} ({nextProgress}s)"); nextProgress += 5;
            }
            await Task.Delay(120);
        }
    }

    private static Task<bool> Is(ReadingBrowser browser, string expression) =>
        browser.Core is { } core ? Evaluate(core, expression) : Task.FromResult(false);

    private static async Task<bool> Evaluate(CoreWebView2 core, string expression) =>
        await core.ExecuteScriptAsync(expression) == "true";

    private static async Task<JsonElement> Read(HttpClient http, string path)
    {
        using var response = await http.GetAsync(path);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"GET {path} returned {(int)response.StatusCode}.");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task PageReady(CreativeIdeasWindow window, ReadingBrowser browser, ReceiverConfig binding)
    {
        await Until(() => Is(browser, "!!window.ICeClassIdeas && !!document.getElementById('ideaText')"
            + " && !document.getElementById('draftFields').disabled"
            + " && document.getElementById('classContext').textContent === " + Js(binding.ClassName)),
            "student page obtains its bound class and restores its draft");
        if (Field<Border>(window, "_notice").IsVisible)
            throw new InvalidOperationException("The native connection notice still covers the ideas page.");
    }

    private static async Task Fill(ReadingBrowser browser, string text, string name)
    {
        await browser.Core!.ExecuteScriptAsync("(() => {"
            + "const text = document.getElementById('ideaText');"
            + "text.value = " + Js(text) + "; text.dispatchEvent(new Event('input', {bubbles:true}));"
            + "return true; })()");
        if (string.IsNullOrEmpty(text) && string.IsNullOrEmpty(name)) return;
        await browser.Core.ExecuteScriptAsync("document.getElementById('submitIdea').click(); true");
        await Until(() => Is(browser, "!document.getElementById('reviewFields').hidden"
            + " && !document.getElementById('reviewFields').disabled"), "the draft reaches the signature step without submitting");
        await browser.Core.ExecuteScriptAsync("(() => {"
            + "const choice = document.getElementById(" + Js(string.IsNullOrEmpty(name) ? "signAnonymous" : "signNamed") + ");"
            + "choice.checked = true; choice.dispatchEvent(new Event('change', {bubbles:true}));"
            + "const name = document.getElementById('ideaName'); name.value = " + Js(name) + ";"
            + "name.dispatchEvent(new Event('input', {bubbles:true}));"
            + "document.getElementById('cancelSubmit').click(); return true; })()");
    }

    private static async Task PhotoFixture(ReadingBrowser browser)
    {
        await browser.Core!.ExecuteScriptAsync("""
            (() => {
              const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
              const paint = canvas.getContext('2d'); paint.fillStyle = '#eff7ff'; paint.fillRect(0, 0, 320, 180);
              paint.fillStyle = '#254b78'; paint.font = '20px Microsoft YaHei UI'; paint.fillText('演示创意照片', 30, 92);
              const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), value => value.charCodeAt(0));
              const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'fictional-idea.png', {type:'image/png'}));
              const input = document.getElementById('imageInput'); input.files = transfer.files;
              input.dispatchEvent(new Event('change', {bubbles:true})); return true;
            })()
            """);
        await Until(() => Is(browser, "(() => { const button = document.querySelector('.ideas-paper-dialog[open] .ideas-paper-footer .ideas-paper-primary');"
            + "return !!button && !button.disabled && !button.hidden; })()"), "the paper fixture is ready for cropping");
        await browser.Core.ExecuteScriptAsync("document.querySelector('.ideas-paper-dialog[open] .ideas-paper-footer .ideas-paper-primary').click()");
        await Until(() => Is(browser, "(() => { const button = document.querySelector('.ideas-paper-dialog[open] .ideas-paper-footer .ideas-paper-primary:not([hidden])');"
            + "return !!button && button.textContent === '使用纸条' && !button.disabled; })()"), "the final paper fixture preview is decoded");
        await browser.Core.ExecuteScriptAsync("document.querySelector('.ideas-paper-dialog[open] .ideas-paper-footer .ideas-paper-primary:not([hidden])').click()");
        await Until(() => Is(browser, "(() => { const image = document.querySelector('#imageAttachments img');"
            + "return !!image && image.complete && image.naturalWidth > 0 && !document.getElementById('recordVoice').disabled; })()"),
            "the real image input processes the fictional photo fixture");
    }

    private static async Task StartAudioFixture(ReadingBrowser browser, int durationMs = 1000)
    {
        // Only the media source is simulated. The page still runs its recorder handlers,
        // WAV decoding/conversion, IndexedDB persistence and actual multipart upload.
        await browser.Core!.ExecuteScriptAsync($$"""
            (() => {
              const bytes = {{durationMs}} * 16 * 2;
              const buffer = new ArrayBuffer(44 + bytes), view = new DataView(buffer);
              const ascii = (offset, text) => [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
              ascii(0,'RIFF'); view.setUint32(4,36 + bytes,true); ascii(8,'WAVE'); ascii(12,'fmt ');
              view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
              view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true);
              view.setUint16(34,16,true); ascii(36,'data'); view.setUint32(40,bytes,true);
              const wav = new Blob([buffer], {type:'audio/wav'});
              window.__ideasFixtureRequests = 0;
              navigator.mediaDevices.getUserMedia = async constraints => {
                if (!constraints.audio || constraints.video) throw new Error('Only fictional audio is allowed in this check.');
                window.__ideasFixtureRequests += 1; return new MediaStream();
              };
              window.MediaRecorder = class extends EventTarget {
                static isTypeSupported() { return false; }
                constructor() { super(); this.mimeType = 'audio/wav'; this.state = 'inactive'; }
                start() { this.state = 'recording'; }
                stop() {
                  if (this.state === 'inactive') return;
                  this.state = 'inactive';
                  setTimeout(() => {
                    this.dispatchEvent(new BlobEvent('dataavailable', {data:wav}));
                    this.dispatchEvent(new Event('stop'));
                  }, 175);
                }
              };
              document.getElementById('recordVoice').click(); return true;
            })()
            """);
        await Until(() => Is(browser, "window.__ideasFixtureRequests === 1 && !document.getElementById('voicePanel').hidden"
            + " && !document.getElementById('recordVoice').disabled"
            + " && document.getElementById('recordVoiceLabel').textContent === '结束录音'"), "the page starts recording from the silent WAV fixture");
    }

    private static Task RestoredDraft(ReadingBrowser browser, string text, string name, int audioDurationMs) =>
        Until(() => Is(browser, "(() => { const image = document.querySelector('#imageAttachments img');"
            + "const audio = document.querySelector('#audioAttachment audio');"
            + "return document.getElementById('ideaText').value === " + Js(text)
            + " && document.getElementById('ideaName').value === " + Js(name)
            + " && document.querySelectorAll('#imageAttachments img').length === 1 && !!image && image.complete && image.naturalWidth > 0"
            + " && !!audio && audio.readyState >= 1 && Math.abs(audio.duration * 1000 - " + audioDurationMs + ") < 1; })()"),
            "reopening restores the last text edit, decoded photo and newly finalized WAV");

    private static async Task CloseAndWait(CreativeIdeasWindow window, ReadingBrowser browser, string reason, bool withoutPrompt = false)
    {
        var leave = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var closedBeforeLeave = false;
        browser.Core!.WebMessageReceived += (_, args) =>
        {
            using var message = JsonDocument.Parse(args.WebMessageAsJson);
            if (message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("type", out var type) && type.GetString() == "ideas-leave")
                leave.TrySetResult(message.RootElement.GetProperty("safe").GetBoolean());
        };
        window.Closed += (_, _) => closedBeforeLeave = !leave.Task.IsCompletedSuccessfully;
        if (withoutPrompt) window.CloseWithoutPrompt(); else window.Close();
        await Until(() => Task.FromResult(Field<bool>(window, "_closed") && !window.IsVisible && browser.Core is null), reason, 12);
        if (!Field<bool>(browser, "_disposed")) throw new InvalidOperationException("The closed browser was not disposed.");
        if (closedBeforeLeave || !leave.Task.IsCompletedSuccessfully || !leave.Task.Result)
            throw new InvalidOperationException("The window closed without a successful asynchronous draft flush.");
    }

    private static async Task BlockedNavigation(CoreWebView2 core, string target)
    {
        var before = core.Source;
        var observed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Starting(object? sender, CoreWebView2NavigationStartingEventArgs args)
        {
            if (args.Uri == target) observed.TrySetResult(args.Cancel);
        }
        core.NavigationStarting += Starting;
        try
        {
            core.Navigate(target);
            if (!await observed.Task.WaitAsync(TimeSpan.FromSeconds(8)) || core.Source != before)
                throw new InvalidOperationException("The native host allowed navigation outside its ideas page.");
        }
        finally { core.NavigationStarting -= Starting; }
    }

    private static async Task Check(ReceiverConfig binding, string output)
    {
        var started = DateTimeOffset.UtcNow;
        var checks = new List<Result>();
        var screenshots = new List<string>();
        var tag = Guid.NewGuid().ToString("N")[..12];
        var privateMarker = "私密验收备注-" + tag;
        var text = $"验收创意 {tag}：希望班伴记录班级绿植的成长。{privateMarker}";
        var name = "演示同学-" + tag;
        var reply = $"已采纳（验收 {tag}）：将安排绿植成长记录。";
        var publicTitle = "班级绿植成长记录 · " + tag;
        var publicText = "计划增加班级植物成长日记，方便同学记录观察与照料。";
        var draftText = "尚未提交的演示草稿-" + tag;
        var draftName = "草稿同学";
        var finalDraftText = "最后一笔未提交草稿-" + tag;
        var finalDraftName = "最后一笔署名";
        var completed = false;
        var permissionRequests = 0;
        var readingRequests = 0;
        string? ideaId = null;
        CreativeIdeasWindow? window = null;
        StudentVoiceWindow? classroom = null;
        ReadingBrowser? browser = null;
        using var http = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
            { BaseAddress = new Uri(binding.Endpoint.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(10) };

        void Step(string label) => Console.WriteLine("RUN " + label);
        void Record(string label, bool passed, object? details = null)
        {
            checks.Add(new Result(label, passed, details));
            Console.WriteLine((passed ? "PASS " : "FAIL ") + label);
            if (!passed) throw new InvalidOperationException(label);
        }
        async Task Capture(string filename)
        {
            if (browser?.Core is not { } core) return;
            await using var image = File.Create(Path.Combine(output, filename));
            await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image)
                .WaitAsync(TimeSpan.FromSeconds(8));
            screenshots.Add(filename);
            Console.WriteLine("ARTIFACT " + filename);
        }
        async Task Bounds(string label, double? targetWidth = null, double? targetHeight = null)
        {
            var settled = 0;
            await Until(async () =>
            {
                var matches = browser is not null && browser.Bounds.Width > 0
                    && (!targetWidth.HasValue || (Math.Abs(window!.Bounds.Width - targetWidth.Value) <= 1
                        && Math.Abs(window.ClientSize.Width - targetWidth.Value) <= 1))
                    && (!targetHeight.HasValue || Math.Abs(window!.Bounds.Height - targetHeight.Value) <= 1)
                    && browser.GetType().GetField("_controller", Private)?.GetValue(browser) is CoreWebView2Controller controller
                    && Math.Abs(controller.Bounds.Width - browser.Bounds.Width * window!.RenderScaling) <= 3
                    && Math.Abs(controller.Bounds.Height - browser.Bounds.Height * window.RenderScaling) <= 3;
                if (matches && targetWidth.HasValue)
                    matches = await Is(browser!, "Math.abs(window.innerWidth - " + (int)targetWidth.Value + ") <= 1");
                settled = matches ? settled + 1 : 0;
                return settled >= 2;
            }, targetWidth.HasValue ? "native bounds, controller and page viewport settle at the requested width"
                : "WebView controller follows stable native layout");
            var screen = window!.Screens.ScreenFromWindow(window) ?? window.Screens.Primary
                ?? throw new InvalidOperationException("No native screen is available.");
            var work = screen.WorkingArea;
            var size = window.FrameSize ?? window.ClientSize;
            var right = window.Position.X + Math.Ceiling(size.Width * window.RenderScaling);
            var bottom = window.Position.Y + Math.Ceiling(size.Height * window.RenderScaling);
            Record(label, window.Position.X >= work.X - 2 && window.Position.Y >= work.Y - 2
                && right <= work.Right + 2 && bottom <= work.Bottom + 2
                && await Is(browser!, "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"),
                new { x = window.Position.X, y = window.Position.Y, width = window.Bounds.Width, height = window.Bounds.Height,
                    targetWidth, targetHeight, client = new { window.ClientSize.Width, window.ClientSize.Height },
                    frame = new { size.Width, size.Height }, browser = new { browser!.Bounds.Width, browser.Bounds.Height },
                    controller = Field<CoreWebView2Controller>(browser, "_controller").Bounds,
                    scale = window.RenderScaling, work = new { work.X, work.Y, work.Width, work.Height } });
        }

        try
        {
            Step("verify fictional preview before login or mutation");
            using (var response = await http.GetAsync("/api/session"))
                Record("server identifies itself as a fictional preview", response.Headers.TryGetValues("X-ICeClass-Preview", out var markers)
                    && markers.Contains("1"));
            Step("login with the preview administrator in a separate HttpClient");
            using (var login = await http.PostAsJsonAsync("/api/auth/login", new { username = "ICe", password = "LocalDemo2026" }))
            {
                login.EnsureSuccessStatusCode();
                var account = await login.Content.ReadFromJsonAsync<JsonElement>();
                Record("preview login has the real superadmin role", account.GetProperty("user").GetProperty("role").GetString() == "superadmin");
                http.DefaultRequestHeaders.Add("Cookie", login.Headers.GetValues("Set-Cookie").First().Split(';')[0]);
                http.DefaultRequestHeaders.Add("X-CSRF-Token", account.GetProperty("user").GetProperty("csrfToken").GetString());
            }
            var summary = await Read(http, "/api/ideas/admin/summary");
            Record("local preview digest is disabled before submitting test data", !summary.GetProperty("digest").GetProperty("enabled").GetBoolean());

            Step("open CreativeIdeasWindow with product resources and the real WebView2 controller");
            classroom = new StudentVoiceWindow(binding, _ => Task.CompletedTask,
                openReading: () => { ++readingRequests; return Task.CompletedTask; });
            classroom.Show();
            window = new CreativeIdeasWindow(binding);
            window.BringForward(classroom);
            await window.LoadAsync();
            browser = Field<ReadingBrowser>(window, "_browser");
            await PageReady(window, browser, binding);
            var core = browser.Core!;
            Record("native window loads /ideas/ for its bound class", new Uri(core.Source).AbsolutePath == "/ideas/");
            core.PermissionRequested += (_, _) => ++permissionRequests;
            var authenticatedPost = false;
            core.WebResourceRequested += (_, args) =>
            {
                if (new Uri(args.Request.Uri).AbsolutePath != "/api/ideas/student" || args.Request.Method != "POST") return;
                authenticatedPost = args.Request.Headers.Contains("Authorization") && args.Request.Headers.Contains("X-ICeClass-Device-Id")
                    && args.Request.Headers.GetHeader("Authorization") == "Bearer " + binding.DeviceToken
                    && args.Request.Headers.GetHeader("X-ICeClass-Device-Id") == binding.DeviceId;
            };
            await Bounds("initial window and native browser fit the screen work area");
            Record("ideas opens as a smaller nonmodal window while the classroom remains visible",
                ReferenceEquals(window.Owner, classroom) && classroom.IsVisible && classroom.IsEnabled
                && window.Bounds.Width < classroom.Bounds.Width && window.Bounds.Height < classroom.Bounds.Height);
            classroom.Activate();
            await Until(() => Task.FromResult(classroom.IsActive), "the classroom can take focus while ideas is open", 8);
            var homeBrowser = Field<ReadingBrowser>(classroom, "_browser");
            await Until(() => Is(homeBrowser, "!!document.querySelector('[data-action=reading]:not(:disabled)')"),
                "the real classroom home has its reading action ready");
            await homeBrowser.Core!.ExecuteScriptAsync("document.querySelector('[data-action=reading]').click(); true");
            await Until(() => Task.FromResult(readingRequests == 1), "the home reading action reaches the native callback");
            Record("classroom actions remain enabled without closing the ideas window",
                readingRequests == 1 && classroom.IsEnabled && window.IsVisible && !Field<bool>(window, "_closed")
                && await Is(homeBrowser, "!document.querySelector('[data-action=reading]').disabled"));
            var ideasPosition = window.Position;
            var classroomPosition = classroom.Position;
            classroom.Position = new PixelPoint(classroomPosition.X + 20, classroomPosition.Y + 12);
            await Task.Delay(150);
            Record("moving the classroom does not move or close the ideas window",
                classroom.Position != classroomPosition && window.Position == ideasPosition && window.IsVisible);
            await core.ExecuteScriptAsync("window.__ideasWindowReuse = 'retained'; true");
            window.BringForward(classroom); window.BringForward(classroom);
            Record("repeated opening reuses the native browser and the current page",
                ReferenceEquals(browser.Core, core) && ReferenceEquals(window.Owner, classroom)
                && await Is(browser, "window.__ideasWindowReuse === 'retained'"));
            var pageData = JsonSerializer.Deserialize<string>(await core.ExecuteScriptAsync(
                "JSON.stringify({url:location.href,html:document.documentElement.outerHTML,local:{...localStorage},session:{...sessionStorage}})")) ?? "";
            Record("the page URL, DOM and browser storage contain no device secret", !pageData.Contains(binding.DeviceToken, StringComparison.Ordinal));

            Step("clear the prior fictional fixture draft through the real page controls for a repeatable run");
            await core.ExecuteScriptAsync("for (let i = 0; i < 3; i++) document.querySelector('#imageAttachments .ideas-button')?.click();"
                + "document.querySelector('#audioAttachment .ideas-button')?.click(); true");
            await Fill(browser, "", "");
            await Until(() => Is(browser, "!document.querySelector('#imageAttachments img, #audioAttachment audio')"),
                "the isolated fixture starts with no prior attachments");
            Step("add fictional photo and silent WAV fixtures through the real attachment handlers");
            await PhotoFixture(browser);
            await StartAudioFixture(browser);
            await core.ExecuteScriptAsync("document.getElementById('recordVoice').click(); true");
            await Until(() => Is(browser, "(() => { const cancel = document.getElementById('cancelTranscription');"
                + "if (!cancel.hidden) cancel.click(); return !document.getElementById('audioAttachment').hidden"
                + " && !!document.querySelector('#audioAttachment audio') && document.getElementById('voicePanel').hidden"
                + " && !document.getElementById('submitIdea').disabled; })()"), "the page retains the silent WAV without waiting for speech recognition");
            Record("photo and WAV fixtures are ready without requesting hardware access", permissionRequests == 0);
            Step("enter a unique student idea and click the real submit button");
            await Fill(browser, text, name);
            await Until(() => Is(browser, "!document.getElementById('submitIdea').disabled"), "student submit button becomes available");
            await core.ExecuteScriptAsync("document.getElementById('submitIdea').click(); true");
            await Until(() => Is(browser, "!document.getElementById('reviewFields').hidden"
                + " && !document.getElementById('confirmSubmit').disabled"), "the student reviews the confirmed draft before sending");
            await core.ExecuteScriptAsync("document.getElementById('confirmSubmit').click(); true");
            await Until(() => Is(browser, "!document.getElementById('panel-class').hidden && document.getElementById('classList').textContent.includes(" + Js(tag) + ")"),
                "submitted idea appears in the student's class list");
            Record("student submit uses native Bearer plus X-ICeClass-Device-Id headers", authenticatedPost);
            Record("successful submit switches to the class progress view", true);

            Step("find the real submitted record with the preview administrator");
            JsonElement item = default;
            var adminPath = "/api/ideas/admin?classId=" + Uri.EscapeDataString(binding.ClassId) + "&pageSize=100";
            await Until(async () =>
            {
                var listing = await Read(http, adminPath);
                foreach (var candidate in listing.GetProperty("items").EnumerateArray())
                    if (candidate.GetProperty("text").GetString() == text)
                    { item = candidate.Clone(); return true; }
                return false;
            }, "the administrator reads the student record from the real API");
            ideaId = item.GetProperty("id").GetString()!;
            Record("the new idea is pending and bound to the expected class",
                item.GetProperty("status").GetString() == "pending" && item.GetProperty("classId").GetString() == binding.ClassId
                && item.GetProperty("name").GetString() == name && !item.GetProperty("published").GetBoolean());
            var media = item.GetProperty("media").EnumerateArray().ToArray();
            Record("student multipart submission persists the photo and one-second PCM WAV",
                media.Length == 2 && media.Count(value => value.GetProperty("kind").GetString() == "image"
                    && value.GetProperty("contentType").GetString() == "image/jpeg" && value.GetProperty("size").GetInt32() > 0) == 1
                && media.Count(value => value.GetProperty("kind").GetString() == "audio"
                    && value.GetProperty("contentType").GetString() == "audio/wav" && value.GetProperty("durationMs").GetInt32() == 1000) == 1);

            Step("adopt the idea and explicitly publish curated copy through the real review API");
            using (var review = await http.PatchAsJsonAsync("/api/ideas/admin/" + Uri.EscapeDataString(ideaId), new
            {
                status = "adopted", reply, published = true, publishedTitle = publicTitle, publishedText = publicText,
                version = item.GetProperty("version").GetInt32()
            }))
            {
                review.EnsureSuccessStatusCode();
                var result = (await review.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("item");
                Record("administrator review saves adopted status, reply and curated publication",
                    result.GetProperty("status").GetString() == "adopted" && result.GetProperty("reply").GetString() == reply
                    && result.GetProperty("published").GetBoolean());
            }
            Step("refresh the student class list and expand its actual reply");
            await core.ExecuteScriptAsync("document.getElementById('refreshClass').click(); true");
            await Until(() => Is(browser, "(() => { const card = [...document.querySelectorAll('#classList article')]"
                + ".find(node => node.textContent.includes(" + Js(tag) + ")); if (!card) return false;"
                + "card.querySelector('details').open = true; return card.innerText.includes(" + Js(reply) + ")"
                + " && !!card.querySelector('[data-status=adopted]'); })()"), "student refresh shows the administrator's reply and adopted status");
            Record("student refresh shows the adopted idea and review reply", true);
            await Until(() => Is(browser, "(() => { const card = [...document.querySelectorAll('#classList article')]"
                + ".find(node => node.textContent.includes(" + Js(tag) + ")); const image = card?.querySelector('img');"
                + "const audio = card?.querySelector('audio'); if (audio) audio.preload = 'metadata';"
                + "return !!image && image.complete && image.naturalWidth > 0 && !!audio && audio.readyState >= 1"
                + " && Math.abs(audio.duration - 1) < 0.02; })()"), "the native host authenticates the private photo and WAV media requests");
            Record("the student can load its class photo and one-second recording", true);
            await Capture("class-reply.png");

            Step("open the school's showcase and inspect its public copy");
            await core.ExecuteScriptAsync("document.getElementById('tab-showcase').click(); true");
            await Until(() => Is(browser, "!document.getElementById('panel-showcase').hidden"
                + " && document.getElementById('showcaseList').innerText.includes(" + Js(publicTitle) + ")"
                + " && document.getElementById('showcaseList').innerText.includes(" + Js(publicText) + ")"),
                "the real student showcase displays the curated public copy");
            Record("showcase displays curated copy without original text, name, reply or attachments", await Is(browser,
                "(() => { const list = document.getElementById('showcaseList'); return !list.textContent.includes(" + Js(privateMarker) + ")"
                + " && !list.textContent.includes(" + Js(name) + ") && !list.textContent.includes(" + Js(reply) + ")"
                + " && !list.querySelector('img,audio,video'); })()"));
            var publicPage = await Read(http, "/api/ideas/showcase?pageSize=100");
            var publicItem = publicPage.GetProperty("items").EnumerateArray().Single(value => value.GetProperty("id").GetString() == ideaId);
            var publicFields = publicItem.EnumerateObject().Select(value => value.Name).Order().ToArray();
            Record("showcase API returns only its six public fields", publicFields.SequenceEqual(
                new[] { "className", "id", "publishedText", "publishedTitle", "status", "updatedAt" }));
            window.Width = window.MinWidth; window.Height = window.MinHeight;
            await Bounds("narrow window keeps the page and controller within its visible bounds", window.Width, window.Height);
            await Capture("showcase-narrow.png");

            Step("exercise native navigation guards without allowing a foreign page");
            await BlockedNavigation(core, new Uri(http.BaseAddress!, "/api/session").AbsoluteUri);
            Record("native navigation blocks same-origin pages outside /ideas/", true);
            await BlockedNavigation(core, "https://example.invalid/ideas/");
            Record("native navigation blocks a different origin", true);

            Step("close immediately after the last draft edit while fixture recording is active");
            await core.ExecuteScriptAsync("document.getElementById('tab-submit').click(); true");
            await PhotoFixture(browser);
            await Fill(browser, draftText, draftName);
            await StartAudioFixture(browser, 750);
            var firstBrowser = browser;
            var firstWindow = window;
            await CloseAndWait(firstWindow, firstBrowser, "normal Close flushes the final draft and recording before _closed");
            Record("normal Close preserves the visible, enabled classroom and releases its owned window",
                classroom.IsVisible && classroom.IsEnabled && !classroom.OwnedWindows.Contains(firstWindow));
            window = new CreativeIdeasWindow(binding); window.BringForward(classroom); await window.LoadAsync();
            browser = Field<ReadingBrowser>(window, "_browser");
            browser.Core!.PermissionRequested += (_, _) => ++permissionRequests;
            await PageReady(window, browser, binding);
            await RestoredDraft(browser, draftText, draftName, 750);
            Record("reopening restores the last edit, photo and recording finalized by normal Close", true, new { audioDurationMs = 750 });

            Step("exercise CloseWithoutPrompt immediately after another final edit and active recording");
            await Fill(browser, finalDraftText, finalDraftName);
            await StartAudioFixture(browser, 1250);
            var secondWindow = window; var secondBrowser = browser;
            await CloseAndWait(secondWindow, secondBrowser, "CloseWithoutPrompt flushes the final draft and recording before _closed", withoutPrompt: true);
            Record("CloseWithoutPrompt releases the controller without replacing the classroom",
                classroom.IsVisible && classroom.IsEnabled && !classroom.OwnedWindows.Contains(secondWindow));
            window = new CreativeIdeasWindow(binding); window.BringForward(classroom); await window.LoadAsync();
            browser = Field<ReadingBrowser>(window, "_browser");
            browser.Core!.PermissionRequested += (_, _) => ++permissionRequests;
            await PageReady(window, browser, binding);
            await RestoredDraft(browser, finalDraftText, finalDraftName, 1250);
            Record("reopening after CloseWithoutPrompt restores the very last edit and attachments", true, new { audioDurationMs = 1250 });
            var afterDraft = await Read(http, adminPath);
            Record("saving and reopening a draft never submits it", !afterDraft.GetProperty("items").EnumerateArray()
                .Any(value => value.GetProperty("text").GetString() is { } saved && (saved == draftText || saved == finalDraftText)));
            await Capture("restored-draft.png");
            Record("camera and microphone permissions were never requested or automatically granted", permissionRequests == 0
                && Field<HashSet<CoreWebView2PermissionKind>>(window, "_allowedDevices").Count == 0);
            classroom.Hide();
            await CloseAndWait(window, browser, "final native controller closes after awaiting draft persistence", withoutPrompt: true);
            Record("closing ideas does not restore a classroom hidden for another activity", !classroom.IsVisible);
            Record("the reopened native controller is released after its final draft flush", true);
            completed = true;
        }
        catch (Exception error)
        {
            checks.Add(new Result("native ideas browser chain", false, new { error = error.Message }));
            Console.Error.WriteLine("FAIL " + error);
            Environment.ExitCode = 1;
            try { await Capture("failure.png"); }
            catch (Exception captureError) { Console.Error.WriteLine("Screenshot unavailable: " + captureError.Message); }
            if (browser?.Core is { } core)
            {
                try
                {
                    var diagnostic = await core.ExecuteScriptAsync("JSON.stringify({url:location.href,title:document.title,"
                        + "classContext:document.getElementById('classContext')?.textContent,"
                        + "connection:document.getElementById('connectionMessage')?.textContent,"
                        + "submitError:document.getElementById('submitError')?.textContent,"
                        + "classNotice:document.getElementById('classListNotice')?.textContent,"
                        + "showcaseNotice:document.getElementById('showcaseListNotice')?.textContent})");
                    File.WriteAllText(Path.Combine(output, "failure-ui.json"), JsonSerializer.Deserialize<string>(diagnostic));
                }
                catch (Exception diagnosticError) { Console.Error.WriteLine("UI diagnostics unavailable: " + diagnosticError.Message); }
            }
        }
        finally
        {
            try
            {
                if (window is not null && !Field<bool>(window, "_closed"))
                {
                    window.CloseWithoutPrompt();
                    await Until(() => Task.FromResult(Field<bool>(window, "_closed") && !window.IsVisible
                        && (browser?.Core is null)), "cleanup awaits the native window and controller closing", 12);
                }
            }
            catch (Exception closeError) { checks.Add(new Result("native cleanup", false, new { error = closeError.Message })); Environment.ExitCode = 1; }
            classroom?.Close();
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(new
            {
                completed = completed && checks.All(value => value.Passed), startedAt = started, finishedAt = DateTimeOffset.UtcNow,
                endpoint = binding.Endpoint, binding.ClassId, binding.ClassName, runId = tag, ideaId,
                permissions = new { requested = permissionRequests, automaticallyAllowed = false }, checks, screenshots
            }, JsonOptions));
            Console.WriteLine("RESULT " + Path.Combine(output, "summary.json"));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode);
        }
    }
}

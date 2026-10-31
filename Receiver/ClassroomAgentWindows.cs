using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Automation;

namespace ICeClass.Receiver;

/// <summary>Window-bound adapters with observed controls and screenshot-relative input.</summary>
internal sealed partial class ClassroomAgentWindows
{
    private sealed record Target(nint Handle, int Pid, long Started, string Path, string Title, DateTime Seen);
    private sealed record ControlTarget(string WindowId, int[] RuntimeId, string Name, int Type, string AutomationId, DateTime Seen);
    private sealed record PresentationSource(Target Editor, string FullName, string ShowTitle);
    private readonly Dictionary<string, Target> _targets = new();
    private readonly Dictionary<string, ControlTarget> _controls = new();
    private readonly Dictionary<nint, PresentationSource> _presentationSources = new();
    private readonly object _gate = new();
    internal void Reset() { lock (_gate) { _targets.Clear(); _controls.Clear(); _presentationSources.Clear(); _frames.Clear(); _visualFocus = null; } }

    internal Task<JsonObject> InspectAsync(IReadOnlyList<AgentApplication> apps, CancellationToken token) => Apartment(() => Inspect(apps, token), token, ApartmentState.MTA);
    private JsonObject Inspect(IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        var windows = new JsonArray();
        // Resolve each approved path and process once in this observation,
        // rather than once per app/window comparison. Actions still re-read
        // their target independently; no process permissions survive the scan.
        var allowed = new Dictionary<string, AgentApplication>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in apps)
        {
            allowed.TryAdd(ClassroomAgentPolicy.ApplicationPath(app.Path), app);
            if (app.RuntimePath is not null) allowed.TryAdd(ClassroomAgentPolicy.ApplicationPath(app.RuntimePath), app);
        }
        var processes = new Dictionary<int, (long Started, string Path)>();
        var foreground = GetForegroundWindow();
        EnumWindows((handle, _) =>
        {
            if (token.IsCancellationRequested || windows.Count >= 24) return false;
            if (!IsWindowVisible(handle)) return true;
            try
            {
                var target = ReadTarget(handle, processes);
                if (!allowed.TryGetValue(target.Path, out var app)) return true;
                Target? owner = null;
                var ownerHandle = GetWindow(handle, 4); // GW_OWNER, not a child-window ancestor.
                if (ownerHandle != 0)
                {
                    var candidate = ReadTarget(ownerHandle, processes);
                    if (candidate.Pid == target.Pid && candidate.Path == target.Path) owner = candidate;
                }
                var untitled = string.IsNullOrWhiteSpace(target.Title);
                // Qt/WPS menus can be foreground top-level HWNDs with no title
                // or Win32 owner. Do not discard the very window handling input;
                // unrelated, inactive untitled helper HWNDs remain excluded.
                if (untitled && (!IsWindowEnabled(handle) || foreground != handle && owner is null)) return true;
                var kind = WindowKind(app.Kind, target.Title);
                // WPS can host presentations and sheets in wps.exe. Preserve
                // the observed process permission, but report the logical app
                // from the same approved installation rather than WPS Writer.
                if (app.Kind.StartsWith("wps-", StringComparison.Ordinal) && kind != app.Kind)
                    app = apps.FirstOrDefault(a => a.Kind == kind && string.Equals(
                        Path.GetDirectoryName(ClassroomAgentPolicy.ApplicationPath(a.Path)),
                        Path.GetDirectoryName(target.Path), StringComparison.OrdinalIgnoreCase)) ?? app;
                var id = WindowIdentity(target);
                lock (_gate) _targets[id] = target;
                windows.Add(new JsonObject { ["id"] = id, ["title"] = untitled ? app.Name + " · 弹出窗口" : target.Title, ["appId"] = app.Id,
                    ["isPopup"] = untitled || owner is not null, ["ownerId"] = owner is null ? null : WindowIdentity(owner),
                    ["application"] = kind switch { "wps-presentation" => "WPS 演示", "wps-sheet" => "WPS 表格", "wps-writer" => "WPS 文字", _ => app.Name[..Math.Min(app.Name.Length, 80)] }, ["kind"] = kind, ["foreground"] = foreground == handle,
                    ["minimized"] = IsIconic(handle), ["maximized"] = IsZoomed(handle),
                    ["presentationMode"] = kind is "powerpoint" or "wps-presentation" ? LooksLikeSlideShow(target) ? "slideshow" : "editor" : null,
                    ["presentationAdapter"] = kind == "powerpoint" ? "COM，失败时仅向所选窗口发送放映快捷键" : kind == "wps-presentation" ? "所选窗口的放映快捷键；页码需核对，开始和退出核验放映窗口" : kind == "seewo" ? "所选窗口的翻页快捷键，效果需回报核对" : null });
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or ArgumentException) { }
            return true;
        }, 0);
        token.ThrowIfCancellationRequested();
        lock (_gate)
        {
            foreach (var id in _targets.Where(p => (DateTime.UtcNow - p.Value.Seen).TotalMinutes > 3).Select(p => p.Key).ToArray()) _targets.Remove(id);
            foreach (var id in _controls.Where(p => (DateTime.UtcNow - p.Value.Seen).TotalMinutes > 2).Select(p => p.Key).ToArray()) _controls.Remove(id);
            foreach (var handle in _presentationSources.Keys.Where(h => !IsWindow(h)).ToArray()) _presentationSources.Remove(handle);
        }
        return new() { ["windows"] = windows, ["verified"] = true };
    }

    internal Task<JsonObject> OperateAsync(string action, JsonElement args, IReadOnlyList<AgentApplication> apps, CancellationToken token) => Apartment(() =>
    {
        if (action is "create_presentation" or "create_document")
        {
            lock (_gate) { _frames.Clear(); _visualFocus = null; }
            var requested = ClassroomAgentService.Text(args, "appId", 100);
            var writer = action == "create_document";
            var application = apps.SingleOrDefault(a => a.Id == requested && (writer
                ? a.Kind is "word" or "wps-writer" : a.Kind is "powerpoint" or "wps-presentation"))
                ?? throw new InvalidOperationException(writer ? "请选择本机允许的 Word 或 WPS 文字。" : "请选择本机允许的 PowerPoint 或 WPS 演示。");
            var previous = Inspect(apps, token)["windows"]!.AsArray().Select(w => w!["id"]!.GetValue<string>()).ToHashSet();
            var created = writer ? ClassroomAgentDocuments.CreateDocument(args, application, token)
                : ClassroomAgentDocuments.CreatePresentation(args, application, token);
            JsonObject observed = Inspect(apps, token);
            if (created["verified"]?.GetValue<bool>() == true)
            {
                var name = created["document"]!.GetValue<string>();
                string? createdTarget = null;
                var visible = WaitFor(() =>
                {
                    observed = Inspect(apps, token);
                    var matches = observed["windows"]!.AsArray().Where(w => w!["appId"]!.GetValue<string>() == application.Id
                        && !previous.Contains(w["id"]!.GetValue<string>())
                        && (w["title"]!.GetValue<string>() == name || w["title"]!.GetValue<string>().StartsWith(name + " - ", StringComparison.Ordinal))).ToArray();
                    createdTarget = matches.Length == 1 ? matches[0]!["id"]!.GetValue<string>() : null;
                    return createdTarget is not null;
                }, token);
                created["verified"] = visible;
                created["targetId"] = createdTarget;
                if (!visible) created["detail"] = "已在文稿接口中创建文稿并读回文字，但尚未看到对应窗口；未自动重建或保存，请查看应用。";
                else
                {
                    var window = ValidateTarget(createdTarget!, apps);
                    try
                    {
                        MaximizeAndFocus(window, token);
                        created["maximized"] = WaitFor(() => IsZoomed(window.Handle) && GetForegroundWindow() == window.Handle, token);
                    }
                    catch (InvalidOperationException)
                    {
                        // Creation already happened. Preserve its receipt so a
                        // foreground refusal cannot cause a duplicate document.
                        created["maximized"] = false;
                    }
                    created["foreground"] = GetForegroundWindow() == window.Handle;
                    if (created["maximized"]!.GetValue<bool>() == false)
                        created["detail"] = "文稿已新建并核对文字，但窗口未能最大化；尚未保存。";
                    observed = Inspect(apps, token);
                }
            }
            created["windows"] = observed["windows"]?.DeepClone();
            return created;
        }
        var id = ClassroomAgentService.Text(args, "targetId", 100);
        var target = ValidateTarget(id, apps);
        token.ThrowIfCancellationRequested();
        var app = apps.First(a => a.MatchesPath(target.Path));
        var kind = WindowKind(app.Kind, target.Title);
        if (action == "capture_window") return CaptureWindow(id, target, apps, token);
        if (VisualActions.Contains(action)) return VisualInput(action, id, target, args, apps, token);
        if (action is not ("inspect_controls" or "wait_for_control" or "read_document")) lock (_gate) { _frames.Clear(); _visualFocus = null; }
        if (action is "read_document" or "replace_document_text") return ClassroomAgentDocuments.Execute(action, args, kind, target.Handle, token);
        if (action == "inspect_controls") return InspectControls(id, target, token, args);
        if (action == "wait_for_control") return WaitForControl(id, target, args, token);
        if (ControlActions.Contains(action)) return Control(action, id, target, args, apps, token);
        if (action is "focus_window" or "minimize_window" or "maximize_window" or "restore_window" or "close_window")
        {
            if (action == "minimize_window") ShowWindow(target.Handle, 6);
            else if (action == "maximize_window") MaximizeAndFocus(target, token);
            else if (action == "restore_window") ShowWindow(target.Handle, 1);
            else if (action == "focus_window") Focus(target);
            else
            {
                // WM_CLOSE lets the application show its own unsaved-work prompt.
                if (!PostMessage(target.Handle, 0x0010, 0, 0)) throw new InvalidOperationException("窗口未接受关闭请求。");
            }
            var verified = WaitFor(() => action switch { "focus_window" => GetForegroundWindow() == target.Handle,
                "minimize_window" => IsIconic(target.Handle), "maximize_window" => IsZoomed(target.Handle) && GetForegroundWindow() == target.Handle,
                "restore_window" => IsWindowVisible(target.Handle) && !IsIconic(target.Handle) && !IsZoomed(target.Handle),
                _ => !IsWindow(target.Handle) || !IsWindowVisible(target.Handle) }, token);
            var result = Inspect(apps, token);
            result["verified"] = verified;
            if (action == "maximize_window")
            {
                result["maximized"] = IsZoomed(target.Handle);
                result["foreground"] = GetForegroundWindow() == target.Handle;
                result["detail"] = verified ? "应用已切到前台并最大化。" : "已打开并切到应用，当前窗口未能最大化。";
                return result;
            }
            result["detail"] = action == "close_window" && !verified ? "已请求关闭；窗口仍存在，请检查是否有未保存提示。" : verified ? "已核对窗口状态。" : "已发送窗口请求，请核对应用状态。";
            return result;
        }
        if (action.StartsWith("presentation_", StringComparison.Ordinal))
        {
            if (kind is not ("powerpoint" or "wps-presentation" or "seewo")) throw new InvalidOperationException("请选择 PowerPoint、WPS 演示或希沃窗口。");
            if (kind != "seewo")
            {
                var showing = FindSlideShow(target, apps, token);
                if (showing is not null)
                {
                    if (action == "presentation_start")
                    {
                        Focus(showing);
                        var current = Inspect(apps, token);
                        current["verified"] = true;
                        current["detail"] = "课件正在放映，已切到放映窗口并保留当前页。";
                        return current;
                    }
                    target = showing;
                }
            }
            // Keep WPS slideshow input outside its COM/VBA runtime: mixing
            // COM probes with F5/Escape can interrupt that runtime rather than
            // end a newly started show. Receipts observe the native window.
            var result = kind == "powerpoint" ? Presentation(action, target, args, kind, token) : null;
            if (result is not null) { result["windows"] = Inspect(apps, token)["windows"]?.DeepClone(); return result; }
            if (kind != "seewo" && !LooksLikeSlideShow(target) && action != "presentation_start")
                target = FindSlideShow(target, apps, token) ?? throw new InvalidOperationException("此课件没有可确认的放映窗口，请先开始放映。");
            if (action == "presentation_goto")
            {
                if (kind == "seewo" || !LooksLikeSlideShow(target)) throw new InvalidOperationException("此版本的所选窗口不支持页码跳转，请先开始放映或使用上一页、下一页。");
                var page = args.GetProperty("page").GetInt32();
                if (page is < 1 or > 10000) throw new InvalidOperationException("页码应在 1 至 10000 之间。");
                Focus(target);
                foreach (var digit in page.ToString(System.Globalization.CultureInfo.InvariantCulture)) Keys(target, [(ushort)digit], token);
                Keys(target, [0x0D], token);
                var navigation = Inspect(apps, token); navigation["verified"] = false;
                navigation["detail"] = $"已向选定放映窗口发送跳转到第 {page} 页的请求；本版本没有可核验的页码接口，请核对课件。";
                return navigation;
            }
            var key = action switch { "presentation_start" => (ushort)0x74, "presentation_next" => (ushort)0x22,
                "presentation_previous" => (ushort)0x21, "presentation_end" => (ushort)0x1B, _ => throw new InvalidOperationException("不支持此放映操作。") };
            if (kind != "seewo" && action is not "presentation_start" && !LooksLikeSlideShow(target))
                throw new InvalidOperationException("当前窗口未确认处于放映状态，请先开始放映并重新查看窗口。");
            Keys(target, [key], token);
            var verified = action == "presentation_end" && kind != "seewo"
                ? WaitFor(() => !IsWindow(target.Handle) || !IsWindowVisible(target.Handle), token)
                : action == "presentation_start" && kind != "seewo"
                    && WaitFor(() => FindSlideShow(target, apps, token) is not null, token);
            var state = Inspect(apps, token);
            state["verified"] = verified;
            state["detail"] = verified ? action == "presentation_end" ? "已退出放映，放映窗口已消失。" : "已开始放映，课件的放映窗口已出现。"
                : "已向选定的演示窗口发送操作，实际效果尚未确认。";
            return state;
        }
        if (action.StartsWith("browser_", StringComparison.Ordinal))
        {
            if (kind != "browser") throw new InvalidOperationException("请选择浏览器窗口。");
            ushort[] keys = action switch
            {
                "browser_back" => [0x12, 0x25], "browser_forward" => [0x12, 0x27], "browser_reload" => [0x11, 0x52],
                "browser_next_tab" => [0x11, 0x09], "browser_previous_tab" => [0x11, 0x10, 0x09], "browser_fullscreen" => [0x7A],
                _ => throw new InvalidOperationException("不支持此浏览器操作。")
            };
            Keys(target, keys, token);
        }
        else if (action == "save_document") Keys(target, [0x11, 0x53], token);
        else throw new InvalidOperationException("此电脑操作尚不支持。");
        var after = Inspect(apps, token);
        after["verified"] = false;
        after["detail"] = action == "save_document" ? "已向选定窗口发送保存请求，请检查应用提示和文件状态。" : "已向选定浏览器发送操作，请核对页面状态。";
        return after;
    }, token, action is "inspect_controls" or "wait_for_control" || ControlActions.Contains(action) ? ApartmentState.MTA : ApartmentState.STA);

    private Target ValidateTarget(string id, IReadOnlyList<AgentApplication> apps)
    {
        Target? old;
        lock (_gate) _targets.TryGetValue(id, out old);
        if (old is null || (DateTime.UtcNow - old.Seen).TotalMinutes > 2) throw new InvalidOperationException("窗口信息已过期，请重新查看教室电脑。");
        var current = ReadTarget(old.Handle);
        if (current.Pid != old.Pid || current.Started != old.Started || current.Path != old.Path || current.Title != old.Title ||
            !apps.Any(a => a.MatchesPath(current.Path)))
            throw new InvalidOperationException("窗口、文档或应用许可已变化，请重新查看并选择。");
        return current;
    }

    private static Target ReadTarget(nint handle, Dictionary<int, (long Started, string Path)>? processes = null)
    {
        if (!IsWindow(handle)) throw new InvalidOperationException("目标窗口已关闭。");
        GetWindowThreadProcessId(handle, out var pid);
        (long Started, string Path) identity;
        if (processes is not null && processes.TryGetValue((int)pid, out var known)) identity = known;
        else
        {
            using var process = Process.GetProcessById((int)pid);
            identity = (process.StartTime.ToUniversalTime().Ticks, ClassroomAgentPolicy.ApplicationPath(
                process.MainModule?.FileName ?? throw new InvalidOperationException("无法核对应用路径。")));
            if (processes is not null) processes[(int)pid] = identity;
        }
        var title = new StringBuilder(240); GetWindowText(handle, title, title.Capacity);
        return new(handle, (int)pid, identity.Started, identity.Path, title.ToString(), DateTime.UtcNow);
    }

    private static string WindowIdentity(Target target) =>
        ClassroomAgentPolicy.Identity($"{target.Pid}|{target.Started}|{target.Handle}|{target.Title}");

    private static bool WaitFor(Func<bool> condition, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        do
        {
            token.ThrowIfCancellationRequested();
            if (condition()) return true;
            if (token.WaitHandle.WaitOne(40)) token.ThrowIfCancellationRequested();
        } while (clock.Elapsed < TimeSpan.FromSeconds(2));
        return condition();
    }

    private static Target? FindSlideShow(Target editor, IReadOnlyList<AgentApplication> apps, CancellationToken token)
    {
        if (LooksLikeSlideShow(editor)) return IsWindowVisible(editor.Handle) ? editor : null;
        var filename = System.Text.RegularExpressions.Regex.Match(editor.Title,
            @"(?:^|[\[\\/])([^\[\]\\/]+\.(?:pptx?|ppsx?|dps|dpt))(?=\]|\s[-—]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!filename.Success) return null;
        var matches = new List<Target>();
        EnumWindows((handle, _) =>
        {
            if (token.IsCancellationRequested) return false;
            if (!IsWindowVisible(handle)) return true;
            Target candidate;
            try
            {
                candidate = ReadTarget(handle);
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception or ArgumentException or InvalidOperationException) { return true; }
            // WPS runs its editor and slideshow in different executables.
            // Match the complete file name and installed package, never just
            // a title fragment or an arbitrary process with a similar name.
            if (!LooksLikeSlideShow(candidate) || !apps.Any(a => a.MatchesPath(candidate.Path))
                || !string.Equals(Path.GetDirectoryName(candidate.Path), Path.GetDirectoryName(editor.Path), StringComparison.OrdinalIgnoreCase)) return true;
            var match = System.Text.RegularExpressions.Regex.Match(candidate.Title,
                @"(?:^|[\[\\/])([^\[\]\\/]+\.(?:pptx?|ppsx?|dps|dpt))(?=\]|\s[-—]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (match.Success && match.Groups[1].Value.Equals(filename.Groups[1].Value, StringComparison.OrdinalIgnoreCase)) matches.Add(candidate);
            return true;
        }, 0);
        token.ThrowIfCancellationRequested();
        if (matches.Count > 1) throw new InvalidOperationException("多个放映窗口对应同名课件，请先选择具体的放映窗口。");
        return matches.SingleOrDefault();
    }

    private static bool LooksLikeSlideShow(Target target)
    {
        var name = new StringBuilder(128); GetClassName(target.Handle, name, name.Capacity);
        return name.ToString().Equals("screenClass", StringComparison.OrdinalIgnoreCase) ||
            target.Title.Contains("幻灯片放映") || target.Title.Contains("Slide Show", StringComparison.OrdinalIgnoreCase) || target.Title.Contains("放映");
    }
    private static string WindowKind(string kind, string title)
    {
        if (!kind.StartsWith("wps-", StringComparison.Ordinal)) return kind;
        if (title.EndsWith("WPS 演示", StringComparison.OrdinalIgnoreCase)) return "wps-presentation";
        if (title.EndsWith("WPS 表格", StringComparison.OrdinalIgnoreCase)) return "wps-sheet";
        if (title.EndsWith("WPS 文字", StringComparison.OrdinalIgnoreCase)) return "wps-writer";
        if (title.Contains("放映") || title.Contains("Slide Show", StringComparison.OrdinalIgnoreCase)) return "wps-presentation";
        // Unsaved WPS documents have no extension and use the generic
        // "WPS Office" suffix, even though they belong to different editors.
        if (System.Text.RegularExpressions.Regex.IsMatch(title, @"^\*?(?:演示文稿|Presentation)\d+\s*[-—]", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return "wps-presentation";
        if (System.Text.RegularExpressions.Regex.IsMatch(title, @"^\*?(?:工作簿|Book)\d+\s*[-—]", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return "wps-sheet";
        // Recent WPS releases host all editors inside wps.exe. Only infer the
        // adapter family from a visible filename; the COM window must still match.
        var matches = System.Text.RegularExpressions.Regex.Matches(title, @"\.(pptx?|ppsx?|dps|dpt|docx?|wps|xlsx?|et)(?=\s|[-—·]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (matches.Count == 0) return kind;
        return matches[^1].Groups[1].Value.ToLowerInvariant() switch
        {
            "ppt" or "pptx" or "pps" or "ppsx" or "dps" or "dpt" => "wps-presentation",
            "xls" or "xlsx" or "et" => "wps-sheet", _ => "wps-writer"
        };
    }

    private JsonObject? Presentation(string action, Target target, JsonElement args, string kind, CancellationToken token)
    {
        object? application = null, presentation = null, show = null;
        var owned = new List<object>();
        var changed = false;
        try
        {
            presentation = ClassroomAgentDocuments.NativeDocument(kind, target.Handle, token, owned);
            PresentationSource? source;
            lock (_gate) _presentationSources.TryGetValue(target.Handle, out source);
            if (presentation is null && source is not null && source.ShowTitle == target.Title)
            {
                var editor = ReadTarget(source.Editor.Handle);
                if (editor.Pid == target.Pid && editor.Started == target.Started && editor.Path == target.Path)
                {
                    var candidate = ClassroomAgentDocuments.NativeDocument(kind, editor.Handle, token, owned);
                    if (candidate is not null && (string)((dynamic)candidate).FullName == source.FullName) presentation = candidate;
                }
            }
            var progId = kind == "powerpoint" ? "PowerPoint.Application" : "Kwpp.Application";
            if (presentation is null)
            {
                if (CLSIDFromProgID(progId, out var clsid) != 0 || GetActiveObject(ref clsid, 0, out application) != 0 || application is null) return null;
                dynamic app = application;
                try
                {
                    object showsObject = app.SlideShowWindows; owned.Add(showsObject); dynamic shows = showsObject;
                    for (var i = 1; i <= (int)shows.Count; i++)
                    {
                        object screenObject = shows.Item(i); owned.Add(screenObject); dynamic screen = screenObject;
                        if (!ClassroomAgentDocuments.WindowMatches(screen, target.Handle)) continue;
                        object documentObject = screen.Presentation; owned.Add(documentObject);
                        presentation = documentObject;
                    }
                }
                catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
                var matchedShow = presentation is not null;
                object presentationsObject = app.Presentations; owned.Add(presentationsObject);
                dynamic presentations = presentationsObject;
                for (var i = 1; !matchedShow && i <= (int)presentations.Count; i++)
                {
                    token.ThrowIfCancellationRequested();
                    object candidateObject = presentations.Item(i); owned.Add(candidateObject); dynamic candidate = candidateObject;
                    var matches = false;
                    object windowsObject = candidate.Windows; owned.Add(windowsObject); dynamic windows = windowsObject;
                    for (var j = 1; j <= (int)windows.Count; j++)
                    {
                        object windowObject = windows.Item(j); owned.Add(windowObject); dynamic window = windowObject;
                        if (ClassroomAgentDocuments.WindowMatches(window, target.Handle, app)) matches = true;
                    }
                    try
                    {
                        object windowObject = candidate.SlideShowWindow;
                        if (windowObject is not null) { owned.Add(windowObject); dynamic window = windowObject; if (ClassroomAgentDocuments.WindowMatches(window, target.Handle)) matches = true; }
                    }
                    catch (COMException) { }
                    if (matches)
                    {
                        if (presentation is not null) throw new InvalidOperationException("多个课件共享此窗口，无法唯一确认，请在应用中只保留要操作的课件。");
                        presentation = candidateObject;
                    }
                }
            }
            // Missing native document binding must never turn into a guessed
            // COM target. Fixed input stays bound to the selected native window.
            if (presentation is null) return null;
            dynamic document = presentation;
            token.ThrowIfCancellationRequested();
            if (action == "presentation_start")
            {
                var before = new HashSet<nint>();
                EnumWindows((handle, _) => { GetWindowThreadProcessId(handle, out var pid); if (pid == target.Pid) before.Add(handle); return true; }, 0);
                object settingsObject = document.SlideShowSettings; owned.Add(settingsObject); dynamic settings = settingsObject;
                changed = true; show = settings.Run(); owned.Add(show);
                var fullName = (string)document.FullName;
                EnumWindows((handle, _) =>
                {
                    if (before.Contains(handle) || !IsWindowVisible(handle)) return true;
                    try
                    {
                        var screen = ReadTarget(handle);
                        if (screen.Pid == target.Pid && screen.Started == target.Started && screen.Path == target.Path && LooksLikeSlideShow(screen))
                            lock (_gate) _presentationSources[handle] = new(target, fullName, screen.Title);
                    }
                    catch (Exception error) when (error is InvalidOperationException or ArgumentException or System.ComponentModel.Win32Exception) { }
                    return true;
                }, 0);
            }
            else { show = document.SlideShowWindow; if (show is null) throw new InvalidOperationException("该文稿尚未开始放映。"); owned.Add(show); }
            dynamic slideshow = show!;
            object viewObject = slideshow.View; owned.Add(viewObject); dynamic view = viewObject;
            object slidesObject = document.Slides; owned.Add(slidesObject); dynamic slides = slidesObject;
            var count = (int)slides.Count;
            if (action == "presentation_next") { changed = true; view.Next(); }
            else if (action == "presentation_previous") { changed = true; view.Previous(); }
            else if (action == "presentation_goto")
            {
                var page = args.GetProperty("page").GetInt32();
                if (page < 1 || page > count) throw new InvalidOperationException($"课件共有 {count} 页，请填写范围内的页码。");
                changed = true; view.GotoSlide(page);
            }
            else if (action == "presentation_end")
            {
                nint handle = LooksLikeSlideShow(target) ? target.Handle : 0;
                if (handle == 0)
                    try { handle = (nint)Convert.ToInt64(slideshow.HWND); }
                    catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
                changed = true; view.Exit();
                var ended = handle != 0 && WaitFor(() => !IsWindow(handle) || !IsWindowVisible(handle), token);
                return new() { ["verified"] = ended, ["detail"] = ended ? "已退出放映，放映窗口已消失。" : "已发送退出放映请求，放映窗口是否结束尚未确认。" };
            }
            token.ThrowIfCancellationRequested();
            var position = (int)view.CurrentShowPosition;
            return new() { ["verified"] = true, ["page"] = position, ["totalPages"] = count, ["detail"] = $"放映接口回报当前第 {position} 页，共 {count} 页。" };
        }
        catch (Exception error) when (!changed && error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { return null; }
        catch (Exception error) when (changed && error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            return new() { ["verified"] = false, ["detail"] = "已向放映接口发送操作，但未能读取最终页码，请重新查看窗口并核对。" };
        }
        finally
        {
            foreach (var item in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(item)) try { Marshal.ReleaseComObject(item); } catch (InvalidComObjectException) { }
            if (application is not null && Marshal.IsComObject(application)) Marshal.ReleaseComObject(application);
        }
    }

    private static void MaximizeAndFocus(Target target, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        ShowWindow(target.Handle, 3);
        Focus(target);
    }

    private static void Focus(Target target)
    {
        if (IsIconic(target.Handle)) ShowWindow(target.Handle, 9);
        SetForegroundWindow(target.Handle);
        if (!ForegroundReady(target))
        {
            // Remote classroom input originates in a background adapter. Join
            // the foreground input queue only while activating this verified
            // window; release the attachment even if Windows refuses it.
            _ = PeekMessage(out _, 0, 0, 0, 0);
            var current = GetCurrentThreadId();
            var foreground = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            var attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
            try { BringWindowToTop(target.Handle); SetForegroundWindow(target.Handle); }
            finally { if (attached) AttachThreadInput(current, foreground, false); }
        }
        if (!ForegroundReady(target)) throw new InvalidOperationException("系统未允许切换到目标窗口，未发送输入。请在教室端激活该窗口后重试。");
    }
    private static bool ForegroundReady(Target target)
    {
        if (GetForegroundWindow() == target.Handle) return true;
        // Cross-thread activation is asynchronous. Flush its pending message
        // before checking, without a fixed sleep or sending any user input.
        // An unresponsive application gets at most 250 ms to acknowledge it.
        SendMessageTimeout(target.Handle, 0, 0, 0, 3, 250, out _);
        return GetForegroundWindow() == target.Handle;
    }
    private static void Keys(Target target, ushort[] keys, CancellationToken token)
    {
        Focus(target);
        var pressed = new List<ushort>();
        try
        {
            foreach (var key in keys)
            {
                token.ThrowIfCancellationRequested();
                if (GetForegroundWindow() != target.Handle) throw new InvalidOperationException("前台窗口已变化，已停止发送输入。");
                SendKey(key, false); pressed.Add(key);
            }
        }
        finally { foreach (var key in pressed.AsEnumerable().Reverse()) SendKey(key, true); }
    }
    private static void SendKey(ushort key, bool up)
    {
        INPUT[] input = [new() { type = 1, data = new() { keyboard = new() { virtualKey = key, flags = up ? 2u : 0u } } }];
        if (SendInput(1, input, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("系统阻止了应用输入，请检查窗口权限。");
    }

    private static Task<JsonObject> Apartment(Func<JsonObject> action, CancellationToken token, ApartmentState apartment)
    {
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = token.Register(() => completion.TrySetCanceled(token));
        var thread = new Thread(() =>
        {
            try { token.ThrowIfCancellationRequested(); completion.TrySetResult(action()); }
            catch (Exception error) { completion.TrySetException(error); }
            finally { registration.Dispose(); }
        }) { IsBackground = true, Name = "ICeClass classroom application adapter" };
        // UI Automation runs on a windowless MTA thread; Office automation uses STA.
        thread.SetApartmentState(apartment); thread.Start();
        return completion.Task;
    }

    private delegate bool EnumWindowsProc(nint hwnd, nint lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, nint value);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsZoomed(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint SendMessageTimeout(nint hwnd, uint message, nint wparam, nint lparam, uint flags, uint timeout, out nuint result);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public nint window; public uint message; public nuint wparam; public nint lparam; public uint time; public int x, y; public uint reserved; }
    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, nint hwnd, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool PostMessage(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)] private static extern int CLSIDFromProgID(string id, out Guid clsid);
    [DllImport("oleaut32.dll", PreserveSig = true)] private static extern int GetActiveObject(ref Guid clsid, nint reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputData data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputData { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort virtualKey, scan; public uint flags, time; public nuint extra; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int x, y; public uint mouseData, flags, time; public nuint extra; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
}

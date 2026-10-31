using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ICeClass.Receiver;

/// <summary>Office adapters preserve formatting and never save implicitly.</summary>
internal static class ClassroomAgentDocuments
{
    internal static JsonObject CreateDocument(JsonElement args, AgentApplication application, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        var timings = new List<string>();
        void Mark(string stage) => timings.Add($"{stage}={clock.ElapsedMilliseconds}ms");
        var text = ClassroomAgentService.Text(args, "text", 2000, false);
        var type = Type.GetTypeFromProgID(application.Kind == "word" ? "Word.Application" : "Kwps.Application")
            ?? throw new InvalidOperationException("此安装版本未提供文字文稿接口，未创建文稿。");
        var owned = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        var changed = false;
        try
        {
            token.ThrowIfCancellationRequested();
            // Creating through an already running, validated application avoids
            // another COM startup. Documents.Add still creates a new document.
            dynamic app = OpenApplication(type, application, owned);
            Mark("activation");
            app.Visible = true;
            Mark("visible");
            dynamic documents = Own(app.Documents);
            var count = (int)documents.Count;
            Mark("collection");
            token.ThrowIfCancellationRequested();
            changed = true;
            // Always write to the document returned by Add, never ActiveDocument:
            // an existing document can remain active while the new one opens.
            dynamic document = Own(documents.Add());
            Mark("add");
            dynamic range = Own(document.Content);
            token.ThrowIfCancellationRequested();
            if (text.Length > 0) range.Text = text;
            Mark("write");
            token.ThrowIfCancellationRequested();
            var actual = ((string)range.Text).Replace("\r\n", "\n").Replace('\r', '\n');
            var expected = text.Replace("\r\n", "\n").Replace('\r', '\n');
            // Word's body range includes its mandatory final paragraph mark.
            if (actual == expected + "\n") actual = expected;
            var saved = !string.IsNullOrEmpty((string)document.Path);
            var verified = (int)documents.Count == count + 1 && actual == expected && !saved;
            Mark("readback");
            return new() { ["verified"] = verified, ["document"] = (string)document.Name,
                ["text"] = actual, ["characterCount"] = new System.Globalization.StringInfo(actual).LengthInTextElements,
                ["saved"] = saved,
                ["detail"] = verified ? "已新建独立文字文稿并核对正文；尚未保存。" : "已创建文字文稿，但最终内容未能核实，请查看应用；未自动重建或保存。" };
        }
        catch (Exception error) when (changed && error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        { return new() { ["verified"] = false, ["detail"] = "新建过程中应用未能返回最终结果，请先查看现有文稿；未自动重建或保存。" }; }
        finally
        {
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            Mark("released");
            AppLog.Info("班班新建文字文稿耗时：" + string.Join(", ", timings));
        }
    }

    internal static JsonObject CreatePresentation(JsonElement args, AgentApplication application, CancellationToken token)
    {
        var text = ClassroomAgentService.Text(args, "text", 2000);
        var type = Type.GetTypeFromProgID(application.Kind == "powerpoint" ? "PowerPoint.Application" : "Kwpp.Application")
            ?? throw new InvalidOperationException("此安装版本未提供演示文稿接口，未创建文稿。");
        var owned = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        var changed = false;
        try
        {
            token.ThrowIfCancellationRequested();
            dynamic app = OpenApplication(type, application, owned);
            app.Visible = -1;
            dynamic documents = Own(app.Presentations);
            token.ThrowIfCancellationRequested();
            changed = true;
            dynamic document = Own(documents.Add(-1));
            dynamic slides = Own(document.Slides);
            dynamic slide = Own(slides.Add(1, 12)); // ppLayoutBlank
            dynamic page = Own(document.PageSetup);
            dynamic shapes = Own(slide.Shapes);
            var width = (float)page.SlideWidth;
            var height = (float)page.SlideHeight;
            dynamic shape = Own(shapes.AddTextbox(1, 48f, Math.Max(48f, (height - 120f) / 2), width - 96f, 120f));
            dynamic frame = Own(shape.TextFrame);
            dynamic range = Own(frame.TextRange);
            token.ThrowIfCancellationRequested();
            range.Text = text;
            dynamic font = Own(range.Font);
            font.Name = "Microsoft YaHei";
            font.Size = 32f;
            token.ThrowIfCancellationRequested();
            var actual = (string)range.Text;
            var verified = (int)slides.Count == 1 && actual == text && string.IsNullOrEmpty((string)document.Path);
            return new() { ["verified"] = verified, ["document"] = (string)document.Name, ["slideCount"] = (int)slides.Count,
                ["text"] = actual, ["characterCount"] = new System.Globalization.StringInfo(actual).LengthInTextElements, ["saved"] = false,
                ["detail"] = verified ? "已新建一页演示文稿并核对文字；尚未保存。" : "已创建文稿，但最终内容未能核实，请查看应用；尚未保存。" };
        }
        catch (Exception error) when (changed && error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        { return new() { ["verified"] = false, ["detail"] = "新建过程中应用未能返回最终结果，请先查看现有文稿；未自动重建或保存。" }; }
        finally
        {
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
        }
    }

    private static object OpenApplication(Type type, AgentApplication application, List<object> owned)
    {
        bool Approved(object value) => string.Equals(ClassroomAgentPolicy.ApplicationPath((string)((dynamic)value).Path).TrimEnd('\\'),
            Path.GetDirectoryName(ClassroomAgentPolicy.ApplicationPath(application.Path)), StringComparison.OrdinalIgnoreCase);
        var clsid = type.GUID;
        if (GetActiveObject(ref clsid, 0, out var active) == 0 && active is not null)
        {
            owned.Add(active);
            // Office-compatible products may publish another product's active
            // CLSID. Reuse only the selected package, never that foreign object.
            if (Approved(active)) return active;
        }
        var created = Activator.CreateInstance(type) ?? throw new InvalidOperationException("文稿应用未能启动。");
        owned.Add(created);
        if (!Approved(created)) throw new InvalidOperationException("文稿接口对应的应用不在本机允许范围内，未创建文稿。");
        return created;
    }

    internal static bool CloseSavedFile(string path, IReadOnlyList<AgentApplication> applications, CancellationToken token)
    {
        foreach (var approved in applications.Where(a => a.Kind is "word" or "wps-writer" or "powerpoint" or "wps-presentation" or "excel" or "wps-sheet"))
        {
            var progId = approved.Kind switch { "word" => "Word.Application", "wps-writer" => "Kwps.Application",
                "powerpoint" => "PowerPoint.Application", "wps-presentation" => "Kwpp.Application", "excel" => "Excel.Application", _ => "Ket.Application" };
            var owned = new List<object>();
            object Own(object value) { owned.Add(value); return value; }
            try
            {
                // Inspect only an existing approved instance. Never start an
                // editor or close an application to release somebody's file.
                if (CLSIDFromProgID(progId, out var clsid) != 0 || GetActiveObject(ref clsid, 0, out var active) != 0 || active is null) continue;
                dynamic app = Own(active);
                if (!string.Equals(ClassroomAgentPolicy.ApplicationPath((string)app.Path).TrimEnd('\\'),
                    Path.GetDirectoryName(ClassroomAgentPolicy.ApplicationPath(approved.Path)), StringComparison.OrdinalIgnoreCase)) continue;
                dynamic documents = Own(approved.Kind is "powerpoint" or "wps-presentation" ? app.Presentations :
                    approved.Kind is "excel" or "wps-sheet" ? app.Workbooks : app.Documents);
                for (var i = 1; i <= (int)documents.Count; i++)
                {
                    token.ThrowIfCancellationRequested();
                    dynamic document = Own(documents.Item(i));
                    var fullName = (string)document.FullName;
                    if (!Path.IsPathFullyQualified(fullName) || !string.Equals(ClassroomAgentPolicy.ApplicationPath(fullName),
                        ClassroomAgentPolicy.ApplicationPath(path), StringComparison.OrdinalIgnoreCase)) continue;
                    if (Convert.ToInt32(document.Saved) == 0)
                        throw new InvalidOperationException("这份文稿有未保存的修改，已保留文稿和文件。请先处理这些修改后再删除。");
                    token.ThrowIfCancellationRequested();
                    if (approved.Kind is "powerpoint" or "wps-presentation") document.Close();
                    else document.Close(0);
                    return true;
                }
            }
            catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
            { /* An unavailable editor interface cannot authorize closing a window. */ }
            finally
            {
                foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                    try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            }
        }
        return false;
    }

    internal static JsonObject Execute(string action, JsonElement args, string kind, nint handle, CancellationToken token)
    {
        var progId = kind switch { "powerpoint" => "PowerPoint.Application", "wps-presentation" => "Kwpp.Application",
            "word" => "Word.Application", "wps-writer" => "Kwps.Application", "excel" => "Excel.Application", "wps-sheet" => "Ket.Application",
            _ => throw new InvalidOperationException("此窗口没有可用的文稿接口，请使用应用控件。") };
        var owned = new List<object>();
        var changed = false;
        object Own(object value) { owned.Add(value); return value; }
        try
        {
            object? selected = NativeDocument(kind, handle, token, owned);
            if (selected is null)
            {
                if (CLSIDFromProgID(progId, out var clsid) != 0 || GetActiveObject(ref clsid, 0, out var application) != 0 || application is null)
                    throw new InvalidOperationException("此安装版本未提供文稿接口，请在应用中编辑或使用可用控件。");
                dynamic app = Own(application);
                dynamic documents = Own(kind is "powerpoint" or "wps-presentation" ? app.Presentations : kind is "word" or "wps-writer" ? app.Documents : app.Workbooks);
                for (var i = 1; i <= (int)documents.Count; i++)
                {
                    token.ThrowIfCancellationRequested();
                    dynamic document = Own(documents.Item(i));
                    dynamic windows = Own(document.Windows);
                    var matched = false;
                    for (var j = 1; j <= (int)windows.Count; j++)
                    {
                        dynamic window = Own(windows.Item(j));
                        if (WindowMatches(window, handle, app)) matched = true;
                    }
                    if (matched)
                    {
                        if (selected is not null) throw new InvalidOperationException("多个文稿共享此窗口，无法唯一确认，请在应用中只保留要操作的文稿。");
                        selected = document;
                    }
                }
            }
            if (selected is null) throw new InvalidOperationException("未能将文稿对应到所选窗口，请选择编辑窗口并重新查看。");
            dynamic doc = selected;
            var find = action == "replace_document_text" ? ClassroomAgentService.Text(args, "find", 500) : "";
            var replacement = action == "replace_document_text" ? ClassroomAgentService.Text(args, "text", 2000, false) : "";
            var content = new StringBuilder();
            var matches = 0;
            if (kind is "powerpoint" or "wps-presentation")
            {
                dynamic slides = Own(doc.Slides);
                var count = (int)slides.Count;
                var requested = args.TryGetProperty("page", out var pageNode) ? pageNode.GetInt32() : 0;
                if (requested < 0 || requested > count || requested == 0 && count > 500) throw new InvalidOperationException("请指定文稿范围内的页码，或使用不超过 500 页的课件。");
                var textRanges = new List<object>();
                for (var page = requested > 0 ? requested : 1; page <= (requested > 0 ? requested : count); page++)
                {
                    token.ThrowIfCancellationRequested();
                    dynamic slide = Own(slides.Item(page));
                    dynamic shapes = Own(slide.Shapes);
                    content.AppendLine($"第 {page} 页");
                    for (var s = 1; s <= (int)shapes.Count; s++)
                    {
                        dynamic shape = Own(shapes.Item(s));
                        if ((int)shape.HasTextFrame == 0) continue;
                        dynamic frame = Own(shape.TextFrame);
                        if ((int)frame.HasText == 0) continue;
                        dynamic range = Own(frame.TextRange);
                        var text = (string)range.Text;
                        if (content.Length < 12000) content.AppendLine(text[..Math.Min(text.Length, 12000 - content.Length)]);
                        if (action == "replace_document_text") { matches += Occurrences(text, find); textRanges.Add(range); }
                    }
                }
                if (action == "replace_document_text")
                {
                    if (matches > 200) throw new InvalidOperationException("匹配内容超过 200 处，请指定页码缩小范围。");
                    foreach (dynamic range in textRanges)
                    {
                        var offset = 0;
                        for (var attempt = 0; attempt <= 200; attempt++)
                        {
                            token.ThrowIfCancellationRequested(); changed = true;
                            object? replaced = range.Replace(find, replacement, offset, -1, 0);
                            if (replaced is null) break;
                            Own(replaced); dynamic result = replaced;
                            offset = (int)result.Start + (int)result.Length - 1;
                            if (offset >= ((string)range.Text).Length) break;
                        }
                    }
                }
                return Finish(action, content, matches, "普通文本框；不含备注、图片、分组和表格文字。修改不会自动保存。");
            }
            if (kind is "word" or "wps-writer")
            {
                dynamic range = Own(doc.Content);
                var text = (string)range.Text;
                content.Append(text[..Math.Min(12000, text.Length)]);
                if (action == "replace_document_text")
                {
                    matches = Occurrences(text, find);
                    if (matches > 200) throw new InvalidOperationException("匹配内容超过 200 处，请在应用内缩小范围后编辑。");
                    if (find.Contains('^') || replacement.Contains('^')) throw new InvalidOperationException("此替换包含文稿控制符，请在应用内完成。");
                    dynamic search = Own(range.Find);
                    token.ThrowIfCancellationRequested(); changed = true;
                    search.Execute(find, true, false, false, false, false, true, 0, false, replacement, 2);
                }
                return Finish(action, content, matches, "正文；不含页眉、页脚和图片文字。修改不会自动保存。");
            }
            dynamic sheet = Own(doc.ActiveSheet);
            dynamic used = Own(sheet.UsedRange);
            dynamic cells = Own(used.Cells);
            var cellCount = (double)cells.CountLarge;
            if (action == "replace_document_text" && cellCount > 5000) throw new InvalidOperationException("当前表格超过 5000 个使用单元格，请在应用内缩小范围后编辑。");
            var edits = new List<(object Cell, string Text)>();
            for (var i = 1; i <= Math.Min(cellCount, action == "read_document" ? 200 : 5000); i++)
            {
                token.ThrowIfCancellationRequested();
                dynamic cell = Own(cells.Item(i));
                if (cell.Value2 is not string text || (bool)cell.HasFormula) continue;
                if (content.Length < 12000) content.AppendLine($"{cell.Address}: {text[..Math.Min(text.Length, 1000)]}");
                if (action == "replace_document_text" && text.Contains(find, StringComparison.Ordinal))
                { matches += Occurrences(text, find); edits.Add((cell, text.Replace(find, replacement, StringComparison.Ordinal))); }
            }
            if (matches > 200) throw new InvalidOperationException("匹配内容超过 200 处，请在应用内缩小范围后编辑。");
            foreach (var edit in edits)
            {
                token.ThrowIfCancellationRequested(); changed = true;
                // A replacement beginning with '=' must remain literal text.
                ((dynamic)edit.Cell).Formula = "'" + edit.Text;
            }
            return Finish(action, content, matches, action == "read_document" ? "当前工作表前 200 个使用单元格中的文本；不读取公式。" : "当前工作表的文本单元格；不修改公式，不自动保存。");
        }
        catch (Exception error) when (changed && error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        { return new() { ["verified"] = false, ["detail"] = "文稿接口在修改后未能返回最终结果；请在应用中核对，未自动保存。" }; }
        finally
        {
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value)) try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
        }
    }

    private static int Occurrences(string text, string find)
    {
        var count = 0; var offset = 0;
        while ((offset = text.IndexOf(find, offset, StringComparison.Ordinal)) >= 0) { count++; offset += find.Length; }
        return count;
    }
    internal static bool WindowMatches(dynamic window, nint target, object? application = null)
    {
        try
        {
            var handle = (nint)Convert.ToInt64(window.HWND);
            var root = GetAncestor(handle, 2);
            return handle == target || root != 0 && root == target;
        }
        catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
        if (application is null) return false;
        try
        {
            // Some presentation versions expose HWND only on Application.
            // Caption matching is allowed only inside that exact process.
            dynamic app = application;
            var handle = (nint)Convert.ToInt64(app.HWND);
            GetWindowThreadProcessId(handle, out var owner);
            GetWindowThreadProcessId(target, out var selected);
            if (owner == 0 || owner != selected) return false;
            var title = new StringBuilder(240); GetWindowText(target, title, title.Capacity);
            var caption = (string)window.Caption;
            return !string.IsNullOrWhiteSpace(caption) && (title.ToString() == caption || title.ToString().StartsWith(caption + " - ", StringComparison.Ordinal));
        }
        catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { return false; }
    }
    internal static object? NativeDocument(string kind, nint handle, CancellationToken token, List<object> owned)
    {
        // OBJID_NATIVEOM binds Office's object model to the selected native
        // window, including a particular Excel instance. PowerPoint's editor
        // DocumentWindow does not publish an HWND property.
        GetWindowThreadProcessId(handle, out var process);
        // WPS hosts its visible frame and native editor in separate processes.
        // Only admit descendant editors from the exact same executable; the
        // global active object may belong to an unrelated WPS document.
        var editorProcesses = new Dictionary<uint, bool>();
        string ProcessPath(uint pid)
        {
            try
            {
                using var owner = Process.GetProcessById(checked((int)pid));
                return ClassroomAgentPolicy.ApplicationPath(owner.MainModule?.FileName ?? "");
            }
            catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or ArgumentException) { return ""; }
        }
        var hostPath = kind.StartsWith("wps-", StringComparison.Ordinal) ? ProcessPath(process) : "";
        var children = new List<nint> { handle };
        EnumChildWindows(handle, (child, _) =>
        {
            GetWindowThreadProcessId(child, out var pid);
            if (!IsWindowVisible(child)) return true;
            if (!editorProcesses.TryGetValue(pid, out var approved))
            {
                approved = pid == process || hostPath.Length > 0 && string.Equals(hostPath, ProcessPath(pid), StringComparison.OrdinalIgnoreCase);
                editorProcesses[pid] = approved;
            }
            if (approved && children.Count < 120) children.Add(child);
            return children.Count < 120;
        }, 0);
        object? selected = null;
        string? identity = null;
        foreach (var child in children)
        {
            token.ThrowIfCancellationRequested();
            var iid = new Guid("00020400-0000-0000-C000-000000000046");
            if (AccessibleObjectFromWindow(child, 0xFFFFFFF0, ref iid, out var value) != 0 || value is null) continue;
            owned.Add(value);
            try
            {
                dynamic window = value;
                object doc;
                if (kind is "powerpoint" or "wps-presentation")
                {
                    try { doc = window.Presentation; }
                    catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
                    {
                        // Some WPS releases return the presentation itself.
                        _ = (int)window.Slides.Count; _ = (string)window.FullName; doc = value;
                    }
                }
                else if (kind is "word" or "wps-writer") doc = window.Document;
                else { object sheetObject = window.ActiveSheet; owned.Add(sheetObject); dynamic sheet = sheetObject; doc = sheet.Parent; }
                owned.Add(doc);
                var name = (string)((dynamic)doc).FullName;
                if (identity is not null && !string.Equals(identity, name, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("所选窗口中存在多个可操作文稿，请先在应用中选择唯一文稿。");
                selected = doc; identity = name;
            }
            catch (Exception error) when (error is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
        }
        return selected;
    }
    private static JsonObject Finish(string action, StringBuilder text, int count, string coverage) => action == "read_document"
        ? new() { ["verified"] = true, ["text"] = text.ToString()[..Math.Min(text.Length, 12000)], ["coverage"] = coverage, ["detail"] = "已读取所选文稿的可用文字。" }
        : new() { ["verified"] = count == 0, ["matches"] = count, ["coverage"] = coverage, ["detail"] = count == 0 ? "没有匹配的文字，未修改。" : $"已向文稿接口提交 {count} 处文字替换；未自动保存，请查看文稿核对。" };
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)] private static extern int CLSIDFromProgID(string id, out Guid clsid);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint handle, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint handle, StringBuilder text, int capacity);
    private delegate bool EnumWindowsProc(nint handle, nint parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(nint handle, EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint handle, out uint process);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint handle);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(nint handle, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.IDispatch)] out object? value);
    [DllImport("oleaut32.dll", PreserveSig = true)] private static extern int GetActiveObject(ref Guid clsid, nint reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
}

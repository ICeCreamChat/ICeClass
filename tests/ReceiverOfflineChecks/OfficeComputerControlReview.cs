using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class OfficeComputerControlReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var results = new List<object>();
        var apps = ClassroomAgentPolicy.Load().Available();
        var host = new Window { Title = "班班 Office 临时文稿验收", Width = 360, Height = 140, Content = new TextBlock { Text = "仅操作本次创建的临时文稿。", Margin = new Thickness(24) } };
        host.Show();
        var worker = new ClassroomAgentWorker();
        JsonElement Args(object value) => JsonSerializer.SerializeToElement(value);
        var failures = 0;
        foreach (var (kind, progId) in new[] { ("powerpoint", "PowerPoint.Application"), ("word", "Word.Application"), ("excel", "Excel.Application"),
            ("wps-presentation", "Kwpp.Application"), ("wps-writer", "Kwps.Application"), ("wps-sheet", "Ket.Application") })
        {
            if (Environment.GetEnvironmentVariable("BANBAN_REVIEW_KIND") is string filter && filter != kind) continue;
            if (!apps.Any(a => a.Kind == kind)) { results.Add(new { kind, status = "not-installed" }); continue; }
            var owned = new List<object>();
            dynamic? app = null, doc = null;
            var checks = new List<string>();
            var existing = false;
            object Own(object value) { owned.Add(value); return value; }
            void Check(bool ok, string label) { if (!ok) throw new InvalidOperationException(label); checks.Add(label); }
            async Task<bool> AtPage(int expected)
            {
                var limit = System.Diagnostics.Stopwatch.StartNew();
                do
                {
                    try { if ((int)doc!.SlideShowWindow.View.CurrentShowPosition == expected) return true; }
                    catch (COMException error) when (error.HResult == unchecked((int)0x80004005)) { }
                    await Task.Delay(80);
                } while (limit.Elapsed < TimeSpan.FromSeconds(3));
                return false;
            }
            var marker = "班班临时验收原文";
            var name = "banban-" + kind + "-" + Guid.NewGuid().ToString("N")[..8];
            try
            {
                var type = Type.GetTypeFromProgID(progId);
                if (type is null) { results.Add(new { kind, status = "no-com-interface" }); continue; }
                if (CLSIDFromProgID(progId, out var clsid) == 0 && GetActiveObject(ref clsid, 0, out var old) == 0 && old is not null)
                { existing = true; Marshal.ReleaseComObject(old); }
                app = Own(Activator.CreateInstance(type)!);
                var presentation = kind is "powerpoint" or "wps-presentation";
                var writer = kind is "word" or "wps-writer";
                if (presentation)
                {
                    app.Visible = -1;
                    doc = Own(app.Presentations.Add(-1));
                    dynamic slide = Own(doc.Slides.Add(1, 12));
                    dynamic shape = Own(slide.Shapes.AddTextbox(1, 40f, 40f, 600f, 100f));
                    shape.TextFrame.TextRange.Text = marker; shape.TextFrame.TextRange.Font.Bold = -1;
                    Own(doc.Slides.Add(2, 12));
                    doc.SaveAs(Path.Combine(output, name + ".pptx"), 24);
                }
                else if (writer)
                {
                    app.Visible = true;
                    doc = Own(app.Documents.Add()); doc.Content.Text = marker; doc.Content.Font.Bold = -1;
                    if (kind == "word") doc.SaveAs2(Path.Combine(output, name + ".docx"), 16);
                    else doc.SaveAs(Path.Combine(output, name + ".docx"), 16);
                }
                else
                {
                    app.Visible = true;
                    doc = Own(app.Workbooks.Add());
                    dynamic sheet = Own(doc.Worksheets.Item(1));
                    sheet.Cells[1, 1].Value2 = marker; sheet.Cells[1, 1].Font.Bold = true; sheet.Cells[1, 2].Formula = "=1+1";
                    doc.SaveAs(Path.Combine(output, name + ".xlsx"), 51);
                }
                // Office registers its active object after its first focus loss.
                host.Activate(); await Task.Delay(200);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(18));
                async Task<string> Target()
                {
                    var state = await worker.InspectAsync(apps, timeout.Token);
                    var candidates = state["windows"]!.AsArray().Where(w => w!["title"]!.GetValue<string>().Contains(name, StringComparison.OrdinalIgnoreCase)).ToArray();
                    if (candidates.Length != 1) Console.WriteLine($"{kind}: temporary matching windows: {JsonSerializer.Serialize(candidates)}");
                    var target = candidates.Single();
                    Check(apps.Any(a => a.Kind == kind && a.Id == target!["appId"]!.GetValue<string>()),
                        "observed window identifies its logical Office application even when WPS shares a process");
                    return target!["id"]!.GetValue<string>();
                }
                var id = await Target();
                var editorId = id;
                if (kind == "wps-presentation")
                {
                    try { await worker.OperateAsync("read_document", Args(new { targetId = id }), apps, timeout.Token); }
                    catch (InvalidOperationException error) when (error.Message.Contains("文稿对应") || error.Message.Contains("文稿接口"))
                    {
                        Check(true, "unavailable native document binding is rejected without guessing a presentation");
                        var start = await worker.OperateAsync("presentation_start", Args(new { targetId = id }), apps, timeout.Token);
                        Check(start["verified"]!.GetValue<bool>(), "slideshow appearance verifies the start even without a document interface");
                        Check(await AtPage(1), "selected WPS fixture actually starts its slideshow");
                        var shows = start["windows"]!.AsArray().Where(w => w!["kind"]!.GetValue<string>() == kind && w["title"]!.GetValue<string>().Contains(name, StringComparison.OrdinalIgnoreCase) && w["id"]!.GetValue<string>() != id).ToArray();
                        var selected = shows.Single(w => w!["foreground"]!.GetValue<bool>());
                        id = selected!["id"]!.GetValue<string>();
                        await worker.OperateAsync("presentation_next", Args(new { targetId = id }), apps, timeout.Token);
                        Check(await AtPage(2), "selected WPS fixture actually advances to the second page");
                        await worker.OperateAsync("presentation_previous", Args(new { targetId = id }), apps, timeout.Token);
                        Check(await AtPage(1), "selected WPS fixture actually returns to the first page");
                        await worker.OperateAsync("presentation_goto", Args(new { targetId = id, page = 2 }), apps, timeout.Token);
                        Check(await AtPage(2), "bounded numeric navigation reaches the requested WPS page");
                        var alreadyShowing = await worker.OperateAsync("presentation_start", Args(new { targetId = editorId }), apps, timeout.Token);
                        Check(alreadyShowing["verified"]!.GetValue<bool>() && (int)doc.SlideShowWindow.View.CurrentShowPosition == 2,
                            "starting an already running slideshow preserves its current page");
                        var endResult = await worker.OperateAsync("presentation_end", Args(new { targetId = id }), apps, timeout.Token); await Task.Delay(150);
                        var ended = false; try { _ = doc.SlideShowWindow.View; } catch (Exception exception) when (exception is COMException or MissingMemberException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { ended = true; }
                        Check(ended, "the selected WPS slideshow actually ends");
                        Check(endResult["verified"]!.GetValue<bool>(), "the end receipt is grounded in the slideshow disappearing");
                        var restarted = await worker.OperateAsync("presentation_start", Args(new { targetId = editorId }), apps, timeout.Token);
                        Check(restarted["verified"]!.GetValue<bool>(), "a second slideshow start is observed");
                        var endedFromEditor = await worker.OperateAsync("presentation_end", Args(new { targetId = editorId }), apps, timeout.Token);
                        File.WriteAllText(Path.Combine(output, "wps-end-from-editor.json"), endedFromEditor.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                        Check(endedFromEditor["verified"]!.GetValue<bool>(), "the editor resolves only its own slideshow when ending a presentation");
                        results.Add(new { kind, status = "passed-with-document-interface-unavailable", checks, limitation = "This installed WPS presentation version does not expose a window-bound document interface; use native controls for edits." });
                        Console.WriteLine($"{kind}: {checks.Count} real shortcut checks passed; document interface unavailable in this version.");
                        continue;
                    }
                }
                var read = await worker.OperateAsync("read_document", Args(new { targetId = id }), apps, timeout.Token);
                Check(read["text"]!.GetValue<string>().Contains(marker), "reads only the selected temporary document");
                await worker.OperateAsync("replace_document_text", Args(new { targetId = id, find = "原文", text = "替换后" }), apps, timeout.Token);
                id = await Target();
                var after = await worker.OperateAsync("read_document", Args(new { targetId = id }), apps, timeout.Token);
                Check(after["text"]!.GetValue<string>().Contains("班班临时验收替换后"), "replacement is visible through a fresh document read");
                if (presentation)
                {
                    Check((int)doc.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Font.Bold == -1, "text replacement preserves bold formatting");
                    var start = await worker.OperateAsync("presentation_start", Args(new { targetId = id }), apps, timeout.Token);
                    Check(start["verified"]!.GetValue<bool>() && start["page"]!.GetValue<int>() == 1, "presentation starts at its confirmed page");
                    var show = start["windows"]!.AsArray().First(w => w!["kind"]!.GetValue<string>() == kind && w["title"]!.GetValue<string>().Contains(name, StringComparison.OrdinalIgnoreCase) && w["id"]!.GetValue<string>() != id);
                    id = show!["id"]!.GetValue<string>();
                    var next = await worker.OperateAsync("presentation_next", Args(new { targetId = id }), apps, timeout.Token);
                    Check(next["page"]!.GetValue<int>() == 2, "next slide reports the actual second page");
                    var previous = await worker.OperateAsync("presentation_previous", Args(new { targetId = id }), apps, timeout.Token);
                    Check(previous["page"]!.GetValue<int>() == 1, "previous slide reports the actual first page");
                    var go = await worker.OperateAsync("presentation_goto", Args(new { targetId = id, page = 2 }), apps, timeout.Token);
                    Check(go["page"]!.GetValue<int>() == 2, "go-to-slide verifies the requested page");
                    var end = await worker.OperateAsync("presentation_end", Args(new { targetId = id }), apps, timeout.Token);
                    Check(end["verified"]!.GetValue<bool>(), "end presentation returns a confirmed receipt");
                }
                else if (writer) Check((int)doc.Content.Font.Bold == -1, "text replacement preserves bold formatting");
                else
                {
                    dynamic sheet = Own(doc.Worksheets.Item(1));
                    Check((bool)sheet.Cells[1, 1].Font.Bold, "text replacement preserves bold formatting");
                    await worker.OperateAsync("replace_document_text", Args(new { targetId = id, find = "班班临时验收替换后", text = "=1+1" }), apps, timeout.Token);
                    Check((string)sheet.Cells[1, 1].Value2 == "=1+1" && !(bool)sheet.Cells[1, 1].HasFormula, "replacement remains literal text even when it begins with equals");
                    Check((string)sheet.Cells[1, 2].Formula == "=1+1", "existing formulas remain unchanged");
                }
                Check(presentation ? (int)doc.Saved == 0 : !(bool)doc.Saved, "editing does not save implicitly");
                results.Add(new { kind, status = "passed", checks });
                Console.WriteLine($"{kind}: {checks.Count} real application checks passed.");
            }
            catch (Exception error)
            {
                failures++; Console.Error.WriteLine($"{kind}: {error}");
                results.Add(new { kind, status = "failed", checks, error = error.Message });
            }
            finally
            {
                worker.Reset();
                if (doc is not null)
                {
                    try { if (kind is "word" or "wps-writer" or "excel" or "wps-sheet") doc.Close(false); else { doc.Saved = -1; doc.Close(); } }
                    catch (Exception error) { Console.Error.WriteLine("Close temporary document: " + error.Message); }
                }
                if (app is not null && !existing)
                {
                    try
                    {
                        var count = kind is "powerpoint" or "wps-presentation" ? (int)app.Presentations.Count : kind is "word" or "wps-writer" ? (int)app.Documents.Count : (int)app.Workbooks.Count;
                        if (count == 0) app.Quit();
                    }
                    catch (Exception error) { Console.Error.WriteLine("Close isolated Office application: " + error.Message); }
                }
                foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value)) try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            }
        }
        File.WriteAllText(Path.Combine(output, "office-checks.json"), JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
        host.Close();
        ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(failures > 0 ? 1 : 0);
    }
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)] private static extern int CLSIDFromProgID(string id, out Guid clsid);
    [DllImport("oleaut32.dll", PreserveSig = true)] private static extern int GetActiveObject(ref Guid clsid, nint reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
}

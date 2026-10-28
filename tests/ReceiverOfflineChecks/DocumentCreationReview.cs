using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class DocumentCreationReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var worker = new ClassroomAgentWorker();
        var checks = new List<string>();
        void Check(bool condition, string label) { if (!condition) throw new InvalidOperationException(label); checks.Add(label); }
        var owned = new List<object>();
        var createdDocuments = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        var exit = 1;
        try
        {
            var apps = ClassroomAgentPolicy.Load().Available();
            var app = apps.First(a => a.Kind == "wps-writer");
            Own(Activator.CreateInstance(Type.GetTypeFromProgID("Kwps.Application")!)!);
            var activeType = Type.GetTypeFromProgID("Kwps.Application")!;
            var activeClsid = activeType.GUID;
            var activeStatus = GetActiveObject(ref activeClsid, 0, out var activeApplication);
            Check(activeStatus == 0 && activeApplication is not null, "running writer exposes its automation interface");
            dynamic office = Own(activeApplication!);
            dynamic documents = Own(office.Documents);
            dynamic sentinel = Own(documents.Add());
            createdDocuments.Add(sentinel);
            dynamic sentinelRange = Own(sentinel.Content);
            const string original = "班班原文保护验收：此处不能被新建操作修改。";
            sentinelRange.Text = original;
            var baseline = (string)sentinelRange.Text;
            var names = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 1; i <= (int)documents.Count; i++) names.Add((string)((dynamic)Own(documents.Item(i))).Name);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(50));
            var priorWindows = (await worker.InspectAsync(apps, timeout.Token))["windows"]!.AsArray()
                .Where(w => w!["kind"]!.GetValue<string>() == "wps-writer" && w["isPopup"]?.GetValue<bool>() != true)
                .Select(w => w!["id"]!.GetValue<string>()).ToHashSet();
            var observationTimes = new List<long>();
            for (var i = 0; i < 3; i++)
            {
                var watch = Stopwatch.StartNew();
                await worker.InspectAsync(apps, timeout.Token);
                observationTimes.Add(watch.ElapsedMilliseconds);
            }
            var observationMedian = observationTimes.Order().ElementAt(1);
            Check(observationMedian < 300, $"fresh warm window inspection median is under 300 ms ({observationMedian} ms)");
            var marker = "班班独立文稿验收：窗前一束光，\n照亮求知路。";
            object? createdRange = null;
            string? createdBaseline = null;
            var beforeCreationCount = (int)documents.Count;
            var result = await worker.OperateAsync("create_document", JsonSerializer.SerializeToElement(new { appId = app.Id, text = marker }), apps, timeout.Token);
            File.WriteAllText(Path.Combine(output, "created.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Check(result["verified"]?.GetValue<bool>() == true, "new document receipt is verified");
            Check((int)documents.Count == beforeCreationCount + 1, "new document reuses the running approved writer instead of starting another automation instance");
            // WPS may expose separate automation instances. A second COM
            // client's Documents collection need not contain the new window.
            Check(result["windows"]!.AsArray().Count(w => w!["kind"]!.GetValue<string>() == "wps-writer"
                && w["isPopup"]?.GetValue<bool>() != true && !priorWindows.Contains(w["id"]!.GetValue<string>())) == 1,
                "exactly one new native Word document window appeared");
            for (var i = 1; i <= (int)documents.Count; i++)
            {
                dynamic candidate = Own(documents.Item(i));
                if (!names.Contains((string)candidate.Name) && (string)candidate.Name == result["document"]!.GetValue<string>())
                {
                    createdDocuments.Add(candidate);
                    createdRange = Own(candidate.Content);
                    createdBaseline = (string)((dynamic)createdRange).Text;
                }
            }
            Check(result["text"]!.GetValue<string>() == marker, "creation interface reads back the exact requested multiline body");
            Check((string)sentinelRange.Text == baseline, "pre-existing sentinel document remains unchanged");
            Check(result["saved"]?.GetValue<bool>() == false, "new document is unsaved");
            var window = result["windows"]!.AsArray().Single(w => w!["id"]!.GetValue<string>() == result["targetId"]!.GetValue<string>());
            Check(window!["title"]!.GetValue<string>() == result["document"]!.GetValue<string>() + " - WPS Office"
                && !priorWindows.Contains(result["targetId"]!.GetValue<string>()), "receipt refers to the actual newly observed document window");
            Check(window!["maximized"]!.GetValue<bool>() && window["foreground"]!.GetValue<bool>(), "new document is maximized in the foreground");
            var afterCount = (int)documents.Count;
            var wrongPackage = new AgentApplication("wrong-package", "Wrong package", "wps-writer", Environment.ProcessPath!);
            try
            {
                await worker.OperateAsync("create_document", JsonSerializer.SerializeToElement(new { appId = wrongPackage.Id, text = marker }), [wrongPackage], timeout.Token);
                throw new InvalidOperationException("mismatched COM registration accepted");
            }
            catch (InvalidOperationException error) when (error.Message.Contains("允许范围"))
            { Check((int)documents.Count == afterCount, "unapproved COM registration is rejected before document creation"); }
            var blank = await worker.OperateAsync("create_document", JsonSerializer.SerializeToElement(new { appId = app.Id }), apps, timeout.Token);
            Check(blank["verified"]?.GetValue<bool>() == true && blank["targetId"]!.GetValue<string>() != result["targetId"]!.GetValue<string>(), "omitted text creates a separate blank document");
            Check(blank["text"]!.GetValue<string>().Length == 0, "blank document contains no inserted body");
            Check((string)sentinelRange.Text == baseline && createdRange is not null
                && (string)((dynamic)createdRange).Text == createdBaseline,
                "the sentinel and the first document remain unchanged when WPS switches tabs for the next document");
            for (var i = 1; i <= (int)documents.Count; i++)
            {
                dynamic candidate = Own(documents.Item(i));
                if ((string)candidate.Name == blank["document"]!.GetValue<string>()) createdDocuments.Add(candidate);
            }
            Console.WriteLine($"{checks.Count} real Word creation checks passed.");
            exit = 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); }
        finally
        {
            worker.Reset();
            // Only these documents were created by this test; never close the Office application.
            foreach (dynamic doc in createdDocuments.AsEnumerable().Reverse())
                try { doc.Close(0); } catch (Exception error) when (error is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) { }
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = exit == 0, checks }));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(exit);
        }
    }

    [DllImport("oleaut32.dll", PreserveSig = true)]
    private static extern int GetActiveObject(ref Guid clsid, nint reserved, [MarshalAs(UnmanagedType.IUnknown)] out object? value);
}

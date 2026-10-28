using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class PresentationCreationReview
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Review(Path.GetFullPath(output))))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static async Task Review(string output)
    {
        Directory.CreateDirectory(output);
        var apps = ClassroomAgentPolicy.Load().Available();
        var worker = new ClassroomAgentWorker();
        var checks = new List<string>();
        void Check(bool condition, string label) { if (!condition) throw new InvalidOperationException(label); checks.Add(label); }
        var owned = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        dynamic? created = null;
        var exit = 1;
        try
        {
            var kind = Environment.GetEnvironmentVariable("BANBAN_REVIEW_KIND") ?? "wps-presentation";
            if (kind is not ("powerpoint" or "wps-presentation")) throw new InvalidOperationException("Unsupported review kind");
            var app = apps.First(a => a.Kind == kind);
            dynamic office = Own(Activator.CreateInstance(Type.GetTypeFromProgID(kind == "powerpoint" ? "PowerPoint.Application" : "Kwpp.Application")!)!);
            dynamic documents = Own(office.Presentations);
            var before = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 1; i <= (int)documents.Count; i++) before.Add((string)((dynamic)Own(documents.Item(i))).FullName);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            var marker = "这是测试文件 · " + Guid.NewGuid().ToString("N")[..8];
            var priorWindows = (await worker.InspectAsync(apps, timeout.Token))["windows"]!.AsArray().Select(w => w!["id"]!.GetValue<string>()).ToHashSet();
            var result = await worker.OperateAsync("create_presentation", JsonSerializer.SerializeToElement(new { appId = app.Id, text = marker }), apps, timeout.Token);
            File.WriteAllText(Path.Combine(output, "created.json"), result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            for (var i = 1; i <= (int)documents.Count; i++)
            {
                dynamic candidate = Own(documents.Item(i));
                if ((string)candidate.Name == result["document"]!.GetValue<string>() && !before.Contains((string)candidate.FullName))
                { if (created is not null) throw new InvalidOperationException("ambiguous created document"); created = candidate; }
            }
            Check(result["verified"]!.GetValue<bool>(), "creation receipt is verified");
            Check(created is not null, "the new presentation exists in the actual WPS application");
            Check((int)created!.Slides.Count == 1, "the actual presentation contains exactly one slide");
            Check((string)created.Slides.Item(1).Shapes.Item(1).TextFrame.TextRange.Text == marker, "independent COM readback matches the exact requested text");
            Check(result["characterCount"]!.GetValue<int>() == 17, "character count comes from the actual slide text rather than the user's spoken estimate");
            Check((int)created.Saved == 0 && string.IsNullOrEmpty((string)created.Path), "new document remains unsaved");
            var after = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 1; i <= (int)documents.Count; i++) after.Add((string)((dynamic)Own(documents.Item(i))).FullName);
            Check(before.IsSubsetOf(after) && after.Count == before.Count + 1, "pre-existing presentations remain open and exactly one is created");
            Check(result["windows"]!.AsArray().Any(w => w!["appId"]!.GetValue<string>() == app.Id), "receipt observes the logical WPS presentation application");
            Check(!priorWindows.Contains(result["targetId"]!.GetValue<string>()), "verification uses a newly observed document window rather than an already open presentation");
            var visible = result["windows"]!.AsArray().Single(w => w!["id"]!.GetValue<string>() == result["targetId"]!.GetValue<string>());
            Check(visible!["maximized"]!.GetValue<bool>() && visible["foreground"]!.GetValue<bool>(),
                "the created presentation is maximized in the foreground without starting a slideshow");
            var wrongPackage = new AgentApplication("wrong-package", "Wrong package", "wps-presentation", Environment.ProcessPath!);
            try
            {
                await worker.OperateAsync("create_presentation", JsonSerializer.SerializeToElement(new { appId = wrongPackage.Id, text = marker }), [wrongPackage], timeout.Token);
                throw new InvalidOperationException("a mismatched COM installation was accepted");
            }
            catch (InvalidOperationException error) when (error.Message.Contains("允许范围"))
            { Check((int)documents.Count == after.Count, "a COM registration outside the approved package cannot create a document"); }
            Console.WriteLine($"{kind}: {checks.Count} real presentation creation checks passed.");
            exit = 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); }
        finally
        {
            worker.Reset();
            // Only close the presentation returned by this exact test action.
            if (created is not null) try { created.Saved = -1; created.Close(); } catch (COMException) { }
            foreach (var value in owned.AsEnumerable().Reverse()) if (Marshal.IsComObject(value))
                try { Marshal.ReleaseComObject(value); } catch (InvalidComObjectException) { }
            File.WriteAllText(Path.Combine(output, "checks.json"), JsonSerializer.Serialize(new { passed = exit == 0, checks }));
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(exit);
        }
    }
}

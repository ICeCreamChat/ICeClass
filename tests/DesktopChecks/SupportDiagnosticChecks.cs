using System.IO.Compression;
using System.Text;
using ICeClass.Diagnostics;

internal static class SupportDiagnosticChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        using var bytes = new MemoryStream();
        await SupportDiagnostics.WriteArchiveAsync(bytes,
            "版本：2.5.6\npassword=private-password\nAuthorization: Bearer private-token\nCookie: private-cookie\n错误：动画停止\n",
            "2.5.6\n新增本机诊断", default);
        bytes.Position = 0;
        using (var archive = new ZipArchive(bytes, ZipArchiveMode.Read, leaveOpen: true))
        {
            Assert(archive.Entries.Select(entry => entry.FullName).Order().SequenceEqual(new[] { "更新记录.txt", "诊断报告.txt" }.Order()),
                "The diagnostic ZIP contains only the displayed report and public release history");
            using var reader = new StreamReader(archive.GetEntry("诊断报告.txt")!.Open(), Encoding.UTF8);
            var report = reader.ReadToEnd();
            Assert(report.Contains("动画停止") && report.Contains("2.5.6") && !report.Contains("private-"),
                "Export preserves Unicode error evidence and hides passwords, authentication and cookies");
            using var history = new StreamReader(archive.GetEntry("更新记录.txt")!.Open(), Encoding.UTF8);
            Assert(history.ReadToEnd().Contains("新增本机诊断"), "Release history is readable offline inside the ZIP");
        }
        using var oversized = new MemoryStream();
        try { await SupportDiagnostics.WriteArchiveAsync(oversized, new string('a', SupportDiagnostics.MaximumReportBytes + 1), "", default); throw new Exception("Oversized report accepted"); }
        catch (InvalidDataException) { Assert(oversized.Length == 0, "Oversized reports fail before writing the destination"); }
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        using var empty = new MemoryStream();
        try { await SupportDiagnostics.WriteArchiveAsync(empty, "report", "history", cancelled.Token); throw new Exception("Cancelled export accepted"); }
        catch (OperationCanceledException) { Assert(empty.Length == 0, "Closing diagnostics cancels an export before a partial archive is started"); }
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-SupportChecks-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var destination = Path.Combine(directory, "diagnostic.zip");
            File.WriteAllText(destination, "previous diagnostic");
            await SupportDiagnostics.SaveArchiveAsync(destination, "动画检查", "2.5.6", default);
            using (var saved = ZipFile.OpenRead(destination))
                Assert(saved.Entries.Count == 2, "Saving diagnostics replaces an existing file with a complete ZIP");
            var previous = File.ReadAllBytes(destination);
            try { await SupportDiagnostics.SaveArchiveAsync(destination, "report", "history", cancelled.Token); throw new Exception("Cancelled file export accepted"); }
            catch (OperationCanceledException) { Assert(File.ReadAllBytes(destination).SequenceEqual(previous), "Cancelling export preserves an existing diagnostic ZIP"); }
            try { await SupportDiagnostics.SaveArchiveAsync(destination, new string('a', SupportDiagnostics.MaximumReportBytes + 1), "", default); throw new Exception("Oversized file export accepted"); }
            catch (InvalidDataException) { Assert(File.ReadAllBytes(destination).SequenceEqual(previous), "Invalid report preserves an existing diagnostic ZIP"); }
            using (var locked = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                try { await SupportDiagnostics.SaveArchiveAsync(destination, "replacement", "history", default); throw new Exception("Locked export accepted"); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { Assert(File.ReadAllBytes(destination).SequenceEqual(previous), "A failed replacement preserves the complete previous diagnostic ZIP"); }
            }
            Assert(Directory.GetFiles(directory).Length == 1, "Failed diagnostic exports do not leave temporary files");
            var path = Path.Combine(directory, "sample.log");
            File.WriteAllText(path, new string('a', 1024) + "\n完整错误：动画停止\ntoken=private-tail\n", new UTF8Encoding(false));
            var tail = SupportDiagnostics.ReadLogTail(path, 128);
            Assert(tail.Contains("完整错误：动画停止") && !tail.Contains("private-tail") && !tail.Contains(new string('a', 100)),
                "Bounded log reads retain complete recent errors, drop the partial first line and redact secrets");
            Assert(SupportDiagnostics.ReadLogTail(Path.Combine(directory, "missing.log"), 128).Contains("尚无"),
                "A new installation has a useful empty-log state");
        }
        finally { Directory.Delete(directory, true); }
        return checks;
    }
}

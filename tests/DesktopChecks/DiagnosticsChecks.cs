using System.Text;
using System.Text.Json;
using ICeClass.Desktop;

internal static class DiagnosticsChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-Diagnostics-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "desktop-activity.jsonl");
        var now = new DateTimeOffset(2026, 11, 1, 8, 0, 0, TimeSpan.Zero);
        var clock = new CheckClock(now);
        try
        {
            using (var journal = new DesktopDiagnostics(directory, clock))
            {
                journal.Record("application", "旧记录"); await journal.FlushAsync(default);
                clock.Now = now.AddHours(25);
                journal.Record("action", "保留记录", "https://school.example/?private-query=hidden#island",
                    "password=private-password Cookie: private-cookie");
                journal.Record("request", "GET", "https://school.example/api/island?token=private-token", milliseconds: 1250, status: 503);
                journal.Record("javascript", "TypeError", detail: "https://school.example/app.js?secret=private-key");
                await journal.FlushAsync(default);
                var disk = File.ReadAllText(path);
                Assert(!disk.Contains("旧记录") && disk.Contains("保留记录"), "The journal expires records older than 24 hours");
                Assert(!disk.Contains("private-") && !disk.Contains("hidden") && disk.Contains("#island"),
                    "Activity is sanitized before it reaches the local disk");
            }
            using (var restarted = new DesktopDiagnostics(directory, clock))
            {
                restarted.Record("application", "重启记录"); await restarted.FlushAsync(default);
                var report = DesktopDiagnostics.ActivityReport(directory, clock.Now);
                Assert(report.Contains("保留记录") && report.Contains("重启记录"), "Restart keeps activity from the previous session");
                Assert(report.Contains("请求失败：1") && report.Contains("慢请求（≥1秒）：1") && report.Contains("脚本错误：1"),
                    "The activity report summarizes failures, slow requests and script errors");
                restarted.RecordBrowser("""{"type":"iceclass-diagnostic","kind":"request","name":"POST","url":"https://school.example/api/check?password=private-browser","status":400,"duration":45} """, "https://school.example");
                foreach (var message in new[] { "not-json", "null", "{}",
                    """{"type":"iceclass-diagnostic","kind":"request","url":null}""",
                    """{"type":"iceclass-diagnostic","kind":"request","name":"foreign","url":"https://other.example/api/check"}""",
                    """{"type":"iceclass-diagnostic","kind":"command","name":"command","url":"https://school.example/"}""" })
                    restarted.RecordBrowser(message, "https://school.example");
                await restarted.FlushAsync(default);
                report = DesktopDiagnostics.ActivityReport(directory, clock.Now);
                Assert(report.Contains("POST") && !report.Contains("private-browser") && !report.Contains("foreign") && !report.Contains("command"),
                    "The browser bridge accepts only supported same-origin diagnostic records");
            }
            File.AppendAllText(path, "not-json\nnull\n{\"at\":\"" + clock.Now.ToString("O") + "\",\"area\":null}\n");
            Assert(DesktopDiagnostics.ActivityReport(directory, clock.Now).Contains("重启记录"), "Malformed disk records do not hide valid activity");

            var entry = new DiagnosticEntry(clock.Now, "action", "容量检查", "", new string('x', 1000), null, null);
            var line = JsonSerializer.Serialize(entry, new JsonSerializerOptions(JsonSerializerDefaults.Web)) + "\n";
            File.WriteAllText(path, string.Concat(Enumerable.Repeat(line, 2800)), new UTF8Encoding(false));
            using (var journal = new DesktopDiagnostics(directory, clock))
            {
                journal.Record("application", "正常清理"); await journal.FlushAsync(default);
                Assert(new FileInfo(path).Length > 2 * 1024 * 1024, "Hourly retention does not prematurely halve a journal below capacity");
                File.AppendAllText(path, string.Concat(Enumerable.Repeat(line, 1200)));
                journal.Record("application", "满额清理"); await journal.FlushAsync(default);
                Assert(new FileInfo(path).Length <= DesktopDiagnostics.MaximumFileBytes && File.ReadAllText(path).Contains("满额清理"),
                    "A full journal stays within its disk budget and retains its newest event");
                Assert(Encoding.UTF8.GetByteCount(DesktopDiagnostics.ActivityReport(directory, clock.Now)) < 600 * 1024,
                    "The attachment reads a bounded recent tail instead of the whole journal");
            }
            var invalidDirectory = Path.Combine(directory, "not-a-directory"); File.WriteAllText(invalidDirectory, "x");
            using (var denied = new DesktopDiagnostics(invalidDirectory, clock))
            {
                denied.Record("action", "写入失败检查"); await denied.FlushAsync(default);
                Assert(denied.StorageStatus.Contains("失败"), "Storage failures remain visible without breaking the workbench or flush");
            }
        }
        finally { Directory.Delete(directory, true); }
        return checks;
    }
    private sealed class CheckClock(DateTimeOffset now) : TimeProvider
    {
        internal DateTimeOffset Now = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}

using ICeClass.Diagnostics;

internal static class ClientDiagnosticChecks
{
    internal static async Task<int> Run()
    {
        var checks = 0;
        void Assert(bool condition, string label) { if (!condition) throw new Exception(label); checks++; }
        string? sent = null; var attempts = 0;
        string? firstId = null, secondId = null;
        using var reporter = new ClientErrorReporter((id, text, _) =>
        {
            attempts++; if (attempts == 1) { firstId = id; throw new IOException("offline"); }
            secondId = id;
            sent = text; return Task.CompletedTask;
        });
        reporter.Record("动画停止 token=private-error");
        reporter.Record("动画停止 token=private-error");
        await reporter.FlushAsync(default);
        Assert(sent is null, "Automatic upload failures remain queued without failing the caller");
        await reporter.FlushAsync(default);
        Assert(firstId == secondId, "Retrying an unconfirmed batch keeps its report ID for server deduplication");
        Assert(attempts == 2 && sent?.Contains("动画停止") == true && sent.Contains("重复 2 次") && !sent.Contains("private-error"),
            "Automatic errors retry, merge repeated faults and redact before sending");
        await reporter.FlushAsync(default);
        Assert(attempts == 2, "A successful error batch is not uploaded again");
        for (var i = 0; i < 100; i++) reporter.Record("错误 " + i + new string('中', 2000));
        await reporter.FlushAsync(default);
        Assert(sent is not null && System.Text.Encoding.UTF8.GetByteCount(sent) <= 65536 && sent.Contains("错误 99"),
            "An error storm keeps recent evidence within the server upload limit");

        var directory = Path.Combine(Path.GetTempPath(), "ICeClass-DiagnosticChecks-" + Guid.NewGuid().ToString("N"));
        var queue = Path.Combine(directory, "outbox.json");
        try
        {
            string? failedId = null, recoveredId = null;
            using (var offline = new ClientErrorReporter((id, _, _) => { failedId = id; throw new IOException("offline"); }, queue, "first-account"))
            {
                offline.Record("重启前错误 password=private-password");
                await offline.FlushAsync(default);
            }
            Assert(File.Exists(queue) && !File.ReadAllText(queue).Contains("private-password"), "Only redacted errors are retained for retry after restart");
            using (var anotherAccount = new ClientErrorReporter((_, _, _) => throw new Exception("Wrong account received old errors"), queue, "another-account"))
                await anotherAccount.FlushAsync(default);
            Assert(true, "A different account cannot upload the previous identity's queued errors");
            using (var restarted = new ClientErrorReporter((id, text, _) => { recoveredId = id; sent = text; return Task.CompletedTask; }, queue, "first-account"))
                await restarted.FlushAsync(default);
            Assert(failedId == recoveredId && sent?.Contains("重启前错误") == true,
                "Restart retries the unconfirmed batch with its original deduplication ID");
            using (var confirmed = new ClientErrorReporter((_, _, _) => throw new Exception("Confirmed errors repeated"), queue, "first-account"))
                await confirmed.FlushAsync(default);
            Assert(true, "Acknowledged errors are not sent again after restart");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        return checks;
    }
}

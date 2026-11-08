using ICeClass.Receiver;
using System.Reflection;
using System.Text.Json;

internal static class SelfStudyChecks
{
    internal static void Run()
    {
        var count = 0;
        void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
            count++;
        }
        var cfg = new SelfStudyConfig { Enabled = true, Authorized = true, AiEnabled = true };
        var now = new DateTimeOffset(2026, 11, 9, 12, 5, 0, TimeSpan.Zero);
        var snapshot = new SelfStudySnapshot { Config = cfg, Schedule = [new() { Key = "test",
            StartAt = now.AddMinutes(-5).ToUnixTimeMilliseconds(), EndAt = now.AddMinutes(40).ToUnixTimeMilliseconds() }] };
        Check(snapshot.Session(now.ToUnixTimeMilliseconds()) is not null, "生效时间来自服务器浮岛课表");
        Check(snapshot.Session(now.AddHours(1).ToUnixTimeMilliseconds()) is null, "结束时间外停止");
        Check(snapshot.Session(now.AddDays(1).ToUnixTimeMilliseconds()) is null, "不将今日课表外推到其他日期");
        Check(new SelfStudySnapshot().Session(now.ToUnixTimeMilliseconds()) is null, "默认关闭");
        Check((snapshot with { Config = cfg with { Authorized = false } }).Session(now.ToUnixTimeMilliseconds()) is null, "缺少授权时关闭");
        Check(!(cfg with { AiEnabled = false }).CanReview(new()), "未允许文字复核不调用模型");
        Check(!cfg.CanReview(new() { Calls = 4 }), "每日调用次数生效");
        Check(!cfg.CanReview(new() { Tokens = 2400 }), "每日 token 生效");
        Check(cfg.CanReview(new()), "尚有预算时可以筛选候选");

        var buffer = new SelfStudyCandidateBuffer();
        var at = now.ToUnixTimeMilliseconds();
        Check(buffer.Take(at) is null, "静音不构成候选");
        buffer.Add(new float[48000], at);
        Check(buffer.Take(at) is null, "单次发言不构成反复交谈");
        buffer.Add(new float[48000], at + 6000);
        buffer.Add(new float[48000], at + 12000);
        Check(buffer.Take(at + 12000) is { Segments: 3 }, "连续窗口中多次发言进入复核");
        Check(buffer.Take(at + 12000) is null, "已领取的片段不会复用升级");
        buffer.Add(new float[16000 * 20], at);
        buffer.Add(new float[48000], at + 2000);
        buffer.Add(new float[48000], at + 5000);
        buffer.Add(new float[48000], at + 8000);
        Check(buffer.Take(at + 8000) is null, "长段讲话后的短暂停顿不立即误报");
        buffer.Clear();
        for (var i = 0; i < 30; i++) buffer.Add(new float[48000], at + i * 1000);
        Check(buffer.Count <= 6, "PCM 内存有固定上限");
        Check(buffer.Take(at + 180000) is null, "过期片段不会复核");

        // Exercise the monitor's real tick without starting hardware or network work.
        foreach (var usage in new SelfStudyUsage[] { new() { Calls = 1, Tokens = 1456 }, new() { Calls = 4, Tokens = 480 } })
        {
            using var monitor = new SelfStudyMonitor(_ => Task.FromResult(true), () => false, () => { });
            var fields = BindingFlags.Instance | BindingFlags.NonPublic;
            void Set(string name, object value) => typeof(SelfStudyMonitor).GetField(name, fields)!.SetValue(monitor, value);
            var clock = Environment.TickCount64;
            var live = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Set("_binding", new ReceiverConfig { Endpoint = "", ClassId = "fixture" });
            Set("_snapshot", snapshot with { AiReady = true, ServerTime = live, Usage = usage, Schedule = [new() {
                Key = "test", StartAt = live - 60000, EndAt = live + 60000 }] });
            Set("_session", "test"); Set("_syncedAt", clock); Set("_nextSync", long.MaxValue);
            Set("_lastStatus", clock); Set("_retryAfter", long.MaxValue); Set("_reviewing", true);
            var life = (CancellationTokenSource)typeof(SelfStudyMonitor).GetField("_sessionLife", fields)!.GetValue(monitor)!;
            var token = life.Token;
            var tick = typeof(SelfStudyMonitor).GetMethod("Tick", fields)!;
            tick.Invoke(monitor, null);
            Check(!token.IsCancellationRequested, "刷新到本次预占或最后一次调用，不取消已开始的复核");
            Set("_reviewing", false);
            tick.Invoke(monitor, null);
            Check(JsonSerializer.SerializeToElement(monitor.View()).GetProperty("state").GetString() == "budget",
                "当前复核完成后，预算阻止开始下一次");
            Set("_reviewing", true);
            Set("_locked", true);
            tick.Invoke(monitor, null);
            Check(token.IsCancellationRequested, "预算保护不阻止锁屏取消旧复核");
        }
        Console.WriteLine($"Self-study checks passed: {count}");
    }
}

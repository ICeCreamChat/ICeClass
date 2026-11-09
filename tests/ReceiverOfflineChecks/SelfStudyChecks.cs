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
        Check(SelfStudyCamera.IsCaptureOrigin("https://selfstudy.iceclass.local/"), "摄像头权限接受 WebView2 返回的来源地址");
        Check(SelfStudyCamera.IsCaptureOrigin("https://selfstudy.iceclass.local/capture"), "拍照页面属于获准来源");
        foreach (var untrusted in new[] { "https://selfstudy.iceclass.local.evil.example/capture", "http://selfstudy.iceclass.local/",
            "https://selfstudy.iceclass.local:444/", "https://selfstudy.iceclass.local@evil.example/", "not-a-url", "" })
            Check(!SelfStudyCamera.IsCaptureOrigin(untrusted), "摄像头不授权其他来源：" + untrusted);
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

        using (var monitor = new SelfStudyMonitor(_ => Task.FromResult(true), () => false, () => { }))
        {
            var flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var changed = typeof(SelfStudyMonitor).GetEvent("StateChanged", flags);
            Check(changed is not null, "晚自习关键状态可以通知浮岛");
            var notices = new List<(string State, string Detail)>();
            Action<string, string> receive = (state, detail) => notices.Add((state, detail));
            changed!.GetAddMethod(true)!.Invoke(monitor, [receive]);
            void State(string state, string detail) => typeof(SelfStudyMonitor).GetMethod("SetState", flags)!.Invoke(monitor, [state, detail]);
            State("error", "未绑定时同步失败");
            State("inactive", "默认未启用");
            Check(notices.Count == 0, "未启用功能时不弹出同步故障通知");
            State("observing", "开始观察");
            Check(notices.Count == 1 && notices[^1].State == "observing", "正式开始监测时通知教室");
            State("teaching", "正常讲题"); State("observing", "证据不足继续观察");
            Check(notices.Count == 1, "学习交流和常规观察不反复打断课堂");
            State("warning", "已提醒");
            Check(notices.Count == 1, "首次提醒仍由实际展示回执路径负责，不重复通知");
            State("reported", "已通知班主任"); State("reported", "已通知班主任");
            Check(notices.Count == 2 && notices[^1].State == "reported", "已上报状态只发布一次");
            State("observing", "已恢复安静");
            Check(notices.Count == 3 && notices[^1].Detail == "已恢复安静", "提醒后恢复安静也有状态反馈");
            monitor.Pause();
            Check(notices.Count == 4 && notices[^1].State == "paused", "手动暂停通过相同的状态通知入口");
            State("budget", "今日预算不足");
            Check(notices.Count == 5 && notices[^1].State == "budget", "预算耗尽通知教室");
            State("observing", "恢复观察"); State("error", "麦克风异常");
            Check(notices.Count == 7 && notices[^1].State == "error", "运行中的故障通知教室");
            State("observing", "恢复观察"); State("inactive", "语音功能占用麦克风");
            Check(notices.Count == 9 && notices[^1].State == "inactive", "监测中断通知教室");
        }

        var buffer = new SelfStudyCandidateBuffer();
        var at = now.ToUnixTimeMilliseconds();
        Check(buffer.Take(at) is null, "静音不构成候选");
        BanbanSpeechAudio Audio(int speechMs, int capturedMs, bool silent = false, bool padded = true) =>
            new(silent ? new float[capturedMs * 16 + (padded ? 4000 : 0)] : Enumerable.Repeat(.08f, capturedMs * 16 + (padded ? 4000 : 0)).ToArray(),
                true, SpeechSamples: speechMs * 16, CapturedSamples: capturedMs * 16);
        buffer.Add(Audio(0, 3000, true), at);
        buffer.Add(Audio(0, 3000, true), at + 6000);
        buffer.Add(Audio(0, 3000, true), at + 12000);
        Check(buffer.Take(at + 12000) is null, "三段纯静音不能被当成人声送去付费复核");
        buffer.Clear();
        buffer.Add(Audio(2000, 3000), at);
        Check(buffer.Take(at) is null, "单次发言不构成反复交谈");
        buffer.Add(Audio(2000, 3000), at + 6000);
        buffer.Add(Audio(2000, 3000), at + 12000);
        var candidate = buffer.Take(at + 12000);
        Check(candidate is { Segments: 3, SpeechMs: 6000, LongestMs: 2000 }, "有效人声达到门槛，保留三次独立发言");
        Check(candidate!.Clips[0].EndAt == at && candidate.Clips[1].StartAt == at + 3000,
            "采集时间保留真实间隔，解码补零不计时间");
        Check(buffer.Take(at + 12000) is null, "已领取的片段不会复用升级");
        for (var i = 0; i < 3; i++) buffer.Add(Audio(2000, 3000), at + i * 6000);
        Check(buffer.Take(at + 12000, 30) is null && buffer.Count == 3,
            "老师设置较长观察时间时，短窗口不能提前领取或提交AI");
        for (var i = 3; i < 6; i++) buffer.Add(Audio(2000, 3000), at + i * 6000);
        Check(buffer.Take(at + 30000, 30) is { Segments: 6, SpeechMs: 12000 },
            "观察达到老师设置的时间后才领取完整且有界的语音窗口");
        buffer.Clear();
        buffer.Add(Audio(200, 2200), at);
        buffer.Add(Audio(200, 2200), at + 6000);
        buffer.Add(Audio(200, 2200), at + 12000);
        Check(buffer.Take(at + 12000) is null, "600毫秒短问答不能借前后静音累计成6600毫秒人声");
        buffer.Clear();
        buffer.Add(Audio(3000, 4000), at);
        buffer.Add(Audio(3000, 4000), at + 2000);
        Check(buffer.Count == 1, "重叠音频清除旧窗口，不能重复累计");
        buffer.Clear();
        for (var i = 0; i < 30; i++) buffer.Add(Audio(2000, 3000), at + i * 4000);
        Check(buffer.Count <= 6, "PCM 内存有固定上限");
        Check(buffer.Take(at + 180000) is null, "过期片段不会复核");
        buffer.Clear();
        for (var i = 0; i < 6; i++) buffer.Add(Audio(1100, 6000), at + i * 6000);
        Check(buffer.Take(at + 30000) is { Segments: 6, SpeechMs: 6600 },
            "六段含停顿语音在一分钟内累计超过六秒时不被额外PCM长度门槛清除");
        for (var i = 0; i < 6; i++) buffer.Add(Audio(2500, 4000), at + i * 6000);
        var recent = buffer.Take(at + 30000);
        Check(recent is { Segments: 3, SpeechMs: 7500 } && recent.StartAt == at + 14000,
            "冷却后取满足时长要求的最新完整窗口，避免无谓累计六段导致转写超限");
        buffer.Clear();
        buffer.Add(Audio(2000, 2000), at);
        buffer.Add(Audio(2000, 2000), at + 3000);
        buffer.Add(Audio(2000, 2000), at + 6000);
        Check(buffer.Take(at + 20000) is null, "等待时间不能把八秒采集窗口伪装成十秒窗口");

        using (var segmenter = new BanbanSpeechSegmenter(detectSpeech: s => s[0] > 0))
        {
            BanbanSpeechAudio? segment = null;
            for (var i = 0; i < 16; i++) segmenter.Accept(new float[800]);
            for (var i = 0; i < 4; i++) segmenter.Accept(Enumerable.Repeat(.1f, 800).ToArray());
            for (var i = 0; i < 20; i++) segment = segmenter.Accept(new float[800]) ?? segment;
            Check(segment is { SpeechSamples: 3200, CapturedSamples: 31200 }, "真实分段只计200毫秒VAD人声，排除前后静音");
            Check(segment!.Samples.Length == segment.CapturedSamples + 4000, "解码补零单独保留，不冒充采集时间");
        }
        using (var segmenter = new BanbanSpeechSegmenter(8 * 16000, continuous: true, detectSpeech: _ => true))
        {
            var chunks = new List<BanbanSpeechAudio>();
            for (var i = 0; i < 480; i++)
                if (segmenter.Accept(Enumerable.Repeat(.1f, 800).ToArray()) is { } chunk) chunks.Add(chunk);
            Check(chunks.Count == 3 && chunks.All(c => !c.TooLong && c.SpeechSamples == 8 * 16000),
                "连续讲话形成有界独立片段，不按长度猜老师身份或丢弃长交谈");
        }
        using (var segmenter = new BanbanSpeechSegmenter(detectSpeech: s => s[0] > 0))
        {
            var chunks = new List<BanbanSpeechAudio>();
            for (var i = 0; i < 800; i++)
                if (segmenter.Accept(Enumerable.Repeat(.1f, 800).ToArray()) is { } chunk) chunks.Add(chunk);
            Check(chunks.Count == 1 && chunks[0].TooLong && chunks[0].Samples.Length == 0,
                "普通助手仍丢弃超过30秒的整段指令，不能执行被截断的开头");
        }

        var gate = new SelfStudyNoiseGate();
        var background = Enumerable.Repeat(.02f, 800).ToArray();
        for (var i = 0; i < 100; i++) gate.Accept(background, false);
        Check(!gate.Accept(background, false), "非语音不被能量判断提升成人声");
        Check(!gate.Accept(background, true), "持续背景底噪不能仅因VAD阳性进入有效人声");
        Check(gate.Accept(Enumerable.Repeat(.04f, 800).ToArray(), true), "高于背景的VAD人声正常进入");
        Check(gate.Accept(Enumerable.Repeat(.025f, 800).ToArray(), true), "退出迟滞保留轻微音量下降");
        Check(!gate.Accept(background, true), "低于退出门槛时停止有效人声");
        foreach (var sensitivity in new[] { "low", "balanced", "high" })
        {
            var adjusted = new SelfStudyNoiseGate(sensitivity);
            for (var i = 0; i < 100; i++) adjusted.Accept(background, false);
            Check(!adjusted.Accept(Enumerable.Repeat(.04f, 800).ToArray(), false),
                "任何灵敏度都不能把非人声提升为有效语音：" + sensitivity);
            // Recalibrate to the same measured background before comparing gates.
            adjusted.Reset();
            for (var i = 0; i < 100; i++) adjusted.Accept(background, false);
            Check(adjusted.Accept(Enumerable.Repeat(.026f, 800).ToArray(), true) == (sensitivity == "high"),
                "灵敏度实际改变相对底噪门槛，仍依赖VAD：" + sensitivity);
        }

        var decoded = new List<float[]>();
        var texts = new Queue<string>(["这道题先移项再求解", "为什么这个系数要变号", "等式两边同时除以这个数"]);
        var utterances = SelfStudyMonitor.Transcribe(candidate!, samples => { decoded.Add(samples); return texts.Dequeue(); }, default);
        Check(utterances.Length == 3 && decoded.Select((s, i) => ReferenceEquals(s, candidate!.Clips[i].Samples)).All(x => x),
            "逐段识别保留三次学习问答，不拼接PCM伪造连续话语");
        Check(utterances[1].Text == "为什么这个系数要变号" && utterances[1].StartAt == candidate!.Clips[1].StartAt,
            "转写与原片段时间一一对应");
        using (var cancelled = new CancellationTokenSource())
        {
            var calls = 0;
            try
            {
                SelfStudyMonitor.Transcribe(candidate!, _ => { calls++; cancelled.Cancel(); return "取消后丢弃这句话"; }, cancelled.Token);
                throw new InvalidOperationException("取消后仍返回转写");
            }
            catch (OperationCanceledException) { Check(calls == 1, "取消后不再解码后续片段，不上传旧结果"); }
        }
        Check(SelfStudyMonitor.Transcribe(candidate!, _ => "", default).Length == 0, "任一片段解码为空时放弃整个不完整窗口");
        var unevenTexts = new Queue<string>([new string('学', 45) + "这道题", "先看条件", "明白了谢谢老师"]);
        var uneven = SelfStudyMonitor.Transcribe(candidate!, _ => unevenTexts.Dequeue(), default);
        Check(uneven.Length == 3 && uneven[0].Text.EndsWith("这道题") && uneven[0].Text.Length == 48,
            "总字数未超限时保留完整长语句，不能按段均分截掉学习线索");
        Check(SelfStudyMonitor.Transcribe(candidate!, _ => new string('学', 45) + "这道题", default).Length == 0,
            "完整转写超过总上限时放弃复核，不上传截断后改变语境的残句");

        // Exercise the real Segment path across backwards/forwards server-clock corrections.
        using (var monitor = new SelfStudyMonitor(_ => Task.FromResult(true), () => false, () => { }))
        {
            var fields = BindingFlags.Instance | BindingFlags.NonPublic;
            void Set(string name, object value) => typeof(SelfStudyMonitor).GetField(name, fields)!.SetValue(monitor, value);
            var clock = Environment.TickCount64;
            var serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Set("_syncedAt", clock); Set("_snapshot", snapshot with { ServerTime = serverTime });
            Set("_nextReview", long.MaxValue);
            Set("_analysisEnabled", true);
            // Only the null guard is needed; never construct/start hardware in this arithmetic test.
            Set("_audio", System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SelfStudyAudio)));
            try
            {
                var segment = typeof(SelfStudyMonitor).GetMethod("Segment", fields)!;
                for (var i = 0; i < 3; i++)
                {
                    Set("_snapshot", snapshot with { ServerTime = serverTime + (i == 1 ? -350 : i == 2 ? 1 : 0) });
                    segment.Invoke(monitor, [Audio(8000, 8000, padded: false) with { EndedAtTicks = clock - 16000 + i * 8000 }, 0]);
                }
                var collected = (SelfStudyCandidateBuffer)typeof(SelfStudyMonitor).GetField("_buffer", fields)!.GetValue(monitor)!;
                Check(collected.Count == 3, "服务端校时前后跳动不清空真实连续人声");
                var stable = collected.Take(clock);
                Check(stable is { Segments: 3 } && stable.EndAt - stable.StartAt == 24000,
                    "跨同步的连续声音仍构成24秒独立窗口");
                var mapped = stable!.AtServerTime(serverTime, clock);
                Check(mapped.EndAt == serverTime && mapped.StartAt == serverTime - 24000 &&
                    mapped.Clips.Zip(mapped.Clips.Skip(1)).All(p => p.First.EndAt == p.Second.StartAt),
                    "整个候选统一映射到服务端时间，分段间隔保持不变");
            }
            finally { typeof(SelfStudyMonitor).GetField("_audio", fields)!.SetValue(monitor, null); }
        }

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
            var capture = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SelfStudyAudio));
            Set("_audio", capture);
            tick.Invoke(monitor, null);
            Check(JsonSerializer.SerializeToElement(monitor.View()).GetProperty("state").GetString() == "budget",
                "当前复核完成后，预算阻止开始下一次");
            Check(ReferenceEquals(typeof(SelfStudyMonitor).GetField("_audio", fields)!.GetValue(monitor), capture) &&
                !token.IsCancellationRequested, "预算暂停保留原麦克风和会话，不停止本地声波");
            Set("_audio", null!);
            Set("_reviewing", true);
            Set("_locked", true);
            tick.Invoke(monitor, null);
            Check(token.IsCancellationRequested, "预算保护不阻止锁屏取消旧复核");
        }
        SelfStudyFeedbackChecks.Run();
        Console.WriteLine($"Self-study checks passed: {count}");
    }
}

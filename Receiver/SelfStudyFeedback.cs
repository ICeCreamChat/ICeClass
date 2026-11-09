namespace ICeClass.Receiver;

/// <summary>Local presentation only. Levels are relative microphone energy, never calibrated dB or a misconduct score.</summary>
internal sealed record SelfStudyFeedback(string State, string Detail, bool Capturing, bool Reminder = false, string Alert = "")
{
    internal int ObservationSeconds { get; init; } = 10;
    internal string Phase => Reminder ? "warning" : State;
    // The current operation and an already-confirmed reminder are independent.
    // New observation/analysis must not erase the reminder that actually appeared.
    internal string Attention => Phase switch
    {
        "warning" or "reported" => Phase,
        "listening" or "observing" or "analyzing" => Alert,
        _ => ""
    };
    internal string Label => Phase switch
    {
        "listening" => "感知中", "observing" => "正在观察", "analyzing" => "AI 复核中",
        "teaching" => "学习交流", "warning" => "已轻提醒", "reported" => "已通知老师",
        "budget" or "ai_paused" => "AI 复核已暂停", "paused" => "本节已暂停",
        "error" => "采集已停止", _ => "监测暂歇"
    };
    internal string Caption => Phase switch
    {
        "listening" => Attention == "reported" ? "已通知老师，持续感知声音" : "正在感知教室声音",
        "observing" => Attention switch { "warning" => "正在观察提醒后的新声音", "reported" => "已通知老师，持续感知声音", _ => "声音持续，正在观察" },
        "analyzing" => Attention == "warning" ? "正在重新复核交流内容…" : "正在复核交流内容…",
        "teaching" => "学习交流，继续自主学习",
        "warning" => Reminder ? "请降低交谈音量，保持专注" : "已轻声提醒，继续观察",
        "reported" => "已通知老师，等待现场核实",
        "budget" => "AI 额度不足，声波继续",
        "ai_paused" => "AI 复核已暂停，声波继续",
        "paused" => "本节已暂停，声音采集已停止",
        "error" => "声音采集已停止，请检查设置",
        _ => "监测暂歇，等待恢复"
    };
    internal string ShortLabel => Phase switch
    {
        "listening" => "感知中", "observing" => "观察中", "analyzing" => "复核中",
        "teaching" => "学习交流", "warning" => Reminder ? "请轻声" : "已提醒",
        "reported" => "已通知", "budget" or "ai_paused" => "AI 暂停",
        "paused" => "已暂停", "inactive" => "暂歇中", "error" => "采集故障", _ => "已停止"
    };
    internal string AccessibleText => string.Join("，", new[] { Label, Caption, Detail }.Distinct());
}

internal sealed record SelfStudySound(double Level, bool Speech);

internal static class SelfStudySoundMeter
{
    internal static double Measure(float[] samples)
    {
        if (samples.Length == 0) return 0;
        double energy = 0;
        foreach (var sample in samples) energy += (double)sample * sample;
        var rms = Math.Sqrt(energy / samples.Length);
        return double.IsFinite(rms) ? Math.Clamp(Math.Log10(1 + rms * 40) / Math.Log10(41), 0, 1) : 0;
    }
}

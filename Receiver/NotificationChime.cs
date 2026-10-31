using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace ICeClass.Receiver;

internal enum NotificationCue { None, Important, Urgent }

/// <summary>A short notification cue and pause, read through the same output as its original speech.</summary>
internal sealed class NotificationChime : ISampleProvider
{
    private readonly ISampleProvider _speech;
    private readonly float[] _prefix;
    private int _position;
    public WaveFormat WaveFormat => _speech.WaveFormat;
    internal double SpeechOffsetSeconds => (double)_prefix.Length / WaveFormat.SampleRate / WaveFormat.Channels;

    internal static NotificationCue ForLevel(string level) => level switch
    {
        "warning" => NotificationCue.Important,
        "urgent" => NotificationCue.Urgent,
        _ => NotificationCue.None,
    };

    internal static ISampleProvider Prepend(ISampleProvider speech, NotificationCue cue)
        => cue == NotificationCue.None ? speech : new NotificationChime(speech, cue);

    private NotificationChime(ISampleProvider speech, NotificationCue cue)
    {
        _speech = speech;
        var name = cue switch
        {
            NotificationCue.Important => "notification-important.wav",
            NotificationCue.Urgent => "notification-urgent.wav",
            _ => throw new ArgumentOutOfRangeException(nameof(cue)),
        };
        using var resource = typeof(NotificationChime).Assembly.GetManifestResourceStream("ICeClass.Notification." + name)
            ?? throw new InvalidDataException("缺少通知提示音。");
        using var reader = new WaveFileReader(resource);
        if (reader.WaveFormat.Channels != WaveFormat.Channels)
            throw new InvalidDataException("通知提示音声道不匹配。");
        ISampleProvider source = reader.ToSampleProvider();
        if (source.WaveFormat.SampleRate != WaveFormat.SampleRate)
            source = new WdlResamplingSampleProvider(source, WaveFormat.SampleRate);
        var samples = new List<float>();
        var buffer = new float[1024];
        int read;
        while ((read = source.Read(buffer, 0, buffer.Length)) > 0) samples.AddRange(buffer.AsSpan(0, read).ToArray());
        _prefix = new float[samples.Count + (int)Math.Round(WaveFormat.SampleRate * .2) * WaveFormat.Channels];
        samples.CopyTo(_prefix);
    }

    public int Read(float[] buffer, int offset, int count)
    {
        var copied = Math.Min(count, _prefix.Length - _position);
        _prefix.AsSpan(_position, copied).CopyTo(buffer.AsSpan(offset, copied));
        _position += copied;
        return copied + (copied < count ? _speech.Read(buffer, offset + copied, count - copied) : 0);
    }
}

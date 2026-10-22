using System.Globalization;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;

namespace ICeClass.Receiver;

// Two measured lines inside the widened island. The complete text is always
// available through the existing explicit full-text action.
internal sealed class IslandImportantMessage : Control
{
    private ClassroomIslandNotice? _notice;
    public bool Light { get; set; } = true;
    public IslandImportantMessage() { Height = 104; IsHitTestVisible = false; }
    public void Update(ClassroomIslandNotice notice) { _notice = notice; InvalidateVisual(); }
    internal bool NeedsExpansion(double surfaceWidth)
    {
        if (_notice is null) return false;
        if (_notice.Text.IndexOfAny(['\r', '\n']) >= 0) return true;
        var text = new FormattedText(_notice.Text, CultureInfo.GetCultureInfo("zh-CN"), FlowDirection.LeftToRight,
            new Typeface(ClassroomStyle.Font, FontStyle.Normal, FontWeight.Bold), 20, Brushes.Black);
        return text.WidthIncludingTrailingWhitespace > Math.Max(1, surfaceWidth - 40);
    }
    public override void Render(DrawingContext context)
    {
        if (_notice is not { } notice || Bounds.Width < 1) return;
        var width = Math.Max(1, Bounds.Width - 40);
        var urgent = notice.Level == "urgent";
        var ink = Light ? urgent ? "#793B46" : "#344D63" : "#F4EEE4";
        var muted = Light ? urgent ? "#874B55" : "#705B38" : "#DECBA8";
        FormattedText Format(string value, double size, string color) => new(value, CultureInfo.GetCultureInfo("zh-CN"), FlowDirection.LeftToRight,
            new Typeface(ClassroomStyle.Font, FontStyle.Normal, FontWeight.Bold), size, new SolidColorBrush(Color.Parse(color)));
        var lines = IslandShoutText.Pages(notice.Text, width, text => Format(text, 20, ink).WidthIncludingTrailingWhitespace);
        var count = (lines.Count + 1) / 2;
        var page = (int)(Math.Max(0, notice.AgeSeconds - IslandShoutText.CueSecondsFor(notice.Level)) / IslandShoutText.PageSeconds) % count;
        for (var line = 0; line < 2 && page * 2 + line < lines.Count; line++)
            context.DrawText(Format(lines[page * 2 + line], 20, ink), new Point(20, 12 + line * 28));
        var hint = count > 1 ? $"{page + 1}/{count} · 点击岛条查看全文" : "点击岛条查看全文";
        context.DrawText(Format(hint, 12, muted), new Point(20, 74));
        var track = new Rect(20, 96, width, 2);
        using (context.PushClip(new RoundedRect(track, 1)))
        {
            context.DrawRectangle(new SolidColorBrush(Color.Parse(Light ? urgent ? "#F0DDE0" : "#EEE5D5" : urgent ? "#68414A" : "#64543C")), null, track);
            context.DrawRectangle(new SolidColorBrush(Color.Parse(urgent ? "#DD7D82" : "#D9A64A")), null, track.WithWidth(width * Math.Clamp(notice.Progress, 0, 1)));
        }
    }
}

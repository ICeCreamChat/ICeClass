using System.Globalization;

namespace ICeClass.Receiver;

internal static class IslandShoutText
{
    private const string ClosingPunctuation = "，。；：、！？,.!?;:)]}）】》〉」』〕〗〙〛%％…";
    internal const double CueSeconds = 2.2;
    internal const double PageSeconds = 4;
    internal static double CueSecondsFor(string level) => level == "urgent" ? 0 : level == "warning" ? 1.6 : CueSeconds;

    // Keep complete text elements, including surrogate pairs and combining marks.
    // All pages are available in the island's full-text view, even when a long
    // message cannot finish cycling before the sender's original deadline.
    public static IReadOnlyList<string> Pages(string text, double width, Func<string, double> measure)
    {
        text = text.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' ');
        var pages = new List<string>();
        var page = "";
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            var next = elements.GetTextElement();
            if (page.Length > 0 && measure(page + next) > Math.Max(1, width))
            {
                // Prefer a clause or word boundary in the latter half of the
                // line, so a short ending is not left on a page of its own.
                var split = page.Length;
                var candidates = StringInfo.GetTextElementEnumerator(page);
                while (candidates.MoveNext())
                {
                    var element = candidates.GetTextElement();
                    var end = candidates.ElementIndex + element.Length;
                    if ((string.IsNullOrWhiteSpace(element) || "，。；：、！？,.!?;:".Contains(element, StringComparison.Ordinal))
                        && measure(page[..end]) >= Math.Max(1, width) * .45)
                        split = end;
                }
                // A full line can leave its comma at the start of the next
                // line. Carry the preceding complete text element with it.
                var remainder = page[split..] + next;
                if (ClosingPunctuation.Contains(remainder[0]))
                {
                    var starts = StringInfo.ParseCombiningCharacters(page[..split]);
                    var previous = starts.Length - 1;
                    while (previous > 0 && ClosingPunctuation.Contains(page[starts[previous]])) previous--;
                    var adjusted = starts[previous];
                    if (adjusted > 0 && measure(page[adjusted..] + next) <= Math.Max(1, width)) split = adjusted;
                }
                pages.Add(page[..split]); page = page[split..];
            }
            page += next;
        }
        if (page.Length > 0) pages.Add(page);
        return pages.Count > 0 ? pages : [""];
    }
}

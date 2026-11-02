namespace ICeClass.Receiver;

/// <summary>Complete offline builds embed these files; incremental cores reuse a verified adjacent resource folder.</summary>
internal static class VoiceResourceFiles
{
    internal static Stream? Open(string logicalName)
    {
        var embedded = typeof(VoiceResourceFiles).Assembly.GetManifestResourceStream(logicalName);
        if (embedded is not null) return embedded;
        var path = PathForResource(logicalName);
        return path is not null && File.Exists(path) ? File.OpenRead(path) : null;
    }
    internal static Stream? OpenUpdateResource(string path)
    {
        if (!path.StartsWith("VoiceResources/", StringComparison.Ordinal)) return null;
        return Open("ICeClass.Voice." + path["VoiceResources/".Length..].Replace('/', '.'));
    }
    private static string? PathForResource(string name)
    {
        const string prefix = "ICeClass.Voice.";
        if (!name.StartsWith(prefix, StringComparison.Ordinal)) return null;
        var relative = name[prefix.Length..];
        foreach (var folder in new[] { "Asr", "Tts", "Vad", "Speaker" })
            if (relative.StartsWith(folder + ".", StringComparison.Ordinal)) { relative = folder + "/" + relative[(folder.Length + 1)..]; break; }
        if (!ICeClass.Updates.IncrementalUpdates.ValidTarget("VoiceResources/" + relative, "ICeClass.exe")) return null;
        return ICeClass.Updates.IncrementalUpdates.SafePath(AppContext.BaseDirectory, "VoiceResources/" + relative);
    }
}

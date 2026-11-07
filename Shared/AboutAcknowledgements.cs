using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ICeClass.About;

internal sealed record AcknowledgementSection(string Title, string Body);
internal sealed record AcknowledgementsDocument(int Revision, AcknowledgementSection[] Sections);

internal sealed class AboutAcknowledgementsClient
{
    private const int MaximumBytes = 32768;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(8) };
    private readonly string _endpoint;
    private readonly string _cachePath;
    private static readonly Lazy<AcknowledgementsDocument> Bundled = new(() =>
    {
        using var source = typeof(AboutAcknowledgementsClient).Assembly.GetManifestResourceStream("ICeClass.About.acknowledgements.json")
            ?? throw new InvalidOperationException("应用致谢内容缺失。");
        return Parse(new StreamReader(source).ReadToEnd());
    });
    internal static AcknowledgementsDocument Default => Bundled.Value;

    internal AboutAcknowledgementsClient(string endpoint, string? cacheDirectory = null)
    {
        if (!Uri.TryCreate(endpoint.TrimEnd('/') + "/", UriKind.Absolute, out var uri)
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)
            || !(uri.Scheme == "https" || uri.Scheme == "http" && uri.IsLoopback))
            throw new ArgumentException("平台网址不正确。", nameof(endpoint));
        _endpoint = uri.AbsoluteUri.TrimEnd('/');
        var directory = cacheDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ICeClass", "About");
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_endpoint)));
        _cachePath = Path.Combine(directory, key + ".json");
    }

    internal AcknowledgementsDocument ReadCached()
    {
        try
        {
            if (new FileInfo(_cachePath) is { Exists: true, Length: <= MaximumBytes })
                return Parse(File.ReadAllText(_cachePath));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException) { }
        return Default;
    }

    internal async Task<AcknowledgementsDocument> RefreshAsync(CancellationToken token)
    {
        using var response = await Http.GetAsync(_endpoint + "/api/about/acknowledgements", HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaximumBytes) throw new InvalidDataException("致谢内容过长。");
        await using var source = await response.Content.ReadAsStreamAsync(token);
        using var bytes = new MemoryStream();
        var buffer = new byte[4096];
        int read;
        while ((read = await source.ReadAsync(buffer, token)) > 0)
        {
            if (bytes.Length + read > MaximumBytes) throw new InvalidDataException("致谢内容过长。");
            bytes.Write(buffer, 0, read);
        }
        var text = Encoding.UTF8.GetString(bytes.ToArray());
        var document = Parse(text);
        token.ThrowIfCancellationRequested();
        var temporary = _cachePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_cachePath)!);
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(document, Json), token);
            token.ThrowIfCancellationRequested();
            File.Move(temporary, _cachePath, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* Display fresh content even when the local cache is read-only. */ }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return document;
    }

    private static AcknowledgementsDocument Parse(string text)
    {
        using var source = JsonDocument.Parse(text);
        var root = source.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("revision", out var revision) || revision.ValueKind != JsonValueKind.Number || !revision.TryGetInt32(out _)
            || !root.TryGetProperty("sections", out var sections) || sections.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("致谢内容格式不正确。");
        var result = root.Deserialize<AcknowledgementsDocument>(Json);
        if (result is null || result.Revision < 0 || result.Sections is null || result.Sections.Length is < 1 or > 8)
            throw new InvalidDataException("致谢内容格式不正确。");
        var total = 0;
        foreach (var section in result.Sections)
        {
            if (section is null || string.IsNullOrWhiteSpace(section.Title) || section.Title.Length > 80
                || section.Title.Any(c => c < 32) || string.IsNullOrWhiteSpace(section.Body) || section.Body.Length > 4000
                || section.Body.Any(c => c < 32 && c is not ('\n' or '\t')))
                throw new InvalidDataException("致谢分组格式不正确。");
            total += section.Title.Length + section.Body.Length;
        }
        if (total > 6000) throw new InvalidDataException("致谢内容过长。");
        return result;
    }
}

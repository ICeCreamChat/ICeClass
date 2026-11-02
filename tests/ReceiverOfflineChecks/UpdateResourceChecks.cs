using System.Net;
using System.Text.Json;
using ICeClass.Receiver;
using ICeClass.Updates;

internal static class UpdateResourceChecks
{
    internal static async Task Run(string releaseDirectory, string output)
    {
        var source = JsonSerializer.Deserialize<UpdatePlan>(File.ReadAllText(Path.Combine(releaseDirectory, "update-plan.json")), IncrementalUpdates.Json)!;
        var plan = source with { Available = true, Files = source.Files.Select(f => f with { DownloadUrl = "/payload/" + f.Sha256 }).ToList() };
        var install = Path.GetFullPath(output);
        Directory.CreateDirectory(install);
        var existing = Path.Combine(install, "ICeClass.exe");
        if (File.Exists(existing)) throw new InvalidOperationException("Use a new empty resource review directory.");
        File.WriteAllText(existing, "previous full offline application");
        var transport = new Payloads(Path.GetFullPath(Path.Combine(releaseDirectory, "payloads")));
        using var client = new HttpClient(transport);
        var prepared = await IncrementalUpdates.PrepareAsync(new Uri("https://school.example/"), plan, install,
            "ICeClass.exe", client, "fixture", VoiceResourceFiles.OpenUpdateResource, null, default);
        if (transport.Requests.Count != 1 || transport.Requests[0] != "/payload/" + plan.Files[0].Sha256)
            throw new Exception("Full offline resources caused redundant network downloads.");
        if (prepared.Files.Count != plan.Files.Count || File.ReadAllText(existing) != "previous full offline application")
            throw new Exception("Resource preparation changed installed files or lost a required file.");
        var resources = prepared.Files.Where(f => f.Path.StartsWith("VoiceResources/")).ToList();
        foreach (var file in resources)
        {
            if (!IncrementalUpdates.MatchesAsync(file.StagedPath, file.Size, file.Sha256, default).GetAwaiter().GetResult())
                throw new Exception("A bundled resource did not match its release payload.");
        }
        var report = new {
            passed = true, version = plan.Version, requiredFiles = plan.Files.Count,
            modelRequests = 0, applicationRequests = transport.Requests.Count,
            reusedResourceBytes = resources.Sum(f => f.Size), applicationBytes = plan.Files[0].Size,
            preservedOriginal = true, readyForNextStartup = UpdateInstaller.LoadPending(install, "ICeClass.exe")?.Version == plan.Version
        };
        File.WriteAllText(Path.Combine(install, "resource-review.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(report));
    }

    private sealed class Payloads(string directory) : HttpMessageHandler
    {
        internal List<string> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.Headers.Authorization?.ToString() != "Bearer fixture") throw new Exception("Missing classroom authentication.");
            Requests.Add(request.RequestUri!.AbsolutePath);
            var hash = request.RequestUri!.AbsolutePath["/payload/".Length..];
            if (!IncrementalUpdates.ValidHash(hash)) throw new Exception("Invalid review payload.");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(File.OpenRead(Path.Combine(directory, hash))) });
        }
    }
}

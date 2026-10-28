using System.Text.Json;
using ICeClass.Receiver;

internal static class ComputerControlChecks
{
    internal static int Run(string root)
    {
        var checks = 0;
        void Check(bool result, string message) { if (!result) throw new Exception(message); checks++; }
        var folder = Path.Combine(root, "courseware"); Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "lesson.pptx"); File.WriteAllText(file, "fixture");
        var sibling = Path.Combine(root, "courseware-other"); Directory.CreateDirectory(sibling);
        var outside = Path.Combine(sibling, "lesson.pptx"); File.WriteAllText(outside, "fixture");
        var script = Path.Combine(folder, "not-a-lesson.ps1"); File.WriteAllText(script, "fixture");
        Check(new ClassroomAgentPolicy().FileAllowed(outside), "a new classroom installation can access a document without selecting its folder first");
        var policy = new ClassroomAgentPolicy { AllowAllFolders = false, Folders = [folder] };
        Check(policy.FileAllowed(file), "a courseware document inside an allowed root is accessible");
        Check(!policy.FileAllowed(outside), "a sibling sharing a folder prefix cannot escape the configured root");
        Check(!policy.FileAllowed(script), "scripts are not opened as courseware");
        Check(!policy.FileAllowed("lesson.pptx"), "relative file paths cannot select local files");
        Check(!policy.FileAllowed(Path.Combine(folder, "missing.pptx")), "missing courseware never passes validation");
        var launcher = Path.Combine(root, "launcher.exe");
        var runtime = Path.Combine(root, "application.exe");
        File.WriteAllText(launcher, "fixture"); File.WriteAllText(runtime, "fixture");
        var application = new AgentApplication("fixture", "fixture", "application", launcher, runtime);
        Check(application.MatchesPath(ClassroomAgentPolicy.ApplicationPath(runtime)), "a registered runtime belongs to its launcher application");
        Check(!application.MatchesPath(ClassroomAgentPolicy.ApplicationPath(outside)), "unrelated executables do not inherit a launcher's permission");
        var registration = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ICeClassFixture-" + Guid.NewGuid().ToString("N") + ".exe";
        try
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(registration)) key.SetValue("", Environment.ProcessPath!);
            Check(policy.Available().Any(app => app.MatchesPath(ClassroomAgentPolicy.ApplicationPath(Environment.ProcessPath!))),
                "standard Windows app registration discovers an unfamiliar installed application");
        }
        finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKey(registration, false); }
        foreach (var value in new[] { "file:///C:/Windows/notepad.exe", "javascript:alert(1)", "http://school.example", "https://127.0.0.1/", "https://user:secret@example.com/", "https://example.com/\n" })
        {
            try { ClassroomAgentService.Website(value); throw new Exception("unsafe website accepted"); }
            catch (InvalidOperationException) { checks++; }
        }
        Check(ClassroomAgentService.Website("https://example.com/lesson") == "https://example.com/lesson", "HTTPS course URLs preserve the requested path");
        var config = new ReceiverConfig { DeviceId = "device-one", ClassId = "class-one" };
        const long now = 1792900000000;
        JsonDocument Command(string did = "device-one", string cid = "class-one", long expires = now + 20000) => JsonDocument.Parse(JsonSerializer.Serialize(new
            { deviceId = did, classId = cid, issuedAt = now, expiresAt = expires, parameters = new { action = "inspect" } }));
        using (var valid = Command()) { ClassroomAgentService.ValidateEnvelope(valid.RootElement, config, now); checks++; }
        foreach (var invalid in new[] { Command("another-device"), Command(cid: "another-class"), Command(expires: now - 1), Command(expires: now + 60000) })
        {
            using (invalid)
            {
                try { ClassroomAgentService.ValidateEnvelope(invalid.RootElement, config, now); throw new Exception("wrong binding or expired command accepted"); }
                catch (InvalidOperationException) { checks++; }
            }
        }
        Console.WriteLine($"{checks} computer-control checks passed.");
        return checks;
    }
}

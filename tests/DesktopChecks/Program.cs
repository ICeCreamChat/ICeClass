using ICeClass.Desktop;
using System.Text;

if (args is ["--export-updater", var output])
{
    File.WriteAllText(output, DesktopUpdates.ApplyScript, new UTF8Encoding(true));
    return;
}

if (args is ["--voice-transcription-review", var audioPath, var modelFolder, var resultPath])
{
    var clock = System.Diagnostics.Stopwatch.StartNew();
    var text = await ClassroomVoiceTranscriber.TranscribeAsync(File.ReadAllBytes(audioPath), default, modelFolder);
    File.WriteAllText(resultPath, System.Text.Json.JsonSerializer.Serialize(new { text, elapsedMs = clock.ElapsedMilliseconds }), Encoding.UTF8);
    Console.WriteLine(text);
    return;
}

var checks = 0;
void Assert(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
void Reject(string address)
{
    try { DesktopSettings.NormalizeEndpoint(address); throw new Exception("Accepted unsafe address: " + address); }
    catch (ArgumentException) { checks++; }
}
Assert(DesktopSettings.NormalizeEndpoint(" HTTPS://ICECLASS.ICECREAMCHAT.TOP:443/ ") == DesktopSettings.DefaultEndpoint, "Canonical school address");
foreach (var value in new[] { "file:///C:/test.html", "http://school.example", "https://user:pass@school.example", "https://school.example/api", "https://school.example/?key=hidden", "https://school.example/#part" }) Reject(value);
Assert(DesktopSettings.NormalizeEndpoint("http://127.0.0.1:8838/") == "http://127.0.0.1:8838", "Local review allowed");
Assert(!DesktopSettings.SameOrigin(DesktopSettings.DefaultEndpoint, "https://iceclass.icecreamchat.top.attacker.example"), "External page cannot use school origin");
Assert(!DesktopSettings.SameOrigin(DesktopSettings.DefaultEndpoint, "http://iceclass.icecreamchat.top"), "No HTTPS downgrade");
Assert(!DesktopSettings.SameOrigin("http://127.0.0.1:8838", "http://127.0.0.1:8844"), "Local ports isolated");
Assert(DesktopSettings.SameOrigin(DesktopSettings.DefaultEndpoint, "https://iceclass.icecreamchat.top/reading/?preview=1"), "School child page allowed");
var temporary = Path.Combine(Path.GetTempPath(), "ICeClass-DesktopChecks-" + Guid.NewGuid().ToString("N"));
try
{
    var settings = new DesktopSettings { Endpoint = "http://127.0.0.1:8838", CloseToTray = true };
    settings.Save(temporary);
    var restored = DesktopSettings.Load(temporary);
    Assert(restored.Endpoint == settings.Endpoint && restored.CloseToTray, "Settings survive restart");
    restored.CloseToTray = false; restored.Save(temporary);
    Assert(!DesktopSettings.Load(temporary).CloseToTray, "Exit preference saved");
    Assert(DesktopSettings.ProfileDirectory(temporary, DesktopSettings.DefaultEndpoint) != DesktopSettings.ProfileDirectory(temporary, settings.Endpoint), "Production and review logins isolated");
    File.WriteAllText(Path.Combine(temporary, "settings.json"), "not json");
    Assert(DesktopSettings.Load(temporary).Endpoint == DesktopSettings.DefaultEndpoint, "Malformed settings recover");
}
finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
var currentVersion = Version.Parse(DesktopUpdates.CurrentVersion);
var nextVersion = new Version(currentVersion.Major, currentVersion.Minor, currentVersion.Build + 1).ToString(3);
var release = new DesktopRelease(nextVersion, new string('a', 64), 100, "/api/desktop/update/download");
Assert(DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release), "Valid native release");
Assert(!DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release with { DownloadUrl = "https://attacker.example/update.exe" }), "Foreign update rejected");
Assert(!DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release with { Version = "2.2.0" }), "Downgrade rejected");
Assert(!DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release with { Size = 0 }), "Empty update rejected");
Assert(!DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release with { Sha256 = "bad" }), "Corrupt digest rejected");
Assert(!DesktopUpdates.IsValid(DesktopSettings.DefaultEndpoint, release with { DownloadUrl = "" }), "Empty download URL rejected");
var options = LaunchOptions.Parse(["--server", "http://127.0.0.1:8838", "--data-dir", "C:\\Users\\A B\\预览"]);
Assert(options.RestartArguments().Contains("\"C:\\Users\\A B\\预览\""), "Restart keeps quoted review profile");
Assert(options.RestartArguments().Contains("http://127.0.0.1:8838"), "Update keeps review server");
Assert(!options.RestartArguments(preserveEndpoint: false).Contains("--server"), "Settings restart uses saved server");
Assert(LaunchOptions.Parse([]).RestartArguments() == "", "Production restart uses saved user settings");
checks += await DownloadChecks.Run();
checks += await ClassroomVoiceChecks.Run();
checks += await VoiceTranscriptionChecks.Run();
Console.WriteLine($"Desktop settings, update and classroom voice checks passed: {checks}");

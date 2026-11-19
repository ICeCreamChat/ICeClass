using System.IO.Compression;
using System.Text;
using System.Text.Json;
using ICeClass.Receiver;

if (args is ["--inspect-package", var runtime, var archivePath] && runtime is "win-x64" or "win-x86")
{
    var inspector = new ClassroomPluginPackage(Path.Combine(Path.GetTempPath(), "ICeClass-package-inspection", Guid.NewGuid().ToString("N")), runtime);
    var manifest = inspector.Inspect(archivePath);
    Console.WriteLine($"PASS {manifest.Name} {manifest.Version}: {manifest.Runtime}, {manifest.EntryPoint}");
    return;
}
if (args.Length != 0) throw new ArgumentException("Use --inspect-package win-x64|win-x86 ZIP, or no arguments for checks.");

var root = Path.Combine(Path.GetTempPath(), "ICeClass-workshop-checks-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var count = 0;
void Check(bool value, string text) { if (!value) throw new Exception(text); count++; }
void Reject(Action action, string text) { try { action(); } catch (InvalidDataException) { count++; return; } throw new Exception("Accepted " + text); }
string Package(string name, string? entry = null, string runtime = "win-x64", string? extra = null, bool duplicate = false, bool link = false) {
    var path = Path.Combine(root, name + ".zip");
    using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
    using (var writer = new StreamWriter(zip.CreateEntry("plugin.json").Open())) writer.Write(JsonSerializer.Serialize(new {
        schemaVersion=1,id="iceclass.video-booth",name="视频展台",version="1.0.0",hostApiVersion=1,runtime,entryPoint=entry??"ICeClass.VideoBooth.exe" }));
    var exe = zip.CreateEntry("ICeClass.VideoBooth.exe");
    using (var stream=exe.Open()) { var bytes = new byte[256]; bytes[0]=77;bytes[1]=90;bytes[60]=128;bytes[128]=80;bytes[129]=69;bytes[132]=0x64;bytes[133]=0x86;stream.Write(bytes); }
    if(extra is not null) { var item=zip.CreateEntry(extra);if(link)item.ExternalAttributes=unchecked((int)0xA1FF0000);using var writer=new StreamWriter(item.Open());writer.Write("fixture"); }
    if(duplicate) { using var writer=new StreamWriter(zip.CreateEntry("iceclass.videobooth.EXE").Open());writer.Write("fixture"); }
    return path;
}
var package = new ClassroomPluginPackage(Path.Combine(root,"profile","Plugins"), "win-x64");
var valid = Package("valid");
using (var candidate = ClassroomPluginPackage.Open(valid)) {
    Check(package.Inspect(candidate).Version=="1.0.0", "manifest version");
    try { using var replacement = new FileStream(valid,FileMode.Create,FileAccess.Write);throw new Exception("replaced confirmed package"); }
    catch(IOException) { count++; }
    await package.InstallAsync(candidate, CancellationToken.None);
}
Check(package.Read() is { Enabled:false }, "installation must start disabled");
package.SetEnabled(true);
Check(new ClassroomPluginPackage(Path.Combine(root,"profile","Plugins"),"win-x64").Read() is {Enabled:true}, "enabled must persist");
Reject(()=>package.Inspect(Package("escape",extra:"../outside.txt")),"path traversal");
Reject(()=>package.Inspect(Package("absolute",extra:"C:/outside.txt")),"absolute path");
Reject(()=>package.Inspect(Package("duplicate",duplicate:true)),"duplicate case-insensitive file");
Reject(()=>package.Inspect(Package("link",extra:"linked",link:true)),"symlink");
Reject(()=>package.Inspect(Package("wrong-arch",runtime:"win-x86")),"wrong architecture");
Reject(()=>package.Inspect(Package("missing",entry:"missing.exe")),"missing executable");
Reject(()=>package.Inspect(Package("private",extra:"data/device.json")),"private data");
Reject(()=>package.Inspect(Package("device",extra:"CON.txt")),"Windows device name");
Reject(()=>package.Inspect(Package("trailing",extra:"folder./item.txt")),"Windows normalized path alias");
try { using var candidate=ClassroomPluginPackage.Open(valid);await package.InstallAsync(candidate,CancellationToken.None);throw new Exception("overwrote installed package"); } catch(InvalidOperationException) {count++;}
var personal = Path.Combine(root,"profile","personal.txt"); File.WriteAllText(personal,"keep");
package.Uninstall();
Check(package.Read() is null && File.ReadAllText(personal)=="keep", "uninstall scope");
var wire = new MemoryStream();
await ClassroomPluginProtocol.WriteAsync(wire, "freeze_frame", "12345678901234567890123456789012", new{}, CancellationToken.None);
wire.Position=0;
var message=await ClassroomPluginProtocol.ReadAsync(wire,CancellationToken.None);
Check(message.Type=="freeze_frame" && message.RequestId.Length==32,"pipe framing round trip");
foreach(var length in new[]{0,-1,3*1024*1024+1}) {
    using var bad=new MemoryStream(BitConverter.GetBytes(length));
    try {await ClassroomPluginProtocol.ReadAsync(bad,CancellationToken.None);throw new Exception("unbounded pipe frame");} catch(InvalidDataException){count++;}
}
using(var imageDoc=JsonDocument.Parse("{\"dataUrl\":\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=\",\"width\":1,\"height\":1,\"capturedAt\":1000}")) {
    var frame=ClassroomMathImage.FromPayload(imageDoc.RootElement);
    Check(frame.Width==1,"original frame dimensions");
    try {ClassroomMathImage.ValidatePair(frame,frame with{CapturedAt=3001},3001);throw new Exception("accepted mixed-time images");}catch(InvalidOperationException){count++;}
    ClassroomMathImage.ValidatePair(frame,frame with{CapturedAt=3000},3000);count++;
    try {ClassroomMathImage.ValidatePair(frame,frame,long.MaxValue);throw new Exception("accepted stale frame");}catch(InvalidOperationException){count++;}
}
Console.WriteLine($"PASS {count} workshop package/protocol/image checks");

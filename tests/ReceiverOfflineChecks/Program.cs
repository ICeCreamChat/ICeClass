using System.Diagnostics;
using System.Text.Json.Nodes;
using ICeClass.Receiver;

if (args is ["--file-access-review", var fileAccessOutput])
{
    try { await FileAccessReview.Run(fileAccessOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--file-recycle-office-review", var recycleOfficeOutput])
{
    try { await FileRecycleOfficeReview.Run(recycleOfficeOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--file-recycle-review", var recycleOutput])
{
    try { await FileRecycleReview.Run(recycleOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--banban-pet-review", var petOutput]) { BanbanPetReview.Run(petOutput); return; }
if (args is ["--banban-pet-playground", var petPlayground]) { BanbanPetReview.Playground(petPlayground); return; }
if (args is ["--banban-motion-review", var motionOutput]) { BanbanPetMotionReview.Run(motionOutput); return; }
if (args is ["--banban-motion-playground"]) { BanbanPetMotionReview.Playground(); return; }

if (args is ["--vision-popup-diagnostics", var popupDiagnostics]) { VisionPopupChecks.Diagnose(popupDiagnostics); return; }
if (args is ["--vision-popup-review", var popupOutput]) { VisionPopupChecks.Run(popupOutput); return; }
if (args is ["--vision-control-review", var visionOutput]) { VisionComputerControlReview.Run(visionOutput); return; }
if (args is ["--vision-live-review", var visionBinding, var visionLiveOutput]) { VisionComputerControlReview.Run(visionLiveOutput, visionBinding); return; }

if (args is ["--sensevoice-compare", var comparisonCorpus, var comparisonOutput])
{
    try { SenseVoiceAccuracyReview.Run(comparisonCorpus, comparisonOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}

if (args is ["--neural-model-review", var modelFolder, var modelOutput])
{
    try { NeuralVoiceChecks.Run(modelOutput, modelFolder); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}

if (args is ["--neural-voice-checks", var neuralOutput])
{
    try { NeuralVoiceChecks.Run(neuralOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}

if (args is ["--neural-formula-review", var formulaInput, var formulaOutput])
{
    try { NeuralVoiceChecks.RunFormulaReview(formulaInput, formulaOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}

if (args is ["--voice-checks", var voiceOutput])
{
    try { BanbanVoiceChecks.Run(voiceOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--speaker-focus-checks", var speakerOutput])
{
    try { SpeakerFocusChecks.Run(speakerOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--speaker-corpus-checks", var speakerCorpus, var speakerCorpusOutput])
{
    try { SpeakerFocusChecks.RunCorpus(speakerCorpus, speakerCorpusOutput); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--voice-boundary-checks", var boundaryOutput])
{
    try { BanbanVoiceChecks.Run(boundaryOutput, boundariesOnly: true); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--asr-model-review", var asrModel, var asrOutput])
{
    try { BanbanVoiceChecks.Run(asrOutput, asrModel); }
    catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    return;
}
if (args is ["--voice-dialogue-review", var voiceBinding, var voiceReview]) { NativeVoiceDialogueReview.Run(voiceBinding, voiceReview); return; }
if (args is ["--voice-manual-review", var manualVoiceBinding, var manualVoiceOutput]) { NativeVoiceDialogueReview.Run(manualVoiceBinding, manualVoiceOutput, manual:true); return; }

if (args is ["--island-acceptance", var acceptanceBinding, var acceptanceOutput]) { NativeIslandAcceptanceChecks.Run("acceptance", acceptanceBinding, acceptanceOutput); return; }
if (args is ["--island-restart-write", var restartWriteBinding, var restartWriteOutput]) { NativeIslandAcceptanceChecks.Run("write", restartWriteBinding, restartWriteOutput); return; }
if (args is ["--island-restart-read", var restartReadBinding, var restartReadOutput]) { NativeIslandAcceptanceChecks.Run("read", restartReadBinding, restartReadOutput); return; }
if (args is ["--island-fullscreen-probe", var probeOutput]) { NativeIslandAcceptanceChecks.FullscreenProbe(probeOutput); return; }
if (args is ["--native-island", var bindingPath]) { NativeIslandChecks.Run(bindingPath); return; }
if (args is ["--island-ribbon"]) { NativeRibbonChecks.Run(); return; }
if (args is ["--island-ribbon-light"]) { NativeRibbonChecks.Run(light: true); return; }
if (args is ["--island-demo"]) { NativeDemoChecks.Run(); return; }
if (args is ["--island-timetable"]) { NativeTimetableChecks.Run(); return; }
if (args is ["--island-shout"]) { NativeShoutChecks.Run(); return; }
if (args is ["--island-arm-review", var reviewOutput]) { NativeHoldingArmReview.Run(reviewOutput); return; }
if (args is ["--island-layout-review", var layoutOutput]) { NativeIslandLayoutReview.Run(layoutOutput); return; }
if (args is ["--island-settings-review", var settingsOutput]) { NativeIslandSettingsReview.Run(settingsOutput); return; }
if (args is ["--computer-control-review", var computerOutput]) { NativeComputerControlReview.Run(computerOutput); return; }
if (args is ["--general-computer-review", var generalOutput]) { GeneralComputerControlReview.Run(generalOutput); return; }
if (args is ["--computer-snapshot", var snapshotOutput]) { await NativeComputerControlReview.Snapshot(snapshotOutput); return; }
if (args is ["--seewo-computer-review", var seewoOutput]) { await NativeComputerControlReview.Seewo(seewoOutput); return; }
if (args is ["--office-computer-review", var officeOutput]) { OfficeComputerControlReview.Run(officeOutput); return; }
if (args is ["--presentation-create-review", var presentationOutput]) { PresentationCreationReview.Run(presentationOutput); return; }
if (args is ["--document-create-review", var documentOutput]) { DocumentCreationReview.Run(documentOutput); return; }
if (args is ["--computer-dialogue-review", var dialogueBinding, var dialogueOutput]) { NativeComputerDialogueReview.Run(dialogueBinding, dialogueOutput); return; }

var root = Path.Combine(Path.GetTempPath(), "ICeClass-offline-check-" + Guid.NewGuid().ToString("N"));
var checks = 0;
void Check(bool condition, string description)
{
    if (!condition) throw new Exception(description);
    ++checks; Console.WriteLine("PASS " + description);
}
JsonObject Batch() => new() { ["id"] = Guid.NewGuid().ToString(), ["sessionId"] = Guid.NewGuid().ToString(), ["samples"] = new JsonArray(new JsonObject { ["at"] = 1 }) };
if (args is ["--crash-write", var folder])
{
    new ReadingOutbox(folder).Store(Batch());
    Environment.Exit(0); // No disposal, graceful shutdown or network flush.
}
Directory.CreateDirectory(root);
try
{
    var store = new ReadingOutbox(root);
    var shared = ReadingOutbox.Open(Path.Combine(root, "shared"));
    var nextBinding = ReadingOutbox.Open(Path.Combine(root, "shared"));
    shared.Store(Batch());
    Check(ReferenceEquals(shared, nextBinding) && nextBinding.Pending == 1, "old and new bindings share the queue while a closing window finishes saving");
    var batch = Batch(); store.Store(batch); store.Store(batch);
    Check(store.Pending == 1, "repeating an unconfirmed local write preserves one record");
    var conflict = batch.DeepClone().AsObject(); conflict["samples"] = new JsonArray();
    try { store.Store(conflict); throw new Exception("Conflicting record accepted"); } catch (InvalidDataException) { }
    Check(store.Peek()[0].ToJsonString() == batch.ToJsonString(), "conflicting local id cannot overwrite recorded data");
    store.SaveContext("{\"classId\":\"original\"}");
    var recovered = new ReadingOutbox(root);
    Check(recovered.Pending == 1 && recovered.LoadContext()!.Contains("original"), "a new store instance recovers queue and cached rules");
    recovered.Acknowledge(["../outside", Guid.NewGuid().ToString()]);
    Check(recovered.Pending == 1, "unknown and invalid acknowledgements do not remove data");
    recovered.MoveToReview(batch["id"]!.GetValue<string>(), "时间异常");
    Check(recovered.Pending == 0 && recovered.ReviewCount == 1, "rejected records remain on disk with an explanation");
    Check(Directory.GetFiles(Path.Combine(root, "review"), "*.reason.txt").Length == 1, "review reason survives restart");
    File.WriteAllText(Path.Combine(root, "pending", Guid.NewGuid() + ".json"), "incomplete{");
    File.WriteAllText(Path.Combine(root, "pending", "abandoned.json.tmp-interrupted"), "unfinished");
    recovered = new ReadingOutbox(root);
    Check(recovered.Peek().Count == 0 && recovered.ReviewCount == 2, "damaged record is retained for review and interrupted temporary write is ignored");
    await Task.WhenAll(Enumerable.Range(0, 120).Select(_ => Task.Run(() => recovered.Store(Batch()))));
    Check(recovered.Pending == 120, "concurrent disk writes retain every independent batch");
    var first = recovered.Peek(60); recovered.Acknowledge(first.Select(b => b["id"]!.GetValue<string>()));
    recovered.Acknowledge(first.Select(b => b["id"]!.GetValue<string>()));
    Check(recovered.Pending == 60, "repeated server acknowledgements remove only confirmed batches");
    var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
    if (Path.GetFileNameWithoutExtension(Environment.ProcessPath!).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(typeof(ReadingOutbox).Assembly.Location.Replace("ICeClass.dll", "ICeClass.ReceiverOfflineChecks.dll"));
    start.ArgumentList.Add("--crash-write"); start.ArgumentList.Add(Path.Combine(root, "crash"));
    using var child = Process.Start(start)!; await child.WaitForExitAsync();
    Check(child.ExitCode == 0 && new ReadingOutbox(Path.Combine(root, "crash")).Pending == 1, "an abruptly exiting process leaves its confirmed write recoverable");
    checks += await UpdateChecks.Run();
    checks += IslandChecks.Run(root);
    checks += IslandSpringChecks.Run();
    checks += IslandHoldingArmChecks.Run();
    checks += IslandScheduleChecks.Run(root);
    checks += IslandRibbonChecks.Run();
    checks += IslandDemoChecks.Run();
    checks += ComputerControlChecks.Run(root);
    Console.WriteLine($"{checks} receiver checks passed.");
}
catch (Exception error)
{
    Console.Error.WriteLine("CHECK FAILED: " + error);
    Environment.ExitCode = 1;
}
finally
{
    // Only this test's unique temporary directory is removed.
    Directory.Delete(root, true);
}

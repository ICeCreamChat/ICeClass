using System.Reflection;
using System.Runtime.CompilerServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class UpdateActivityChecks
{
    private const BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;
    internal static void Run()
    {
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect()
            .AfterSetup(_ => Dispatcher.UIThread.Post(async () =>
            {
                try { await Check(); }
                catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
                finally { ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown(Environment.ExitCode); }
            })).StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
    private static async Task Check()
    {
        // Exercise the production activity gate without opening windows, starting microphones or downloading a release.
        var app = (App)RuntimeHelpers.GetUninitializedObject(typeof(App));
        var island = (ClassroomIslandService)RuntimeHelpers.GetUninitializedObject(typeof(ClassroomIslandService));
        void Field(object target, string name, object? value) => target.GetType().GetField(name, Hidden)!.SetValue(target, value);
        void Island(string name, bool value) => Field(island, "<" + name + ">k__BackingField", value);
        bool Allowed() => (bool)typeof(App).GetProperty("CanDownloadUpdate", Hidden)!.GetValue(app)!;
        bool ManualAllowed() => (bool)typeof(App).GetMethod("CanUpdate", Hidden)!.Invoke(app, [true])!;
        bool VoiceAllowed(bool automatic) => (bool)typeof(App).GetMethod("CanDownloadVoice", Hidden)!.Invoke(app, [automatic])!;
        var count = 0;
        void Assert(bool ok, string text) { if (!ok) throw new Exception(text); count++; Console.WriteLine("PASS " + text); }
        Field(app, "_island", island);
        Assert(!Allowed(), "an unknown timetable cannot start a background download");
        Assert(ManualAllowed(), "a manual update can start without a confirmed timetable");
        Assert(!VoiceAllowed(true) && VoiceAllowed(false), "manual voice preparation can begin without a confirmed timetable; automatic work waits");
        Island("ScheduleKnown", true);
        Assert(Allowed(), "a known timetable allows a break with no classroom activity");
        Island("InClass", true);
        Assert(!Allowed(), "class time pauses update work even when the island is hidden");
        Assert(ManualAllowed(), "an explicit manual update is allowed during class time");
        Assert(!VoiceAllowed(true) && VoiceAllowed(false), "a manual voice download may start during a lesson while automatic downloads pause");
        Island("InClass", false);
        var readingField = typeof(ReadingExperience).GetField("_window", BindingFlags.Static | BindingFlags.NonPublic)!;
        try
        {
            readingField.SetValue(null, RuntimeHelpers.GetUninitializedObject(typeof(ReadingCompanionWindow)));
            Assert(!Allowed(), "an open early-reading session blocks downloads");
            Assert(!ManualAllowed(), "a manual update waits for an active early-reading session");
            Assert(!VoiceAllowed(false), "early reading also pauses a manually requested voice download");
        }
        finally { readingField.SetValue(null, null); }
        var home = (StudentVoiceWindow)RuntimeHelpers.GetUninitializedObject(typeof(StudentVoiceWindow));
        Field(app, "_studentVoiceWindow", home);
        Field(home, "_recording", true); Assert(!Allowed(), "a student recording blocks downloads");
        Assert(!ManualAllowed(), "a manual update waits for a recording to finish");
        Assert(!VoiceAllowed(false), "recording also pauses a manually requested voice download");
        Field(home, "_recording", false); Field(home, "_sending", true); Assert(!Allowed(), "sending a recording blocks downloads");
        Field(home, "_sending", false);
        using var voice = new BanbanVoiceService();
        var voiceWindow = (BanbanVoiceWindow)RuntimeHelpers.GetUninitializedObject(typeof(BanbanVoiceWindow));
        Field(voiceWindow, "_voice", voice); Field(app, "_banbanVoiceWindow", voiceWindow);
        Assert(Allowed(), "continuous wake standby remains compatible with break-time downloads");
        Field(voice, "_active", true); Assert(!Allowed(), "a conversation pauses downloads between spoken turns");
        Assert(!ManualAllowed(), "a manual update waits for an active conversation");
        Assert(!VoiceAllowed(false), "active conversation pauses both manual and automatic voice preparation");
        Field(voice, "_active", false);
        Field(app, "_stopTask", Task.Delay(500)); Assert(!Allowed(), "a computer task still stopping blocks downloads");
        Field(app, "_stopTask", null);
        using var idle = new CancellationTokenSource();
        var monitoring = (Task)typeof(App).GetMethod("PauseWhenBusyAsync", Hidden)!.Invoke(app, [idle, false])!;
        await Task.Delay(50); Island("InClass", true);
        await monitoring.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(idle.IsCancellationRequested, "a lesson starting mid-download cancels the active transfer promptly");
        Island("InClass", false);
        Assert(Allowed(), "the next idle break can resume the pending transfer");
        using var manual = new CancellationTokenSource();
        var manualMonitoring = (Task)typeof(App).GetMethod("PauseWhenBusyAsync", Hidden)!.Invoke(app, [manual, true])!;
        Island("InClass", true); await Task.Delay(350);
        Assert(!manual.IsCancellationRequested, "a lesson starting does not cancel an explicit manual update");
        Field(home, "_recording", true);
        await manualMonitoring.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(manual.IsCancellationRequested, "a recording starting promptly pauses a manual update");
        Field(home, "_recording", false);
        Console.WriteLine($"{count} update activity checks passed.");
    }
}

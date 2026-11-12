using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class IslandMaterialPerformance
{
    internal static void Run(string output) => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
        .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(output)))
        .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown);

    private static T Field<T>(object target, string name) => (T)target.GetType()
        .GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(target)!;

    private static async Task Check(string output)
    {
        var desktop = (IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!;
        ClassroomIslandWindow? island = null; Window? source = null;
        try
        {
            Directory.CreateDirectory(output);
            island = new ClassroomIslandWindow(() => Task.CompletedTask, () => { }, () => { }, () => { }, () => { });
            var work = island.Screens.Primary!.WorkingArea; var scale = island.Screens.Primary.Scaling;
            source = new Window { Title = "轻量材质性能检查", Width = work.Width / scale, Height = work.Height / scale,
                Position = work.Position, WindowStartupLocation = WindowStartupLocation.Manual,
                SystemDecorations = SystemDecorations.None, ShowInTaskbar = false, ShowActivated = false, Topmost = true };
            Field<ClassroomIslandRibbon>(island, "_ribbon").Animate = false;
            Field<IslandBanbanMascot>(island, "_mascot").Animate = false;
            var profile = IslandRibbonChecks.Fixture(); profile.Reminders.Enabled = false;
            island.Update(IslandRibbonChecks.View(), false);
            island.ApplyProfile(new IslandAppearance { Width = 790, OffsetX = 70, OffsetY = 160, HideFullscreen = false, Theme = "light" },
                profile, IslandRibbonChecks.At(10, 40), "", "隔离性能测试", false);
            source.Show(); island.Show(); island.UpdateLayout(); source.Activate();
            SetWindowPos(island.TryGetPlatformHandle()!.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            await Measure(source, output);
        }
        catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
        finally { island?.DisposeWindow(); source?.Close(); desktop.Shutdown(Environment.ExitCode); }
    }

    private static async Task Measure(Window source, string output)
    {
        using var app = Process.GetCurrentProcess(); using var dwm = Process.GetProcessesByName("dwm").First();
        using var gpu = new GpuCounters(app.Id, dwm.Id);
        var pattern = new MotionPattern(); source.Background = Brushes.Transparent; source.Content = pattern;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(40) };
        timer.Tick += (_, _) => { pattern.Ticks++; pattern.Phase = (pattern.Phase + 5) % 180; pattern.InvalidateVisual(); };
        var records = new List<object>();
        try
        {
            foreach (var stage in new[] { "static-light", "moving-light", "moving-light-repeat" })
            {
                if (stage.StartsWith("moving")) timer.Start(); else timer.Stop();
                await Task.Delay(1800);
                gpu.Sample(); app.Refresh();
                var appCpu = app.TotalProcessorTime;
                var ticks = pattern.Ticks; var renders = pattern.Renders;
                var watch = Stopwatch.StartNew();
                var gpuSamples = new List<(double App, double Dwm, double Copy, double DwmCpu)>();
                while (watch.Elapsed.TotalSeconds < 6)
                {
                    await Task.Delay(500); gpuSamples.Add(gpu.Sample());
                }
                app.Refresh();
                var elapsed = watch.Elapsed.TotalSeconds;
                var record = new
                {
                    stage, seconds = elapsed, logicalProcessors = Environment.ProcessorCount,
                    appCpuCorePercent = (app.TotalProcessorTime - appCpu).TotalSeconds / elapsed * 100,
                    dwmCpuCorePercent = gpuSamples.Average(s => s.DwmCpu), dwmCpuCounterAvailable = gpu.DwmCpuAvailable,
                    appGpu3DPercent = gpuSamples.Average(s => s.App), dwmGpu3DPercent = gpuSamples.Average(s => s.Dwm),
                    appGpuCopyPercent = gpuSamples.Average(s => s.Copy), gpuCountersAvailable = gpu.Available,
                    privateMiB = app.PrivateMemorySize64 / 1048576d, workingMiB = app.WorkingSet64 / 1048576d,
                    backgroundUpdatesPerSecond = 0,
                    sourceTicksPerSecond = (pattern.Ticks - ticks) / elapsed, sourceRendersPerSecond = (pattern.Renders - renders) / elapsed
                };
                records.Add(record); Console.WriteLine(JsonSerializer.Serialize(record));
            }
            File.WriteAllText(Path.Combine(output, "performance.json"), JsonSerializer.Serialize(records, new JsonSerializerOptions { WriteIndented = true }));
        }
        finally { timer.Stop(); }
    }

    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    private sealed class MotionPattern : Control
    {
        internal double Phase;
        internal int Ticks, Renders;
        public override void Render(DrawingContext context)
        {
            Renders++;
            context.FillRectangle(Brush.Parse("#8FBDDF"), new Rect(Bounds.Size));
            for (var x = Phase - 180; x < Bounds.Width; x += 180)
            {
                context.FillRectangle(Brush.Parse("#CFF2FF"), new Rect(x, 0, 35, Bounds.Height));
                context.FillRectangle(Brush.Parse("#34729F"), new Rect(x + 65, 0, 9, Bounds.Height));
            }
        }
    }

    // PDH English counter names work on the Chinese Windows installation too.
    // Keep app and DWM 3D-engine usage separate; CPU-only timing misses DWM work.
    private sealed class GpuCounters : IDisposable
    {
        private IntPtr _query, _counter, _dwmCpu; private readonly int _app, _dwm;
        internal bool Available { get; }
        internal bool DwmCpuAvailable { get; }
        internal GpuCounters(int app, int dwm)
        {
            _app = app; _dwm = dwm;
            Available = PdhOpenQuery(null, IntPtr.Zero, out _query) == 0
                && PdhAddEnglishCounter(_query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out _counter) == 0;
            DwmCpuAvailable = _query != IntPtr.Zero && PdhAddEnglishCounter(_query, @"\Process(dwm)\% Processor Time", IntPtr.Zero, out _dwmCpu) == 0;
            if (Available) PdhCollectQueryData(_query);
        }
        internal (double App, double Dwm, double Copy, double DwmCpu) Sample()
        {
            if (!Available || PdhCollectQueryData(_query) != 0) return default;
            uint size = 0, count = 0;
            var status = PdhGetFormattedCounterArray(_counter, 0x00000200, ref size, ref count, IntPtr.Zero);
            if (status != 0x800007D2 || size == 0) return default;
            var buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                if (PdhGetFormattedCounterArray(_counter, 0x00000200, ref size, ref count, buffer) != 0) return default;
                double app = 0, dwm = 0, copy = 0;
                for (var i = 0; i < count; i++)
                {
                    var item = Marshal.PtrToStructure<CounterItem>(buffer + i * Marshal.SizeOf<CounterItem>());
                    if (item.Status > 1) continue;
                    var name = Marshal.PtrToStringUni(item.Name) ?? "";
                    if (name.Contains("pid_" + _app + "_", StringComparison.Ordinal))
                    { if (name.EndsWith("engtype_3D")) app += item.Value; if (name.EndsWith("engtype_Copy")) copy += item.Value; }
                    if (name.Contains("pid_" + _dwm + "_", StringComparison.Ordinal) && name.EndsWith("engtype_3D")) dwm += item.Value;
                }
                var cpu = DwmCpuAvailable && PdhGetFormattedCounterValue(_dwmCpu, 0x00000200, out _, out var cpuValue) == 0 ? cpuValue.Value : 0;
                return (app, dwm, copy, cpu);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        public void Dispose() { if (_query != IntPtr.Zero) PdhCloseQuery(_query); }
        [StructLayout(LayoutKind.Sequential)] private struct CounterItem { public IntPtr Name; public uint Status; public double Value; }
        [StructLayout(LayoutKind.Sequential)] private struct CounterValue { public uint Status; public double Value; }
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhOpenQueryW")] private static extern uint PdhOpenQuery(string? source, IntPtr data, out IntPtr query);
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhAddEnglishCounterW")] private static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr data, out IntPtr counter);
        [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
        [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out CounterValue value);
        [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhGetFormattedCounterArrayW")] private static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bytes, ref uint count, IntPtr buffer);
        [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
    }
}

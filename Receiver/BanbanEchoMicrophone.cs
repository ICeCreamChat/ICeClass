using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Dmo;
using NAudio.Wave;

namespace ICeClass.Receiver;

/// <summary>
/// Windows Voice Capture DSP in source mode. Windows synchronizes the selected
/// microphone and render reference before AEC; no audio leaves this process.
/// The ordinary microphone remains the fallback if this optional DSP fails.
/// </summary>
internal sealed class BanbanEchoMicrophone : IDisposable
{
    private readonly Action<byte[], int> _receive;
    private readonly Action<Exception> _failed;
    private readonly ManualResetEventSlim _stop = new(false);
    private readonly Thread _thread;
    private int _ready;
    private int _started, _disposed;
    internal bool Ready => Volatile.Read(ref _ready) != 0;

    internal BanbanEchoMicrophone(Action<byte[], int> receive, Action<Exception> failed)
    {
        _receive = receive; _failed = failed;
        _thread = new Thread(Capture) { IsBackground = true, Name = "ICeClass.BanbanEchoCapture" };
        _thread.SetApartmentState(ApartmentState.MTA);
    }
    internal void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (Interlocked.CompareExchange(ref _started, 1, 0) != 0) return;
        try { _thread.Start(); }
        catch { Volatile.Write(ref _started, 0); throw; }
    }

    private void Capture()
    {
        object? instance = null;
        VoiceMediaObject? media = null;
        var buffers = new[] { new DmoOutputDataBuffer(32000) };
        try
        {
            using var devices = new MMDeviceEnumerator();
            using var microphone = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
            using var speaker = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
            // Keep the shared render clock running even during silence. Source
            // mode needs a live reference stream, and must use the TTS endpoint.
            using var clock = new WasapiOut(speaker, AudioClientShareMode.Shared, false, 40);
            clock.Init(new SilenceProvider(new WaveFormat(16000, 16, 1))); clock.Play();
            instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new("745057c7-f353-4f2d-a7ee-58434477730e"), throwOnError: true)!);
            media = (VoiceMediaObject)instance!;
            var properties = (VoicePropertyStore)instance!;
            Set(properties, 2, 0); // SINGLE_CHANNEL_AEC
            var captureIndex = Index(devices, DataFlow.Capture, microphone.ID);
            var renderIndex = Index(devices, DataFlow.Render, speaker.ID);
            Set(properties, 4, (renderIndex << 16) | captureIndex);
            Set(properties, 5, -1, boolean: true); // FEATURE_MODE
            Set(properties, 8, 1); // noise suppression
            Set(properties, 9, -1, boolean: true); // automatic gain control
            var format = new WaveFormat(16000, 16, 1);
            var type = new DmoMediaType();
            Check(MoInitMediaType(ref type, Marshal.SizeOf(format)));
            try { type.SetWaveFormat(format); Check(media.SetOutputType(0, ref type, 0)); }
            finally { MoFreeMediaType(ref type); }
            Check(media.AllocateStreamingResources());
            var pcm = new byte[32000];
            var lastData = Environment.TickCount64;
            while (!_stop.Wait(10))
            {
                do
                {
                    Check(buffers[0].MediaBuffer.SetLength(0));
                    Check(media.ProcessOutput(0, 1, buffers, out _));
                    if (buffers[0].Length > 0)
                    {
                        lastData = Environment.TickCount64;
                        buffers[0].RetrieveData(pcm, 0);
                        Volatile.Write(ref _ready, 1);
                        _receive(pcm, buffers[0].Length);
                    }
                } while (buffers[0].MoreDataAvailable && !_stop.IsSet);
                if (Environment.TickCount64 - lastData > 4000) throw new IOException("Windows 回声消除没有返回麦克风数据。");
            }
        }
        catch (Exception error) { if (!_stop.IsSet) _failed(error); }
        finally
        {
            Volatile.Write(ref _ready, 0);
            if (media is not null) { try { media.FreeStreamingResources(); } catch (COMException) { } }
            buffers[0].Dispose();
            if (instance is not null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
        }
    }
    private static int Index(MMDeviceEnumerator devices, DataFlow flow, string id)
    {
        var endpoints = devices.EnumerateAudioEndPoints(flow, DeviceState.Active);
        for (var i = 0; i < endpoints.Count; i++) { using var device = endpoints[i]; if (device.ID == id) return i; }
        throw new IOException("默认语音设备已改变，请重新开启语音。");
    }
    private static void Set(VoicePropertyStore properties, int id, int value, bool boolean = false)
    {
        var key = new VoicePropertyKey { Format = new("6f52c567-0360-4bd2-9617-ccbf1421c939"), Id = id };
        var variant = new VoicePropertyValue { Type = (short)(boolean ? 11 : 3), Value = value };
        Check(properties.SetValue(ref key, ref variant));
    }
    private static void Check(int result) => Marshal.ThrowExceptionForHR(result);
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Set();
        if (Volatile.Read(ref _started) != 0 && Thread.CurrentThread != _thread) _thread.Join(TimeSpan.FromSeconds(3));
        if (!_thread.IsAlive) _stop.Dispose();
    }
    [DllImport("msdmo.dll", ExactSpelling = true)] private static extern int MoInitMediaType(ref DmoMediaType type, int size);
    [DllImport("msdmo.dll", ExactSpelling = true)] private static extern int MoFreeMediaType(ref DmoMediaType type);
    [StructLayout(LayoutKind.Sequential)] private struct VoicePropertyKey { internal Guid Format; internal int Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct VoicePropertyValue
    {
        [FieldOffset(0)] internal short Type;
        [FieldOffset(8)] internal int Value;
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface VoicePropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out VoicePropertyKey key);
        [PreserveSig] int GetValue(ref VoicePropertyKey key, out VoicePropertyValue value);
        [PreserveSig] int SetValue(ref VoicePropertyKey key, ref VoicePropertyValue value);
        [PreserveSig] int Commit();
    }
    // IMediaObject's complete vtable, using NAudio's existing media buffers/types.
    [ComImport, Guid("d8ad0f58-5494-4102-97c5-ec798e59bcf4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface VoiceMediaObject
    {
        [PreserveSig] int GetStreamCount(out int inputs, out int outputs);
        [PreserveSig] int GetInputStreamInfo(int stream, out int flags);
        [PreserveSig] int GetOutputStreamInfo(int stream, out int flags);
        [PreserveSig] int GetInputType(int stream, int index, out DmoMediaType type);
        [PreserveSig] int GetOutputType(int stream, int index, out DmoMediaType type);
        [PreserveSig] int SetInputType(int stream, ref DmoMediaType type, int flags);
        [PreserveSig] int SetOutputType(int stream, ref DmoMediaType type, int flags);
        [PreserveSig] int GetInputCurrentType(int stream, out DmoMediaType type);
        [PreserveSig] int GetOutputCurrentType(int stream, out DmoMediaType type);
        [PreserveSig] int GetInputSizeInfo(int stream, out int size, out int lookahead, out int alignment);
        [PreserveSig] int GetOutputSizeInfo(int stream, out int size, out int alignment);
        [PreserveSig] int GetInputMaxLatency(int stream, out long latency);
        [PreserveSig] int SetInputMaxLatency(int stream, long latency);
        [PreserveSig] int Flush();
        [PreserveSig] int Discontinuity(int stream);
        [PreserveSig] int AllocateStreamingResources();
        [PreserveSig] int FreeStreamingResources();
        [PreserveSig] int GetInputStatus(int stream, out int flags);
        [PreserveSig] int ProcessInput(int stream, IMediaBuffer buffer, int flags, long timestamp, long duration);
        [PreserveSig] int ProcessOutput(int flags, int count, [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] DmoOutputDataBuffer[] buffers, out int status);
        [PreserveSig] int Lock([MarshalAs(UnmanagedType.Bool)] bool locked);
    }
}

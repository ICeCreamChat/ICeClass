using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.CoreAudioApi;
using NAudio.Wave;

// Explicit hardware opt-in. Runs the production capture/VAD pipeline briefly;
// keeps only sample counts and levels, with no audio files, ASR or AI request.
internal static class SelfStudyMicrophoneChecks
{
    internal static async Task Run(string output, int seconds = 8)
    {
        if (seconds is < 8 or > 60) throw new ArgumentOutOfRangeException(nameof(seconds));
        Directory.CreateDirectory(output);
        var started = Stopwatch.StartNew();
        var frames = 0; var samples = 0L; var peak = 0d; var squares = 0d;
        var failed = 0; var segments = 0; var speechFrames = 0; var gaps = 0;
        var rawVadFrames = 0; var gatedVadFrames = 0; var amplifiedVadFrames = 0; var maxVoiceRms = 0d;
        var communicationVadFrames = 0; var communicationPeak = 0d;
        var processedVadFrames = 0; var processedFrames = 0; var processedPeak = 0d; string? processedError = null;
        var analysisEnabled = true;
        var meterFrames = 0; var pausedMeterFrames = 0; var minLevel = 1d; var maxLevel = 0d;
        object report;
        try
        {
            using var rawVad = new BanbanVoiceActivity();
            using var amplifiedVad = new BanbanVoiceActivity();
            using var communicationVad = new BanbanVoiceActivity();
            using var processedVad = new BanbanVoiceActivity();
            var diagnosticGate = new SelfStudyNoiseGate();
            using var audio = new SelfStudyAudio(_ => Interlocked.Increment(ref segments),
                () => Interlocked.Increment(ref speechFrames), () => Interlocked.Exchange(ref failed, 1),
                () => Interlocked.Increment(ref gaps), sound =>
                {
                    if (!double.IsFinite(sound.Level) || sound.Level < 0 || sound.Level > 1)
                        Interlocked.Exchange(ref failed, 1);
                    minLevel = Math.Min(minLevel, sound.Level); maxLevel = Math.Max(maxLevel, sound.Level);
                    Interlocked.Increment(ref meterFrames);
                    if (!Volatile.Read(ref analysisEnabled)) Interlocked.Increment(ref pausedMeterFrames);
                }, () => Volatile.Read(ref analysisEnabled));
            var capture = (WaveInEvent)typeof(SelfStudyAudio).GetField("_capture", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(audio)!;
            var worker = (Thread)typeof(SelfStudyAudio).GetField("_worker", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(audio)!;
            using var endpoints = new MMDeviceEnumerator();
            using var communicationEndpoint = endpoints.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            var communicationIndex = Enumerable.Range(0, WaveIn.DeviceCount).FirstOrDefault(i =>
                communicationEndpoint.FriendlyName.StartsWith(WaveIn.GetCapabilities(i).ProductName, StringComparison.OrdinalIgnoreCase), -1);
            using var communicationCapture = seconds > 8 && communicationIndex >= 0 && communicationIndex != capture.DeviceNumber
                ? new WaveInEvent { DeviceNumber = communicationIndex, WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50 } : null;
            if (communicationCapture is not null) communicationCapture.DataAvailable += (_, args) =>
            {
                if (!Volatile.Read(ref analysisEnabled)) return;
                var pcm = new float[args.BytesRecorded / 2];
                for (var index = 0; index < pcm.Length; index++)
                {
                    pcm[index] = BitConverter.ToInt16(args.Buffer, index * 2) / 32768f;
                    communicationPeak = Math.Max(communicationPeak, Math.Abs(pcm[index]));
                }
                if (communicationVad.Accept(pcm)) Interlocked.Increment(ref communicationVadFrames);
            };
            using var processedCapture = seconds > 8 ? new BanbanEchoMicrophone((buffer, count) =>
            {
                if (!Volatile.Read(ref analysisEnabled)) return;
                var pcm = new float[count / 2];
                for (var index = 0; index < pcm.Length; index++)
                {
                    pcm[index] = BitConverter.ToInt16(buffer, index * 2) / 32768f;
                    processedPeak = Math.Max(processedPeak, Math.Abs(pcm[index]));
                }
                Interlocked.Increment(ref processedFrames);
                if (processedVad.Accept(pcm)) Interlocked.Increment(ref processedVadFrames);
            }, error => processedError = error.GetType().Name) : null;
            capture.DataAvailable += (_, args) =>
            {
                Interlocked.Increment(ref frames);
                var pcm = new float[args.BytesRecorded / 2];
                for (var index = 0; index + 1 < args.BytesRecorded; index += 2)
                {
                    var value = BitConverter.ToInt16(args.Buffer, index) / 32768d;
                    pcm[index / 2] = (float)value;
                    peak = Math.Max(peak, Math.Abs(value)); squares += value * value;
                }
                if (Volatile.Read(ref analysisEnabled))
                {
                    var detected = rawVad.Accept(pcm);
                    if (detected)
                    {
                        Interlocked.Increment(ref rawVadFrames);
                        maxVoiceRms = Math.Max(maxVoiceRms, Math.Sqrt(pcm.Sum(s => (double)s * s) / pcm.Length));
                    }
                    if (diagnosticGate.Accept(pcm, detected)) Interlocked.Increment(ref gatedVadFrames);
                    if (amplifiedVad.Accept(pcm.Select(s => Math.Clamp(s * 8, -1, 1)).ToArray())) Interlocked.Increment(ref amplifiedVadFrames);
                }
                Interlocked.Add(ref samples, args.BytesRecorded / 2);
            };
            Console.WriteLine($"Opening the default real microphone for {seconds} seconds; speak naturally. No recording file, ASR or AI.");
            audio.Start();
            communicationCapture?.StartRecording();
            processedCapture?.Start();
            await Task.Delay(TimeSpan.FromSeconds(seconds - 4));
            Volatile.Write(ref analysisEnabled, false);
            await Task.Delay(TimeSpan.FromSeconds(4));
            audio.Dispose();
            communicationCapture?.StopRecording();
            processedCapture?.Dispose();
            if (!await Task.Run(() => worker.Join(3000))) throw new TimeoutException("麦克风处理线程未及时结束。");
            var stoppedAt = Volatile.Read(ref frames);
            await Task.Delay(250);
            if (Volatile.Read(ref frames) != stoppedAt) throw new InvalidOperationException("停止后仍收到麦克风采样。");
            if (Volatile.Read(ref failed) != 0 || samples < 16000 || frames < 20 || meterFrames < 20 || pausedMeterFrames < 10)
                throw new InvalidOperationException("真实麦克风采集或 VAD 自检未通过。");
            report = new { success = true, frames, samples, sampleRate = 16000,
                capturedSeconds = samples / 16000d, peak, rms = Math.Sqrt(squares / samples),
                microphone = capture.DeviceNumber < 0 ? "Windows default mapper" : WaveIn.GetCapabilities(capture.DeviceNumber).ProductName,
                rawVadFrames, gatedVadFrames, amplifiedVadFrames, maxVoiceRms,
                communicationMicrophone = communicationEndpoint.FriendlyName, communicationVadFrames, communicationPeak,
                processedFrames, processedVadFrames, processedPeak, processedError,
                speechFrames, segments, gaps, meterFrames, pausedMeterFrames, minLevel, maxLevel,
                stopped = true, audioSaved = false,
                transcriptsCreated = false, aiCalls = 0, elapsedMs = started.ElapsedMilliseconds };
        }
        catch (Exception error)
        {
            Environment.ExitCode = 1;
            report = new { success = false, error = error.ToString(), frames, samples,
                audioSaved = false, transcriptsCreated = false, aiCalls = 0, elapsedMs = started.ElapsedMilliseconds };
            Console.Error.WriteLine(error);
        }
        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
        await File.WriteAllTextAsync(Path.Combine(output, "microphone-result.json"), json);
        Console.WriteLine(json);
    }
}

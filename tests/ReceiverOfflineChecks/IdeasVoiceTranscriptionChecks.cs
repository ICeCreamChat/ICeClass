using System.Buffers.Binary;
using System.Speech.Synthesis;
using System.Text;
using System.Text.Json;
using ICeClass.Receiver;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class IdeasVoiceTranscriptionChecks
{
    internal static async Task Run(string? output = null)
    {
        var results = new List<object>();
        var failures = 0;
        async Task Check(string name, Func<Task> run)
        {
            try
            {
                await run();
                results.Add(new { name, passed = true });
                Console.WriteLine("PASS " + name);
            }
            catch (Exception error)
            {
                ++failures;
                results.Add(new { name, passed = false, exception = error.GetType().Name });
                Console.Error.WriteLine("FAIL " + name + " (" + error.GetType().Name + ")");
            }
        }

        await Check("only nonempty UUIDs in the bridge's canonical format are accepted", () =>
        {
            Require(IdeasVoiceTranscriber.IsValidRequestId("b795e82b-3287-493d-9c67-0b0205cbeef2"));
            Require(IdeasVoiceTranscriber.IsValidRequestId("B795E82B-3287-493D-9C67-0B0205CBEEF2"));
            foreach (var id in new string?[] { null, "", "undefined", "../../request", "00000000-0000-0000-0000-000000000000",
                "b795e82b3287493d9c670b0205cbeef2", "{b795e82b-3287-493d-9c67-0b0205cbeef2}", " b795e82b-3287-493d-9c67-0b0205cbeef2" })
                Require(!IdeasVoiceTranscriber.IsValidRequestId(id));
            return Task.CompletedTask;
        });

        var valid = Convert.ToBase64String(Wav());
        var transcriber = new IdeasVoiceTranscriber((_, _) => "  recognized  ");
        await Check("PCM16 endpoints reach recognition with their sign and scale preserved", async () =>
        {
            var wav = Wav(2);
            BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(44), short.MinValue);
            BinaryPrimitives.WriteInt16LittleEndian(wav.AsSpan(46), short.MaxValue);
            var service = new IdeasVoiceTranscriber((samples, _) =>
            {
                Require(samples.Length == 2 && samples[0] == -1f && samples[1] == 32767f / 32768);
                return "  recognized  ";
            });
            Require(await service.TranscribeAsync(Convert.ToBase64String(wav), CancellationToken.None) == "recognized");
        });
        await Check("a complete sixty-second recording is accepted without a thirty-second truncation", async () =>
        {
            var service = new IdeasVoiceTranscriber((samples, _) =>
            {
                Require(samples.Length == 960000 && samples[^1] != 0);
                return "complete";
            });
            Require(await service.TranscribeAsync(Convert.ToBase64String(Wav(960000)), CancellationToken.None) == "complete");
        });
        await Check("one sample beyond sixty seconds is rejected", async () =>
            await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(Convert.ToBase64String(Wav(960001)), CancellationToken.None)));

        await Check("oversized encoded input is rejected before invalid base64 is decoded", async () =>
        {
            var error = await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(new string('!', 2796208), CancellationToken.None));
            Require(error.Message.Contains("2 MB", StringComparison.Ordinal));
        });
        await Check("base64 padding cannot hide a decoded payload over two MiB", async () =>
            await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(Convert.ToBase64String(new byte[2097153]), CancellationToken.None)));
        await Check("missing, malformed and non-WAV recordings fail with an informative error", async () =>
        {
            foreach (var input in new string?[] { null, "", "!!!!", "data:audio/wav;base64," + valid, Convert.ToBase64String("not a recording"u8) })
            {
                var error = await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(input, CancellationToken.None));
                Require(!string.IsNullOrWhiteSpace(error.Message));
            }
        });

        var mutations = new (string Name, Action<byte[]> Mutate)[]
        {
            ("non-RIFF container", bytes => bytes[0] = (byte)'X'),
            ("non-WAVE payload", bytes => bytes[8] = (byte)'X'),
            ("compressed audio", bytes => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(20), 3)),
            ("stereo audio", bytes => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(22), 2)),
            ("wrong sample rate", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(24), 44100)),
            ("inconsistent byte rate", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(28), 16000)),
            ("inconsistent block alignment", bytes => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(32), 4)),
            ("wrong bit depth", bytes => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(34), 8)),
            ("truncated format chunk", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(16), 12)),
            ("overflowing chunk length", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(40), uint.MaxValue)),
            ("odd PCM byte count", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(40), 3199)),
            ("inconsistent RIFF length", bytes => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)bytes.Length)),
            ("missing format chunk", bytes => Encoding.ASCII.GetBytes("JUNK").CopyTo(bytes, 12)),
            ("missing data chunk", bytes => Encoding.ASCII.GetBytes("JUNK").CopyTo(bytes, 36))
        };
        foreach (var mutation in mutations)
            await Check("rejects " + mutation.Name, async () =>
            {
                var bytes = Wav(); mutation.Mutate(bytes);
                await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(Convert.ToBase64String(bytes), CancellationToken.None));
            });
        await Check("truncated PCM, empty PCM and trailing bytes are rejected", async () =>
        {
            var bytes = Wav();
            foreach (var malformed in new[] { bytes[..^1], Wav(0), bytes.Concat(new byte[] { 0 }).ToArray() })
                await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(Convert.ToBase64String(malformed), CancellationToken.None));
        });
        await Check("ordinary padded metadata chunks do not corrupt PCM decoding", async () =>
        {
            var bytes = Wav();
            var metadata = new byte[] { (byte)'J', (byte)'U', (byte)'N', (byte)'K', 1, 0, 0, 0, 42, 0 };
            var withMetadata = bytes[..36].Concat(metadata).Concat(bytes[36..]).ToArray();
            BinaryPrimitives.WriteUInt32LittleEndian(withMetadata.AsSpan(4), (uint)withMetadata.Length - 8);
            Require(await transcriber.TranscribeAsync(Convert.ToBase64String(withMetadata), CancellationToken.None) == "recognized");
        });
        await Check("duplicate audio or format chunks are rejected instead of silently dropping audio", async () =>
        {
            var bytes = Wav();
            foreach (var chunk in new[] { bytes[12..36], bytes[36..] })
            {
                var duplicate = bytes.Concat(chunk).ToArray();
                BinaryPrimitives.WriteUInt32LittleEndian(duplicate.AsSpan(4), (uint)duplicate.Length - 8);
                await Throws<InvalidDataException>(() => transcriber.TranscribeAsync(Convert.ToBase64String(duplicate), CancellationToken.None));
            }
        });

        await Check("silence and near silence return an error without initializing a model", async () =>
        {
            var service = new IdeasVoiceTranscriber((_, _) => throw new Exception("Silence reached native recognition"));
            foreach (var amplitude in new short[] { 0, 1 })
            {
                var error = await Throws<InvalidDataException>(() => service.TranscribeAsync(Convert.ToBase64String(Wav(16000, amplitude)), CancellationToken.None));
                Require(!string.IsNullOrWhiteSpace(error.Message));
            }
        });
        await Check("empty recognition is an informative failure rather than successful blank text", async () =>
        {
            var service = new IdeasVoiceTranscriber((_, _) => " \r\n ");
            var error = await Throws<InvalidDataException>(() => service.TranscribeAsync(valid, CancellationToken.None));
            Require(!string.IsNullOrWhiteSpace(error.Message));
        });
        await Check("pre-cancelled work never starts recognition", async () =>
        {
            using var cancel = new CancellationTokenSource(); cancel.Cancel();
            var service = new IdeasVoiceTranscriber((_, _) => throw new Exception("Cancelled work reached recognition"));
            await Throws<OperationCanceledException>(() => service.TranscribeAsync(valid, cancel.Token));
        });
        await Check("cancellation keeps native work bounded until it finishes and discards its result", async () =>
        {
            using var cancel = new CancellationTokenSource();
            using var release = new ManualResetEventSlim();
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var service = new IdeasVoiceTranscriber((_, _) =>
            {
                entered.TrySetResult();
                if (!release.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException();
                return "obsolete result";
            });
            var other = new IdeasVoiceTranscriber((_, _) => "next result");
            var active = service.TranscribeAsync(valid, cancel.Token);
            try
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Require(!active.IsCompleted);
                var busy = await Throws<InvalidOperationException>(() => service.TranscribeAsync(valid, CancellationToken.None));
                Require(!string.IsNullOrWhiteSpace(busy.Message));
                await Throws<InvalidOperationException>(() => other.TranscribeAsync(valid, CancellationToken.None));
                cancel.Cancel();
                Require(!active.IsCompleted);
                await Throws<InvalidOperationException>(() => service.TranscribeAsync(valid, CancellationToken.None));
                await Throws<InvalidOperationException>(() => other.TranscribeAsync(valid, CancellationToken.None));
            }
            finally { release.Set(); }
            await Throws<OperationCanceledException>(() => active);
            Require(await other.TranscribeAsync(valid, CancellationToken.None) == "next result");
            Require(await service.TranscribeAsync(valid, CancellationToken.None) == "obsolete result");
        });
        await Check("a failed native invocation releases both concurrency limits", async () =>
        {
            var fail = true;
            var service = new IdeasVoiceTranscriber((_, _) =>
            {
                if (fail) throw new IOException("Synthetic model failure");
                return "recovered";
            });
            await Throws<IOException>(() => service.TranscribeAsync(valid, CancellationToken.None));
            fail = false;
            Require(await service.TranscribeAsync(valid, CancellationToken.None) == "recovered");
            Require(await transcriber.TranscribeAsync(valid, CancellationToken.None) == "recognized");
        });

        var realModel = Environment.GetEnvironmentVariable("ICECLASS_IDEAS_VOICE_REAL_MODEL") == "1";
        if (realModel)
            await Check("bundled SenseVoice recognizes an in-memory speech fixture without downloads", async () =>
            {
                using var speech = new MemoryStream();
                using (var synth = new SpeechSynthesizer())
                {
                    var voice = synth.GetInstalledVoices().First(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "en");
                    synth.SelectVoice(voice.VoiceInfo.Name);
                    synth.SetOutputToWaveStream(speech);
                    synth.Speak("My idea is to build a small robot that helps us read.");
                    synth.SetOutputToNull();
                }
                speech.Position = 0;
                using var reader = new WaveFileReader(speech);
                var source = new WdlResamplingSampleProvider(reader.ToSampleProvider(), 16000);
                using var wav = new MemoryStream();
                using (var writer = new WaveFileWriter(wav, new WaveFormat(16000, 16, 1)))
                {
                    var buffer = new float[4096]; int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) writer.WriteSamples(buffer, 0, count);
                }
                var text = await new IdeasVoiceTranscriber().TranscribeAsync(Convert.ToBase64String(wav.ToArray()), CancellationToken.None);
                Require(text.Contains("robot", StringComparison.OrdinalIgnoreCase));
            });
        else Console.WriteLine("SKIP bundled model invocation (set ICECLASS_IDEAS_VOICE_REAL_MODEL=1 to enable)");

        if (output is not null)
        {
            Directory.CreateDirectory(output);
            await File.WriteAllTextAsync(Path.Combine(output, "ideas-voice-checks.json"), JsonSerializer.Serialize(new
            { realModel, failures, checks = results }, new JsonSerializerOptions { WriteIndented = true }));
        }
        Console.WriteLine($"{results.Count - failures}/{results.Count} ideas voice checks passed.");
        if (failures != 0) throw new InvalidOperationException($"{failures} ideas voice checks failed.");
    }

    private static void Require(bool condition)
    {
        if (!condition) throw new InvalidOperationException("Unexpected transcription behavior.");
    }

    private static async Task<T> Throws<T>(Func<Task> run) where T : Exception
    {
        try { await run(); }
        catch (T error) { return error; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }

    private static byte[] Wav(int samples = 1600, short amplitude = 4096)
    {
        using var memory = new MemoryStream();
        using var writer = new BinaryWriter(memory, Encoding.ASCII, leaveOpen: true);
        writer.Write("RIFF"u8); writer.Write(36 + samples * 2); writer.Write("WAVEfmt "u8); writer.Write(16);
        writer.Write((ushort)1); writer.Write((ushort)1); writer.Write(16000); writer.Write(32000);
        writer.Write((ushort)2); writer.Write((ushort)16); writer.Write("data"u8); writer.Write(samples * 2);
        for (var index = 0; index < samples; ++index) writer.Write(index % 2 == 0 ? amplitude : (short)-amplitude);
        return memory.ToArray();
    }
}

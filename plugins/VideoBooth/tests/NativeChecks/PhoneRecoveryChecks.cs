using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using ICeClass.VideoBooth;
using ICeClass.VideoBooth.Transport;

internal static class PhoneRecoveryChecks
{
    internal static async Task Run(Form owner)
    {
        var directory = Path.Combine(Path.GetTempPath(), "ICeClass.VideoBooth.Fix1", Guid.NewGuid().ToString("N"));
        var configurationDirectory = Path.Combine(directory, "application");
        var dataDirectory = Path.Combine(directory, "data");
        var keyDirectory = Path.Combine(dataDirectory, "managed-preparation");
        Directory.CreateDirectory(configurationDirectory);
        Directory.CreateDirectory(keyDirectory);
        await File.WriteAllTextAsync(Path.Combine(configurationDirectory, "preparation-service.json"),
            JsonSerializer.Serialize(new { url = "http://127.0.0.1:9/", cameraDomain = "camera.invalid" }));
        var originalBaseDirectory = AppContext.BaseDirectory;
        Exception? unhandled = null;
        ThreadExceptionEventHandler onUnhandled = (_, args) => unhandled = args.Exception;
        Application.ThreadException += onUnhandled;
        AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", configurationDirectory);
        try
        {
            Program.Expect(AppContext.BaseDirectory == configurationDirectory, "phone preparation configuration isolated from installed application");
            await using var server = await Task.Run(() => BoothServer.Start(dataDirectory));
            using var window = new WorkbenchForm(server);
            window.Show(owner);
            await window.Initialized.WaitAsync(TimeSpan.FromSeconds(30));
            async Task<string> Script(string code) => await window.Browser.CoreWebView2.ExecuteScriptAsync(code);
            var keyFile = Path.Combine(keyDirectory, "device-key.pem");
            foreach (var (name, pem) in new[]
            {
                ("blank", "   \r\n"),
                ("truncated", "-----BEGIN PRIVATE KEY-----\nMII"),
                ("invalid DER", "-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----")
            })
            {
                unhandled = null;
                var bytes = Encoding.UTF8.GetBytes(pem);
                await File.WriteAllBytesAsync(keyFile, bytes);
                await Script("window.booth.setNativeStatus('待重试');window.chrome.webview.postMessage({type:'prepare_phone',payload:{}})");
                var deadline = DateTime.UtcNow.AddSeconds(8);
                var failed = false;
                while (DateTime.UtcNow < deadline && !window.IsDisposed)
                {
                    if (unhandled is not null) throw new InvalidOperationException("Recoverable " + name + " PEM escaped async web message boundary.", unhandled);
                    if (await Script("document.getElementById('status').textContent.startsWith('手机连接准备失败：')") == "true") { failed = true; break; }
                    await Task.Delay(40);
                }
                Program.Expect(failed && !window.IsDisposed && unhandled is null, name + " PEM displays recoverable error and keeps actual window alive");
                Program.Expect((await File.ReadAllBytesAsync(keyFile)).SequenceEqual(bytes), name + " persisted PEM is preserved for recovery");
                Program.Expect(await Script("window.booth.ready && document.getElementById('status').classList.contains('error')") == "true", name + " error leaves page ready with visible error state");
            }
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var profile = await http.GetByteArrayAsync($"http://127.0.0.1:{server.HttpPort}/certificate.mobileconfig");
            var text = Encoding.UTF8.GetString(profile);
            using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null });
            var xml = XDocument.Load(reader);
            string[] Values(string key) => xml.Descendants("key").Where(element => element.Value == key)
                .Select(element => ((XElement)element.NextNode!).Value).ToArray();
            Program.Expect(Values("PayloadDisplayName").SequenceEqual(new[] { "视频展台证书", "视频展台" }) && !text.Contains("善忠", StringComparison.Ordinal), "real mobileconfig route contains only new product display names");
            Program.Expect(Values("PayloadDescription").All(value => value.Contains("视频展台", StringComparison.Ordinal)), "both generated profile descriptions name 视频展台");
            Program.Expect(Convert.FromBase64String(xml.Descendants("data").Single().Value).SequenceEqual(server.Certificates.PublicCertificate), "profile still embeds this isolated server certificate");
            window.Close();
            var closeDeadline = DateTime.UtcNow.AddSeconds(5);
            while (!window.IsDisposed && DateTime.UtcNow < closeDeadline) await Task.Delay(40);
            Program.Expect(window.IsDisposed, "phone failure recovery window closes normally");
            Console.WriteLine("Fix round1 isolated artifacts: " + directory);
        }
        finally
        {
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", originalBaseDirectory);
            Application.ThreadException -= onUnhandled;
        }
    }
}

using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Receiver;

internal static class ClassroomBanbanReview
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static T Field<T>(object target, string name) => (T)target.GetType().GetField(name, Private)!.GetValue(target)!;

    internal static void Run(string bindingPath, string output)
    {
        if (!ReceiverConfig.TryRead(bindingPath, out var binding) || !ReceiverConfig.IsPreview(binding))
            throw new InvalidOperationException("The classroom account review requires a loopback demo binding.");
        var thread = new Thread(() => AppBuilder.Configure<IslandCheckHost>().UsePlatformDetect().WithInterFont()
            .AfterSetup(builder => Dispatcher.UIThread.Post(() => _ = Check(binding, Path.GetFullPath(output))))
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnExplicitShutdown));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }

    private static async Task Until(Func<Task<bool>> condition, string reason, int seconds = 35)
    {
        var clock = Stopwatch.StartNew();
        while (!await condition())
        {
            if (clock.Elapsed.TotalSeconds > seconds) throw new TimeoutException(reason);
            await Task.Delay(150);
        }
    }

    private static async Task Check(ReceiverConfig binding, string output)
    {
        Directory.CreateDirectory(output);
        var checks = new List<object>();
        BanbanVoiceWindow? assistant = null;
        using var http = new HttpClient(new HttpClientHandler { UseCookies = false })
            { BaseAddress = new Uri(binding.Endpoint), Timeout = TimeSpan.FromSeconds(8) };
        var restore = false;
        void Record(string name, bool passed)
        {
            checks.Add(new { name, passed });
            Console.WriteLine((passed ? "PASS " : "FAIL ") + name);
            if (!passed) throw new InvalidOperationException(name);
        }
        async Task Assign(bool assigned)
        {
            using var response = await http.PutAsJsonAsync("/api/teachers/preview-teacher/classes",
                new { classIds = assigned ? new[] { binding.ClassId } : Array.Empty<string>() });
            response.EnsureSuccessStatusCode();
        }
        try
        {
            using var session = await http.GetAsync("/api/session");
            if (!session.Headers.TryGetValues("X-ICeClass-Preview", out var demo) || !demo.Contains("1"))
                throw new InvalidOperationException("The live server is not an explicitly marked fictional preview.");
            using var login = await http.PostAsJsonAsync("/api/auth/login", new { username = "ICe", password = "LocalDemo2026" });
            login.EnsureSuccessStatusCode();
            var account = await login.Content.ReadFromJsonAsync<JsonElement>();
            http.DefaultRequestHeaders.Add("Cookie", login.Headers.GetValues("Set-Cookie").First().Split(';')[0]);
            http.DefaultRequestHeaders.Add("X-CSRF-Token", account.GetProperty("user").GetProperty("csrfToken").GetString());

            assistant = new BanbanVoiceWindow(binding, () => { }, enabled: false,
                petPreferencePath: Path.Combine(output, "pet-preferences.json"));
            await assistant.StartAsync();
            var browser = Field<ReadingBrowser>(assistant, "_browser");
            async Task<bool> Is(string code) => browser.Core is not null && await browser.Core.ExecuteScriptAsync(code) == "true";
            await Until(() => Is("window.ICeClass?.state?.user?.id === 'preview-teacher' && !!document.getElementById('bbInput')"),
                "The bound teacher did not enter Banban automatically.");
            await Until(() => Task.FromResult(Field<bool>(assistant, "_authorized")), "Native voice authorization did not become ready.");
            Record("bound classroom enters its homeroom teacher without a login action", true);
            Record("teacher login form and native reconnect overlay are hidden",
                await Is("document.getElementById('authPage').classList.contains('hidden')") && !Field<Border>(assistant, "_notice").IsVisible);
            Record("native page is limited to its bound class",
                await Is("window.ICeClass.state.classes.length === 1 && window.ICeClass.state.classes[0].id === " + JsonSerializer.Serialize(binding.ClassId)));
            Record("native device token is not exposed in the page state",
                await Is("!JSON.stringify(window.ICeClass.state).includes(" + JsonSerializer.Serialize(binding.DeviceToken) + ")"));
            var rotated = new ReceiverConfig { Endpoint = binding.Endpoint, DeviceId = binding.DeviceId,
                DeviceToken = binding.DeviceToken + "-rotated", ClassId = binding.ClassId, ClassName = binding.ClassName };
            Record("rotating the device token requires a fresh native window", !assistant.Matches(rotated));

            restore = true;
            await Assign(false);
            await Until(() => Task.FromResult(!Field<bool>(assistant, "_authorized")
                && Field<Border>(assistant, "_notice").IsVisible && Field<TextBlock>(assistant, "_status").Text!.Contains("尚未分配")),
                "Removing the homeroom assignment did not revoke the native account.");
            Record("removing the homeroom assignment stops authorization and explains the cause", true);
            Record("a missing homeroom assignment never opens the teacher login form",
                await Is("document.getElementById('authPage').classList.contains('hidden')"));
            assistant.Width = 380; assistant.Height = 500;
            await Task.Delay(150);
            Record("reconnect message remains within the narrow window",
                Field<TextBlock>(assistant, "_status").Bounds.Width <= assistant.Bounds.Width);
            await Assign(true); restore = false;
            await Until(() => Is("window.ICeClass?.state?.user?.id === 'preview-teacher'") , "Restoring the teacher did not restore the account.");
            await Until(() => Task.FromResult(Field<bool>(assistant, "_authorized")), "The teacher account did not recover automatically.");
            Record("restoring the homeroom assignment reconnects automatically without login", true);
        }
        catch (Exception error)
        {
            checks.Add(new { name = "native classroom account review", passed = false, error = error.Message });
            Console.Error.WriteLine(error); Environment.ExitCode = 1;
        }
        finally
        {
            try { if (restore) await Assign(true); }
            catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
            File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(checks, new JsonSerializerOptions { WriteIndented = true }));
            assistant?.Shutdown();
            ((IClassicDesktopStyleApplicationLifetime)Application.Current!.ApplicationLifetime!).Shutdown();
        }
    }
}

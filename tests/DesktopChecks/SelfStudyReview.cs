using System.Reflection;
using System.Net.Http.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using ICeClass.Desktop;
using ICeClass.Receiver;

/// <summary>A separate manual workbench preview that never takes over a running teacher instance.</summary>
internal static class SelfStudyReview
{
    internal static void Run(string endpoint, string directory)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || !uri.IsLoopback)
            throw new ArgumentException("Manual review requires a loopback service.");
        var options = LaunchOptions.Parse(["--server", endpoint, "--data-dir", directory]);
        typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!
            .GetProperty("Options", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null, options);
        var thread = new Thread(() => AppBuilder.Configure<SelfStudyReviewHost>().UsePlatformDetect()
            .StartWithClassicDesktopLifetime([], ShutdownMode.OnMainWindowClose));
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
    }
}
public sealed class SelfStudyReviewHost : Application
{
    private readonly App _product = new();
    public override void Initialize()
    {
        _product.Initialize();
        RequestedThemeVariant = Avalonia.Styling.ThemeVariant.Light;
        foreach (var resource in _product.Resources) Resources.Add(resource.Key, resource.Value);
        var styles = _product.Styles.ToArray(); _product.Styles.Clear();
        foreach (var style in styles) Styles.Add(style);
    }
    public override void OnFrameworkInitializationCompleted()
    {
        base.OnFrameworkInitializationCompleted();
        Dispatcher.UIThread.Post(() =>
        {
            var options = (LaunchOptions)typeof(App).Assembly.GetType("ICeClass.Desktop.Program")!
                .GetProperty("Options", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
            typeof(App).GetProperty("Settings", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(_product, DesktopSettings.Load(options.DataDirectory));
            var window = new DesktopWindow(_product, options.Endpoint!, false);
            window.Title += " · 晚自习管理本地验收";
            ((IClassicDesktopStyleApplicationLifetime)ApplicationLifetime!).MainWindow = window;
            window.Show(); window.Activate();
            _ = OpenModuleAsync(window, options.Endpoint!);
        });
    }
    private static async Task OpenModuleAsync(DesktopWindow window, string endpoint)
    {
        try
        {
            using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
            using var response = await client.PostAsJsonAsync(endpoint + "/api/auth/login",
                new { username = "teacher1", password = "LocalTeacher2026" });
            response.EnsureSuccessStatusCode();
            var cookie = response.Headers.GetValues("Set-Cookie").First(v => v.StartsWith("iceclass_session="))
                .Split(';')[0]["iceclass_session=".Length..];
            var browser = (ReadingBrowser)typeof(DesktopWindow).GetField("_browser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            for (var i = 0; i < 300 && browser.Core is null; i++) await Task.Delay(50);
            if (browser.Core is not { } core) return;
            var nativeCookie = core.CookieManager.CreateCookie("iceclass_session", cookie, new Uri(endpoint).Host, "/");
            nativeCookie.IsHttpOnly = true; core.CookieManager.AddOrUpdateCookie(nativeCookie);
            core.Navigate(endpoint + "/?view=self-study");
        }
        catch { /* The manual preview can still be opened with its documented demo login. */ }
    }
}

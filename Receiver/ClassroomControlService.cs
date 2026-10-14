using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace ICeClass.Receiver;

public static class ClassroomControlService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public static int? ReadVolume()
    {
        try
        {
            using var devices = new MMDeviceEnumerator();
            using var endpoint = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            return endpoint.AudioEndpointVolume.Mute ? 0 : (int)Math.Round(endpoint.AudioEndpointVolume.MasterVolumeLevelScalar * 100);
        }
        catch { return null; }
    }

    public static int SetVolume(int volume)
    {
        if (volume is < 0 or > 100) throw new ArgumentOutOfRangeException(nameof(volume));
        using var devices = new MMDeviceEnumerator();
        using var endpoint = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        endpoint.AudioEndpointVolume.MasterVolumeLevelScalar = volume / 100f;
        endpoint.AudioEndpointVolume.Mute = volume == 0;
        return (int)Math.Round(endpoint.AudioEndpointVolume.MasterVolumeLevelScalar * 100);
    }

    public static async Task OpenReadingAsync(ReceiverConfig config, CancellationToken cancellationToken = default)
    {
        var endpoint = config.Endpoint.TrimEnd('/');
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint + "/api/reading/launch?deviceId=" + Uri.EscapeDataString(config.DeviceId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        using var response = await Http.SendAsync(request, cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        using var body = JsonDocument.Parse(text);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(body.RootElement.TryGetProperty("error", out var error) ? error.GetString() : "早读陪伴暂时无法连接，请检查网络。");
        var ticket = body.RootElement.GetProperty("launchToken").GetString();
        if (string.IsNullOrWhiteSpace(ticket)) throw new InvalidOperationException("未取得早读打开链接，请重试。");
        Process.Start(new ProcessStartInfo(endpoint + "/reading/#launch=" + Uri.EscapeDataString(ticket)) { UseShellExecute = true });
    }
}

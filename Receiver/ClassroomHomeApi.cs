using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace ICeClass.Receiver;

/// <summary>Only the classroom homework endpoints are available to the local home page.</summary>
internal sealed class ClassroomHomeApi(HttpClient client)
{
    internal async Task<JsonElement> SendAsync(ReceiverConfig binding, string path, JsonElement? body, CancellationToken token)
    {
        var reading = path.Length == 0 || path.StartsWith("?date=", StringComparison.Ordinal) && path.Length == 16
            && DateOnly.TryParseExact(path[6..], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
        if (body is null ? !reading : path != "/records" || body.Value.ValueKind != JsonValueKind.Object
            || !body.Value.TryGetProperty("classId", out var classId) || classId.GetString() != binding.ClassId)
            throw new ArgumentException("作业请求无效，请重新打开班级管理。");
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Put,
            binding.Endpoint.TrimEnd('/') + "/api/homework/classroom" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", binding.DeviceToken);
        request.Headers.Add("X-ICeClass-Device-Id", binding.DeviceId);
        request.Headers.Add("X-ICeClass-Class-Id", binding.ClassId);
        if (body is not null) request.Content = new StringContent(body.Value.GetRawText(), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, token);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(json.RootElement.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String
                ? error.GetString() : "暂时无法连接，请稍后重新载入。");
        return json.RootElement.Clone();
    }
}

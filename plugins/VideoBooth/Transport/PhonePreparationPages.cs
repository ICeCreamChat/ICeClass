using System.Net;
using System.Text;
using System.Text.Json;

namespace ICeClass.VideoBooth.Transport;

public static class PhonePreparationPages
{
    public static string Public(PhonePreparationEnvelope? envelope) =>
        Encoding.UTF8.GetString(SiteAssets.Read("preparation-phone.html")!)
            .Replace("__RELAY_JSON__", JsonSerializer.Serialize(envelope, new JsonSerializerOptions(JsonSerializerDefaults.Web)));

    public static string Relay(PhonePreparationEnvelope envelope, string destination) => $$"""
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>正在准备展台连接</title><link rel="stylesheet" href="/assets/styles.css"><script type="module" src="/assets/phone-preparation-relay.js"></script></head>
        <body class="phone"><main class="phone-shell"><h1>已连接展台</h1><p>正在自动准备，请保持页面打开。</p>
        <form method="post" action="{{WebUtility.HtmlEncode(destination)}}">
        <input type="hidden" name="sessionId" value="{{WebUtility.HtmlEncode(envelope.SessionId)}}">
        <input type="hidden" name="payload" value="{{WebUtility.HtmlEncode(envelope.Payload)}}">
        <button class="primary wide" type="submit">继续连接</button></form></main></body></html>
        """;
}

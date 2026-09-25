using System.Net.Http.Headers;

namespace Tlain.Downloader2.Core;

public static class HeaderPolicy
{
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "accept", "accept-language", "authorization", "cookie", "origin", "referer", "user-agent"
    };

    private static readonly HashSet<string> OriginBound = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization", "cookie"
    };

    public static IReadOnlyDictionary<string, string> Normalize(IReadOnlyDictionary<string, string>? input)
    {
        var output = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in input ?? new Dictionary<string, string>())
        {
            var name = pair.Key.Trim();
            var value = pair.Value.Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal).Replace("\0", "", StringComparison.Ordinal);
            if (Allowed.Contains(name) && value.Length is > 0 and <= 16384) output[name.ToLowerInvariant()] = value;
        }
        return output;
    }

    public static IReadOnlyDictionary<string, string> ForExternalTool(IReadOnlyDictionary<string, string>? input) =>
        Normalize(input).Where(pair => !OriginBound.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);

    public static void Apply(HttpRequestMessage request, IReadOnlyDictionary<string, string> headers, Uri credentialOrigin)
    {
        foreach (var pair in headers)
        {
            if (OriginBound.Contains(pair.Key) && Origin(request.RequestUri!) != Origin(credentialOrigin)) continue;
            if (pair.Key.Equals("referer", StringComparison.OrdinalIgnoreCase) && Uri.TryCreate(pair.Value, UriKind.Absolute, out var referer)) request.Headers.Referrer = referer;
            else if (!request.Headers.TryAddWithoutValidation(pair.Key, pair.Value)) request.Content?.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
        }
    }

    public static Uri RequireHttpUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new DownloaderException("invalid_url", "http/httpsのメディアURLを確認してください。");
        return uri;
    }

    private static string Origin(Uri uri) => $"{uri.Scheme}://{uri.IdnHost}:{uri.Port}";
}

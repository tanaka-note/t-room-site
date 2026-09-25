using System.Text.RegularExpressions;

namespace Tlain.Downloader2.Core;

public static partial class ManifestInspector
{
    private static readonly string[] DrmMarkers =
    [
        "com.widevine.alpha", "com.microsoft.playready", "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",
        "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", "skd://"
    ];

    public static bool HasExplicitDrm(string text) => DrmMarkers.Any(marker => text.Contains(marker, StringComparison.OrdinalIgnoreCase));

    public static IReadOnlyList<Uri> HlsSegments(string playlist, Uri baseUri)
    {
        if (HasExplicitDrm(playlist)) throw new DownloaderException("drm_not_supported", "DRMで保護されたメディアには対応していません。");
        var output = new List<Uri>();
        foreach (var raw in playlist.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("#EXT-X-KEY", StringComparison.OrdinalIgnoreCase))
            {
                var method = Attribute(line, "METHOD");
                var keyFormat = Attribute(line, "KEYFORMAT");
                if (!string.Equals(method, "NONE", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(keyFormat) && !string.Equals(keyFormat.Trim('"'), "identity", StringComparison.OrdinalIgnoreCase))
                    throw new DownloaderException("drm_not_supported", "DRMで保護されたHLSには対応していません。");
                if (!string.Equals(method, "NONE", StringComparison.OrdinalIgnoreCase))
                    throw new DownloaderException("hls_encryption_external_engine_required", "暗号化HLSにはN_m3u8DL-REを配置してください。");
            }
            if (line.StartsWith("#EXT-X-MAP", StringComparison.OrdinalIgnoreCase))
            {
                var map = Attribute(line, "URI")?.Trim('"');
                if (!string.IsNullOrWhiteSpace(map)) output.Add(new Uri(baseUri, map));
            }
            else if (line.Length > 0 && !line.StartsWith('#')) output.Add(new Uri(baseUri, line));
        }
        return output;
    }

    public static Uri? BestVariant(string playlist, Uri baseUri)
    {
        if (HasExplicitDrm(playlist)) throw new DownloaderException("drm_not_supported", "DRMで保護されたメディアには対応していません。");
        var lines = playlist.Split('\n');
        Uri? best = null;
        long bestBandwidth = -1;
        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index].Trim();
            if (!line.StartsWith("#EXT-X-STREAM-INF", StringComparison.OrdinalIgnoreCase)) continue;
            var bandwidth = long.TryParse(Attribute(line, "BANDWIDTH"), out var value) ? value : 0;
            var next = lines.Skip(index + 1).Select(item => item.Trim()).FirstOrDefault(item => item.Length > 0 && !item.StartsWith('#'));
            if (next is not null && bandwidth >= bestBandwidth) { best = new Uri(baseUri, next); bestBandwidth = bandwidth; }
        }
        return best;
    }

    private static string? Attribute(string line, string name) => AttributeRegex(name).Match(line).Groups[1].Value is { Length: > 0 } value ? value : null;

    private static Regex AttributeRegex(string name) => new($"(?:^|,){Regex.Escape(name)}=(\"[^\"]*\"|[^,]*)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}

using System.Text.Json;
using System.Text.RegularExpressions;

namespace XDownloader.Core;

public sealed record Quality(string Label, string Selector)
{
    public override string ToString() => Label;
}

public sealed record VideoInfo(string Id, string Title, double? Duration, IReadOnlyList<Quality> Qualities)
{
    public override string ToString() => Duration is > 0 ? $"{Title}（{TimeSpan.FromSeconds(Duration.Value):g}）" : Title;
}

public static partial class MediaInfo
{
    public const string BestMp4 = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*[ext=mp4]+ba";

    public static IReadOnlyList<VideoInfo> Parse(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 });
        var root = document.RootElement;
        var entries = root.TryGetProperty("entries", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().ToArray() : [root];
        var videos = new List<VideoInfo>();
        foreach (var entry in entries)
        {
            if (entry.ValueKind != JsonValueKind.Object) continue;
            if (Text(entry, "live_status") is "is_live" or "is_upcoming" or "post_live") continue;
            var id = Text(entry, "id");
            if (!IdPattern().IsMatch(id)) continue;
            if (!entry.TryGetProperty("formats", out var formats) || formats.ValueKind != JsonValueKind.Array) continue;
            var usable = formats.EnumerateArray().Where(f => Text(f, "ext") == "mp4"
                && Text(f, "vcodec") != "none" && !Boolean(f, "has_drm")
                && Text(f, "protocol") is "https" or "http" or "m3u8_native" or "m3u8"
                && FormatPattern().IsMatch(Text(f, "format_id"))).ToArray();
            if (usable.Length == 0) continue;
            var qualities = new List<Quality> { new("最高画質（自動・MP4）", BestMp4) };
            foreach (var format in usable.OrderByDescending(f => Number(f, "height")).ThenByDescending(f => Number(f, "tbr")))
            {
                var formatId = Text(format, "format_id");
                var selector = Text(format, "acodec") == "none" ? $"{formatId}+ba[ext=m4a]/{formatId}+ba" : formatId;
                var height = Number(format, "height");
                var bitrate = Number(format, "tbr");
                var label = $"{(height > 0 ? $"{height:0}p" : "解像度不明")} / {(bitrate > 0 ? $"{bitrate:0} kbps" : formatId)} / {(Text(format, "protocol").StartsWith("m3u8", StringComparison.Ordinal) ? "HLS" : "MP4")}";
                qualities.Add(new(label, selector));
            }
            var duration = Number(entry, "duration");
            videos.Add(new(id, Text(entry, "title") is { Length: > 0 } title ? title : $"動画 {videos.Count + 1}",
                duration > 0 ? duration : null, qualities));
        }
        if (videos.Count == 0) throw new InvalidOperationException("保存できるMP4動画がありません。動画なし・ライブ・閲覧制限・未対応形式の可能性があります。");
        return videos.DistinctBy(v => v.Id).ToArray();
    }

    private static bool Boolean(JsonElement value, string key) => value.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.True;
    private static string Text(JsonElement value, string key) => value.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
    private static double Number(JsonElement value, string key) => value.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var n) && double.IsFinite(n) ? n : 0;
    [GeneratedRegex(@"^[0-9]{1,25}$")]
    private static partial Regex IdPattern();
    [GeneratedRegex(@"^[A-Za-z0-9_.-]{1,150}$")]
    private static partial Regex FormatPattern();
}

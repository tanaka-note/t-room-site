using System.Globalization;
using System.Text.RegularExpressions;

namespace XDownloader.Core;

public static partial class SaveFileName
{
    public const int MaxTitleLength = 160;
    private const string InvalidWindowsCharacters = "<>:\"/\\|?*";

    public static string Suggest(VideoInfo video, DateTimeOffset loadedAt)
    {
        var prefix = loadedAt.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "_X";
        var author = OneLine(video.Uploader ?? "");
        var title = OneLine(video.Title);
        // The Twitter extractor puts the display name before the post text.
        // Move that exact prefix to the requested suffix without duplicating it.
        if (author.Length > 0 && title.StartsWith(author + " - ", StringComparison.Ordinal))
            title = title[(author.Length + 3)..];
        if (title.Length == 0) title = "動画";
        var suffix = author.Length > 0 ? $"（{Truncate(author, 58)}）" : "";
        return prefix + Truncate(title, MaxTitleLength - prefix.Length - suffix.Length) + suffix;
    }

    public static string NormalizeTitle(string title)
    {
        var clean = OneLine(title);
        clean = new string(clean.Where(c => !char.IsControl(c) && !InvalidWindowsCharacters.Contains(c)).ToArray());
        clean = Truncate(clean.Trim().TrimEnd('.'), MaxTitleLength).TrimEnd().TrimEnd('.');
        if (string.IsNullOrWhiteSpace(clean)) throw new ArgumentException("保存タイトルを入力してください。ファイル名に使えない文字だけのタイトルは保存できません。");
        // The editable date can be removed, so a Windows device name may now be the entire title.
        if (ReservedName().IsMatch(clean)) clean = "_" + Truncate(clean, MaxTitleLength - 1).TrimEnd().TrimEnd('.');
        return clean;
    }

    public static bool IsUsable(string title)
    {
        try { NormalizeTitle(title); return true; }
        catch (ArgumentException) { return false; }
    }

    public static string Stem(string title) => NormalizeTitle(title);

    private static string OneLine(string value) => Whitespace().Replace(value, " ").Trim();
    private static string Truncate(string value, int length)
    {
        if (value.Length <= length) return value;
        var end = length;
        if (end > 0 && char.IsHighSurrogate(value[end - 1])) end--;
        return value[..end].TrimEnd();
    }
    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
    [GeneratedRegex(@"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReservedName();
}

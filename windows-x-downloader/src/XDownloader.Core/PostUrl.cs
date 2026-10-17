using System.Text.RegularExpressions;

namespace XDownloader.Core;

public static partial class PostUrl
{
    private static readonly HashSet<string> Hosts = new(StringComparer.OrdinalIgnoreCase)
    { "x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com" };

    public static string Normalize(string input)
    {
        if (input.Length > 4096 || !Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || !Hosts.Contains(uri.IdnHost))
            throw new ArgumentException("https://x.com/ユーザー名/status/数字 の投稿URLを入力してください。");
        var match = PathPattern().Match(uri.AbsolutePath);
        if (!match.Success) throw new ArgumentException("動画を含む投稿のURLを入力してください。プロフィールや検索URLには対応していません。");
        var account = match.Groups["account"].Value;
        if (account == "i/web") account = "i";
        return $"https://x.com/{account}/status/{match.Groups["id"].Value}"
            + (match.Groups["index"].Success ? $"/video/{match.Groups["index"].Value}" : "");
    }

    [GeneratedRegex(@"^/(?<account>[A-Za-z0-9_]{1,50}|i/web)/status/(?<id>[0-9]{1,25})(?:/video/(?<index>[1-9][0-9]?))?/?$", RegexOptions.CultureInvariant)]
    private static partial Regex PathPattern();
}

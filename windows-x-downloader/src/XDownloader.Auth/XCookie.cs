using System.Globalization;

namespace XDownloader.Auth;

public sealed record XCookie(string Domain, string Name, string Value, string Path, bool Secure, bool HttpOnly, double Expires)
{
    public override string ToString() => $"{Name} ({Domain}, value redacted)";
    private static readonly HashSet<string> Domains = new(StringComparer.Ordinal)
        { ".x.com", "x.com", ".twitter.com", "twitter.com" };
    private static readonly HashSet<string> Names = new(StringComparer.Ordinal) { "auth_token", "ct0", "twid" };

    public bool IsAllowed(DateTimeOffset now) => Domains.Contains(Domain) && Names.Contains(Name) && Secure && Path == "/"
        && Value is { Length: > 0 and <= 16384 } && !Value.Any(char.IsControl) && !Value.Any(char.IsWhiteSpace)
        && double.IsFinite(Expires) && Expires <= 253402300799 && (Expires <= 0 || Expires > now.ToUnixTimeSeconds())
        && (Name != "auth_token" || HttpOnly);

    public string ToNetscapeLine() => $"{(HttpOnly ? "#HttpOnly_" : "")}{Domain}\t{(Domain.StartsWith('.') ? "TRUE" : "FALSE")}\t{Path}\tTRUE\t{(Expires > 0 ? ((long)Expires).ToString(CultureInfo.InvariantCulture) : "0")}\t{Name}\t{Value}";

    public static IReadOnlyList<XCookie> Filter(IEnumerable<XCookie> cookies, DateTimeOffset now)
    {
        var selected = cookies.Where(c => c.IsAllowed(now)).DistinctBy(c => (c.Domain,c.Name,c.Path)).Take(20).ToArray();
        // The extractor authenticates its API requests to api.x.com. A host-only x.com cookie is insufficient.
        if (!selected.Any(c => c.Domain == ".x.com" && c.Name == "auth_token")
            || !selected.Any(c => c.Domain == ".x.com" && c.Name == "ct0"))
            throw new InvalidOperationException("Xへのログイン完了を確認できません。ユーザー名・パスワード・追加認証を完了してから、もう一度押してください。");
        return selected;
    }
}

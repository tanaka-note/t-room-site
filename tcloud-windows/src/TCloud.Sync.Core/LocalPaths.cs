using System.Text;

namespace TCloud.Sync.Core;

public static class LocalPaths
{
    public static string ResolveUnderRoot(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.Contains(':')
            || relative.Split(['/', '\\']).Any(part => part is "" or "." or ".."))
            throw new ArgumentException("保存先の相対パスが不正です。", nameof(relative));
        var fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var path = Path.GetFullPath(Path.Combine(fullRoot, relative));
        if (!path.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("保存先の範囲外には操作できません。", nameof(relative));
        var current = fullRoot;
        if (new DirectoryInfo(fullRoot).LinkTarget is not null)
            throw new IOException("リンクを経由した保存先は操作できません。");
        // Cloud Files directories are also reparse points, but not symbolic links.
        foreach (var part in Path.GetRelativePath(fullRoot, path).Split(Path.DirectorySeparatorChar).SkipLast(1))
        {
            current = Path.Combine(current, part);
            if (Directory.Exists(current) && new DirectoryInfo(current).LinkTarget is not null)
                throw new IOException("リンクを経由した保存先は操作できません。");
        }
        return path;
    }

    // Escaping is reversible and reserves '~' as its marker. The cloud name is
    // never changed; stable remote IDs disambiguate case-insensitive collisions.
    public static string EncodeName(string name)
    {
        if (string.IsNullOrEmpty(name)) throw new ArgumentException("名前が空です。", nameof(name));
        var builder = new StringBuilder();
        for (var i = 0; i < name.Length; i++)
        {
            var ch = name[i];
            if (ch < 32 || "<>:\"/\\|?*~".Contains(ch) || (i == name.Length - 1 && ch is ' ' or '.'))
                builder.Append('~').Append(((int)ch).ToString("X4"));
            else builder.Append(ch);
        }
        var encoded = builder.ToString();
        var stem = encoded.Split('.')[0];
        if (stem.Equals("CON", StringComparison.OrdinalIgnoreCase) || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
                || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && stem[3] is >= '0' and <= '9'))
            encoded = "~" + ((int)encoded[0]).ToString("X4") + encoded[1..];
        if (encoded is "." or "..") encoded = string.Concat(encoded.Select(ch => "~" + ((int)ch).ToString("X4")));
        if (encoded.Length > 240) throw new PathTooLongException("Windowsで表現できる長さを超えています。");
        return encoded;
    }
}

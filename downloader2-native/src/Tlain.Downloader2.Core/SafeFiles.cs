using System.Text;

namespace Tlain.Downloader2.Core;

public static class SafeFiles
{
    public static string DownloadsDirectory()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(profile, "Downloads");
    }

    public static string SafeName(string? title, string extension)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var source = string.IsNullOrWhiteSpace(title) ? "download" : title.Trim();
        var builder = new StringBuilder();
        foreach (var character in source.Normalize(NormalizationForm.FormC))
        {
            if (!invalid.Contains(character) && !char.IsControl(character)) builder.Append(character);
            if (builder.Length >= 100) break;
        }
        var stem = builder.ToString().Trim(' ', '.');
        if (string.IsNullOrEmpty(stem)) stem = "download";
        extension = extension.TrimStart('.').ToLowerInvariant();
        return $"{stem}.{extension}";
    }

    public static string UniquePath(string directory, string filename)
    {
        Directory.CreateDirectory(directory);
        var stem = Path.GetFileNameWithoutExtension(filename);
        var extension = Path.GetExtension(filename);
        var candidate = Path.Combine(directory, filename);
        for (var index = 2; File.Exists(candidate); index++) candidate = Path.Combine(directory, $"{stem} ({index}){extension}");
        return candidate;
    }
}

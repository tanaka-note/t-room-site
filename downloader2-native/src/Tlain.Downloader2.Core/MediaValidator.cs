using System.Diagnostics;
using System.Text.Json;

namespace Tlain.Downloader2.Core;

public sealed record MediaValidation(bool Valid, string? Resolution, double? DurationSeconds, string? Warning);

public sealed class MediaValidator(ToolLocator tools)
{
    public async Task<MediaValidation> ValidateAsync(string path, string kind, CancellationToken cancellationToken)
    {
        var length = new FileInfo(path).Length;
        if (length <= 0) return new(false, null, null, null);
        var ffprobe = tools.Find("ffprobe");
        if (ffprobe is null) return Basic(path, kind) ? new(true, null, null, "ffprobeがないため基本形式だけを確認しました。") : new(false, null, null, null);
        var start = new ProcessStartInfo(ffprobe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new DownloaderException("ffprobe_failed", "ffprobeを起動できませんでした。");
        var output = await process.StandardOutput.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        _ = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        if (process.ExitCode != 0) return new(false, null, null, null);
        using var document = JsonDocument.Parse(output);
        var streams = document.RootElement.TryGetProperty("streams", out var streamArray) ? streamArray : default;
        var media = streams.ValueKind == JsonValueKind.Array && streams.EnumerateArray().Any(item => item.TryGetProperty("codec_type", out var type) && (type.GetString() is "video" or "audio"));
        if (!media) return new(false, null, null, null);
        var video = streams.EnumerateArray().FirstOrDefault(item => item.TryGetProperty("codec_type", out var type) && type.GetString() == "video");
        var resolution = video.ValueKind == JsonValueKind.Object && video.TryGetProperty("width", out var width) && video.TryGetProperty("height", out var height) ? $"{width.GetInt32()}x{height.GetInt32()}" : null;
        double? duration = null;
        if (document.RootElement.TryGetProperty("format", out var format) && format.TryGetProperty("duration", out var durationValue) && double.TryParse(durationValue.GetString(), System.Globalization.CultureInfo.InvariantCulture, out var parsed)) duration = parsed;
        return new(true, resolution, duration, null);
    }

    private static bool Basic(string path, string kind)
    {
        Span<byte> header = stackalloc byte[16];
        using var stream = File.OpenRead(path);
        var count = stream.Read(header);
        if (count < 4) return false;
        if (kind == "hls") return header[0] == 0x47 || (count > 11 && header[4] == (byte)'f' && header[5] == (byte)'t' && header[6] == (byte)'y' && header[7] == (byte)'p');
        return (count > 11 && header[4] == (byte)'f' && header[5] == (byte)'t' && header[6] == (byte)'y' && header[7] == (byte)'p')
            || (header[0] == 0x1A && header[1] == 0x45 && header[2] == 0xDF && header[3] == 0xA3)
            || header[0] == 0x47;
    }
}

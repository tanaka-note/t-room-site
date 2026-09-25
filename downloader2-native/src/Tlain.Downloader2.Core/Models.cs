namespace Tlain.Downloader2.Core;

public sealed record MediaRequest(
    string Url,
    string Kind,
    string? ContentType,
    string? Title,
    IReadOnlyDictionary<string, string> Headers);

public sealed record DownloadProgress(string Stage, double? Percent = null, string? Detail = null);

public sealed record DownloadOutcome(
    string DownloadId,
    string Filename,
    string FullPath,
    long FileSize,
    string Engine,
    IReadOnlyList<string> Warnings);

public sealed record HistoryItem(
    string Id,
    string? Title,
    string Hostname,
    string Filename,
    long FileSize,
    string? Resolution,
    double? DurationSeconds,
    string Engine,
    string Status,
    double DownloadSeconds,
    DateTimeOffset CompletedAt);

public sealed class DownloaderException(string code, string message, Exception? inner = null) : Exception(message, inner)
{
    public string Code { get; } = code;
}

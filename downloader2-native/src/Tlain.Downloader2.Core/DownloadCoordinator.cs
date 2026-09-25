using System.Diagnostics;

namespace Tlain.Downloader2.Core;

public sealed class DownloadCoordinator(
    HttpTransport transport,
    ToolLocator tools,
    HistoryStore history,
    MediaValidator validator,
    IDefenderScanner defender,
    string? outputDirectory = null)
{
    public async Task<DownloadOutcome> DownloadAsync(string downloadId, MediaRequest request, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        var source = HeaderPolicy.RequireHttpUri(request.Url);
        if (request.Kind is not ("direct" or "hls" or "dash" or "generic")) throw new DownloaderException("invalid_media_kind", "メディア種別を確認できません。");
        var stopwatch = Stopwatch.StartNew();
        var warnings = new List<string>();
        var workRoot = Path.Combine(Path.GetTempPath(), "Tlain.Downloader2", downloadId);
        Directory.CreateDirectory(workRoot);
        var partPath = Path.Combine(workRoot, "media.tlain.part");
        var engine = "direct";
        try
        {
            if (request.Kind == "direct")
            {
                try { await new DirectDownloader(transport).DownloadPartAsync(request, partPath, progress, cancellationToken).ConfigureAwait(false); }
                catch (Exception error) when (error is DownloaderException && tools.Find("yt-dlp") is not null)
                {
                    engine = "yt-dlp";
                    partPath = await new ExternalToolRunner(tools).DownloadWithYtDlpAsync(request, workRoot, "media", cancellationToken).ConfigureAwait(false);
                }
            }
            else if (request.Kind == "hls" && tools.Find("N_m3u8DL-RE") is null)
            {
                engine = "hls-built-in";
                await new HlsDownloader(transport).DownloadPartAsync(request, partPath, progress, cancellationToken).ConfigureAwait(false);
            }
            else if (request.Kind is "hls" or "dash")
            {
                await EnsureManifestIsNotDrmAsync(source, request.Headers, cancellationToken).ConfigureAwait(false);
                engine = "N_m3u8DL-RE";
                partPath = await new ExternalToolRunner(tools).DownloadStreamAsync(request, workRoot, "media", cancellationToken).ConfigureAwait(false);
            }
            else
            {
                engine = "yt-dlp";
                partPath = await new ExternalToolRunner(tools).DownloadWithYtDlpAsync(request, workRoot, "media", cancellationToken).ConfigureAwait(false);
            }

            progress?.Report(new("validating"));
            var validation = await validator.ValidateAsync(partPath, request.Kind, cancellationToken).ConfigureAwait(false);
            if (!validation.Valid) throw new DownloaderException("media_validation_failed", "取得したファイルをメディアとして確認できませんでした。");
            if (validation.Warning is not null) warnings.Add(validation.Warning);

            progress?.Report(new("scanning"));
            var scan = await defender.ScanAsync(partPath, cancellationToken).ConfigureAwait(false);
            if (scan.MalwareDetected) throw new DownloaderException("malware_detected", "Windows Defenderが脅威を検出したため完成ファイルにしませんでした。");
            if (scan.Warning is not null) warnings.Add(scan.Warning);

            progress?.Report(new("finalizing"));
            var extension = ChooseExtension(request, partPath);
            var filename = SafeFiles.SafeName(request.Title, extension);
            var destination = SafeFiles.UniquePath(outputDirectory ?? SafeFiles.DownloadsDirectory(), filename);
            File.Move(partPath, destination);
            var size = new FileInfo(destination).Length;
            var historyItem = new HistoryItem(downloadId, request.Title, source.Host, Path.GetFileName(destination), size, validation.Resolution, validation.DurationSeconds, engine, "success", stopwatch.Elapsed.TotalSeconds, DateTimeOffset.UtcNow);
            await history.AddAsync(historyItem, cancellationToken).ConfigureAwait(false);
            return new(downloadId, Path.GetFileName(destination), destination, size, engine, warnings);
        }
        catch (OperationCanceledException)
        {
            await history.AddAsync(new(downloadId, request.Title, source.Host, "", 0, null, null, engine, "cancelled", stopwatch.Elapsed.TotalSeconds, DateTimeOffset.UtcNow), CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        catch
        {
            await history.AddAsync(new(downloadId, request.Title, source.Host, "", 0, null, null, engine, "failed", stopwatch.Elapsed.TotalSeconds, DateTimeOffset.UtcNow), CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        finally
        {
            try { if (Directory.Exists(workRoot)) Directory.Delete(workRoot, true); } catch { }
        }
    }

    private async Task EnsureManifestIsNotDrmAsync(Uri source, IReadOnlyDictionary<string, string> requestHeaders, CancellationToken cancellationToken)
    {
        using var response = await transport.SendAsync(source, HttpMethod.Get, HeaderPolicy.Normalize(requestHeaders), source, null, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new DownloaderException("manifest_failed", $"manifestを取得できませんでした（{(int)response.StatusCode}）。");
        if (response.Content.Headers.ContentLength is > 8 * 1024 * 1024) throw new DownloaderException("manifest_too_large", "manifestが大きすぎます。");
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (text.Length > 8 * 1024 * 1024) throw new DownloaderException("manifest_too_large", "manifestが大きすぎます。");
        if (ManifestInspector.HasExplicitDrm(text)) throw new DownloaderException("drm_not_supported", "DRMで保護されたメディアには対応していません。");
    }

    private static string ChooseExtension(MediaRequest request, string path)
    {
        var existing = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
        if (existing is "mp4" or "m4v" or "webm" or "m4a" or "ts" or "mkv") return existing;
        if (request.Kind == "hls") return "ts";
        if (request.ContentType?.Contains("webm", StringComparison.OrdinalIgnoreCase) == true) return "webm";
        return "mp4";
    }
}

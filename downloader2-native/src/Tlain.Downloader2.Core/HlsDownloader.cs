namespace Tlain.Downloader2.Core;

public sealed class HlsDownloader(HttpTransport transport)
{
    public async Task<string> DownloadPartAsync(MediaRequest request, string partPath, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        var source = HeaderPolicy.RequireHttpUri(request.Url);
        var headers = HeaderPolicy.Normalize(request.Headers);
        var playlistUri = source;
        var first = await ReadTextAsync(playlistUri, source, headers, cancellationToken).ConfigureAwait(false);
        var playlist = first.Text;
        playlistUri = first.FinalUri;
        var variant = ManifestInspector.BestVariant(playlist, playlistUri);
        if (variant is not null)
        {
            var selected = await ReadTextAsync(variant, source, headers, cancellationToken).ConfigureAwait(false);
            playlist = selected.Text;
            playlistUri = selected.FinalUri;
        }
        var segments = ManifestInspector.HlsSegments(playlist, playlistUri);
        if (segments.Count == 0) throw new DownloaderException("manifest_invalid", "HLS playlistにsegmentがありません。");
        Directory.CreateDirectory(Path.GetDirectoryName(partPath)!);
        await using var output = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        for (var index = 0; index < segments.Count; index++)
        {
            using var response = await transport.SendAsync(segments[index], HttpMethod.Get, headers, source, null, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new DownloaderException("hls_segment_failed", $"HLS segmentを取得できませんでした（{(int)response.StatusCode}）。");
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
            progress?.Report(new("downloading", (index + 1) * 100d / segments.Count, $"HLS {index + 1}/{segments.Count}"));
        }
        return partPath;
    }

    private async Task<(string Text, Uri FinalUri)> ReadTextAsync(Uri uri, Uri origin, IReadOnlyDictionary<string, string> headers, CancellationToken cancellationToken)
    {
        using var response = await transport.SendAsync(uri, HttpMethod.Get, headers, origin, null, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new DownloaderException("manifest_failed", $"manifestを取得できませんでした（{(int)response.StatusCode}）。");
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (text.Length > 8 * 1024 * 1024) throw new DownloaderException("manifest_too_large", "manifestが大きすぎます。");
        return (text, response.RequestMessage?.RequestUri ?? uri);
    }
}

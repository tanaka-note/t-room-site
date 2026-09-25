using System.Net;
using System.Net.Http.Headers;
using Microsoft.Win32.SafeHandles;

namespace Tlain.Downloader2.Core;

public sealed class DirectDownloader(HttpTransport transport)
{
    public async Task<string> DownloadPartAsync(MediaRequest request, string partPath, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken, int? forcedConnections = null)
    {
        var source = HeaderPolicy.RequireHttpUri(request.Url);
        var headers = HeaderPolicy.Normalize(request.Headers);
        progress?.Report(new("probing"));
        var probe = await ProbeAsync(source, headers, cancellationToken).ConfigureAwait(false);
        var connections = forcedConnections ?? AdaptiveConnections(probe.Length);
        if (probe.RangeSupported && probe.Length > 0 && connections > 1)
        {
            try
            {
                await ParallelDownloadAsync(probe.FinalUri, source, headers, partPath, probe.Length, connections, progress, cancellationToken).ConfigureAwait(false);
                return partPath;
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                TryDelete(partPath);
                progress?.Report(new("downloading", null, "Range取得を単一streamへ切り替えました"));
            }
        }
        await SingleDownloadAsync(probe.FinalUri, source, headers, partPath, progress, cancellationToken).ConfigureAwait(false);
        return partPath;
    }

    public static int AdaptiveConnections(long length) => length >= 1024L * 1024 * 1024 ? 16 : length >= 256L * 1024 * 1024 ? 8 : length >= 32L * 1024 * 1024 ? 4 : 1;

    private async Task<(Uri FinalUri, long Length, bool RangeSupported)> ProbeAsync(Uri source, IReadOnlyDictionary<string, string> headers, CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using var response = await transport.SendAsync(source, HttpMethod.Get, headers, source, new RangeHeaderValue(0, 0), cancellationToken).ConfigureAwait(false);
                if (response.StatusCode is HttpStatusCode.Forbidden or (HttpStatusCode)429) return (response.RequestMessage?.RequestUri ?? source, response.Content.Headers.ContentLength ?? -1, false);
                if (!response.IsSuccessStatusCode)
                {
                    last = new DownloaderException("probe_failed", $"配信元の応答を確認できませんでした（{(int)response.StatusCode}）。");
                    if ((int)response.StatusCode >= 500 && attempt < 2) { await Task.Delay(200 * (attempt + 1), cancellationToken).ConfigureAwait(false); continue; }
                    throw last;
                }
                var total = response.Content.Headers.ContentRange?.Length ?? response.Content.Headers.ContentLength ?? -1;
                var range = response.StatusCode == HttpStatusCode.PartialContent && response.Content.Headers.ContentRange?.From == 0 && response.Content.Headers.ContentRange?.To == 0 && total > 0;
                return (response.RequestMessage?.RequestUri ?? source, total, range);
            }
            catch (Exception error) when (error is not OperationCanceledException and not DownloaderException && attempt < 2)
            {
                last = error;
                await Task.Delay(200 * (attempt + 1), cancellationToken).ConfigureAwait(false);
            }
        }
        throw last as DownloaderException ?? new DownloaderException("probe_failed", "配信元の応答を確認できませんでした。", last);
    }

    private async Task ParallelDownloadAsync(Uri uri, Uri credentialOrigin, IReadOnlyDictionary<string, string> headers, string path, long length, int connections, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await using (var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1, FileOptions.Asynchronous)) stream.SetLength(length);
        using SafeFileHandle handle = File.OpenHandle(path, FileMode.Open, FileAccess.Write, FileShare.Read, FileOptions.Asynchronous | FileOptions.RandomAccess);
        long downloaded = 0;
        var segmentSize = (length + connections - 1) / connections;
        var tasks = Enumerable.Range(0, connections).Select(async index =>
        {
            var start = index * segmentSize;
            var end = Math.Min(length - 1, start + segmentSize - 1);
            if (start > end) return;
            using var response = await transport.SendAsync(uri, HttpMethod.Get, headers, credentialOrigin, new RangeHeaderValue(start, end), cancellationToken).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.PartialContent || response.Content.Headers.ContentRange?.From != start || response.Content.Headers.ContentRange?.To != end)
                throw new DownloaderException("range_mismatch", "Range応答が要求範囲と一致しません。");
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var buffer = new byte[128 * 1024];
            long offset = start;
            while (true)
            {
                var count = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (count == 0) break;
                if (offset + count > end + 1) throw new DownloaderException("range_mismatch", "Range応答のサイズが一致しません。");
                await RandomAccess.WriteAsync(handle, buffer.AsMemory(0, count), offset, cancellationToken).ConfigureAwait(false);
                offset += count;
                var total = Interlocked.Add(ref downloaded, count);
                progress?.Report(new("downloading", total * 100d / length, $"{connections} connections"));
            }
            if (offset != end + 1) throw new DownloaderException("range_mismatch", "Range応答が途中で終了しました。");
        });
        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    private async Task SingleDownloadAsync(Uri uri, Uri credentialOrigin, IReadOnlyDictionary<string, string> headers, string path, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                using var response = await transport.SendAsync(uri, HttpMethod.Get, headers, credentialOrigin, null, cancellationToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) throw new DownloaderException(response.StatusCode == (HttpStatusCode)429 ? "rate_limited" : "download_failed", $"配信元から取得できませんでした（{(int)response.StatusCode}）。");
                var length = response.Content.Headers.ContentLength;
                await using var input = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
                await using var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                var buffer = new byte[128 * 1024];
                long downloaded = 0;
                while (true)
                {
                    var count = await input.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (count == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
                    downloaded += count;
                    progress?.Report(new("downloading", length > 0 ? downloaded * 100d / length.Value : null, "single stream"));
                }
                return;
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                last = error;
                TryDelete(path);
                if (attempt < 2) await Task.Delay(TimeSpan.FromMilliseconds(200 * (attempt + 1)), cancellationToken).ConfigureAwait(false);
            }
        }
        throw last as DownloaderException ?? new DownloaderException("download_failed", "メディアを取得できませんでした。", last);
    }

    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
}

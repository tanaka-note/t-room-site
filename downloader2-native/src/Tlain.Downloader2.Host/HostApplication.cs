using System.Collections.Concurrent;
using System.Text.Json;
using Tlain.Downloader2.Core;

namespace Tlain.Downloader2.Host;

internal sealed class HostApplication(NativeMessaging messaging)
{
    private readonly CredentialStore credentials = new();
    private readonly HistoryStore history = new();
    private readonly ToolLocator tools = new();
    private readonly PairingVerifier pairingVerifier = new();
    private readonly PairingChallengeState pairingChallenge = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> downloads = new();

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (await messaging.ReadAsync(cancellationToken).ConfigureAwait(false) is { } document)
        {
            using (document)
            {
                var root = document.RootElement;
                var requestId = RequiredString(root, "requestId", 128);
                try
                {
                    if (!root.TryGetProperty("version", out var version) || version.GetInt32() != 1) throw new DownloaderException("unsupported_protocol", "Native Messaging protocol versionに対応していません。");
                    var type = RequiredString(root, "type", 80);
                    var payload = root.TryGetProperty("payload", out var value) && value.ValueKind == JsonValueKind.Object ? value : default;
                    var result = await HandleAsync(type, requestId, payload, cancellationToken).ConfigureAwait(false);
                    await messaging.WriteAsync(new { version = 1, type = $"{type}.result", requestId, ok = true, result }, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    var code = error is DownloaderException downloader ? downloader.Code : "host_error";
                    var message = error is DownloaderException ? error.Message : "Windows Companionで処理を完了できませんでした。";
                    await messaging.WriteAsync(new { version = 1, type = "error", requestId, ok = false, error = new { code, message } }, cancellationToken).ConfigureAwait(false);
                }
            }
        }
    }

    private async Task<object> HandleAsync(string type, string requestId, JsonElement payload, CancellationToken cancellationToken)
    {
        if (type == "host.ping") return new { paired = credentials.Exists(), deviceId = credentials.DeviceIdOrNull(), platform = "windows", protocol = 1 };
        if (type == "device.pair.prepare") return PreparePairing();
        if (type == "device.pair") return await PairAsync(payload, cancellationToken).ConfigureAwait(false);
        if (!credentials.Exists()) throw new DownloaderException("pairing_required", "このPCを先にペアリングしてください。");
        if (type == "history.list") return new { items = await history.ListAsync(cancellationToken).ConfigureAwait(false) };
        if (type == "tools.status") return new { items = await Task.WhenAll(new[] { "ffprobe", "ffmpeg", "N_m3u8DL-RE", "yt-dlp" }.Select(name => tools.StatusAsync(name, cancellationToken))) };
        if (type == "download.start") return StartDownload(payload);
        if (type == "download.cancel") return CancelDownload(payload);
        throw new DownloaderException("unsupported_message", "未対応のNative Messagingメッセージです。");
    }

    private object PreparePairing()
    {
        if (credentials.Exists()) return new { paired = true, deviceId = credentials.DeviceIdOrNull(), deviceChallenge = (string?)null };
        var issued = pairingChallenge.Issue(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        return new { paired = false, deviceChallenge = issued.Challenge, expiresAt = issued.ExpiresAt };
    }

    private async Task<object> PairAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (credentials.Exists()) return new { paired = true, deviceId = credentials.DeviceIdOrNull() };
        var token = RequiredString(payload, "pairingToken", 4096);
        var expiresAt = RequiredLong(payload, "expiresAt");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (!pairingChallenge.TryGet(expiresAt, now, out var challenge))
            throw new DownloaderException("pairing_invalid", "ペアリングトークンが無効または期限切れです。");
        if (!await pairingVerifier.VerifyAsync(token, challenge, expiresAt, cancellationToken).ConfigureAwait(false))
            throw new DownloaderException("pairing_invalid", "ペアリングトークンを確認できませんでした。");
        if (!pairingChallenge.Consume(challenge)) throw new DownloaderException("pairing_invalid", "ペアリングchallengeを再利用できません。");
        var device = credentials.GetOrCreate();
        return new { paired = true, deviceId = device.DeviceId };
    }

    private object StartDownload(JsonElement payload)
    {
        if (!payload.TryGetProperty("candidate", out var candidate) || candidate.ValueKind != JsonValueKind.Object) throw new DownloaderException("invalid_candidate", "動画候補を確認できません。");
        if (candidate.TryGetProperty("drm", out var drm) && drm.ValueKind == JsonValueKind.True) throw new DownloaderException("drm_not_supported", "DRMで保護されたメディアには対応していません。");
        var url = RequiredString(candidate, "url", 16384);
        _ = HeaderPolicy.RequireHttpUri(url);
        var kind = RequiredString(candidate, "kind", 32);
        var contentType = OptionalString(candidate, "contentType", 200);
        var title = OptionalString(payload, "title", 200);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (candidate.TryGetProperty("requestContext", out var context) && context.TryGetProperty("headers", out var headerObject) && headerObject.ValueKind == JsonValueKind.Object)
            foreach (var header in headerObject.EnumerateObject()) if (header.Value.ValueKind == JsonValueKind.String) headers[header.Name] = header.Value.GetString()!;
        headers = new Dictionary<string, string>(HeaderPolicy.Normalize(headers), StringComparer.OrdinalIgnoreCase);
        var downloadId = Guid.NewGuid().ToString("N");
        var cancellation = new CancellationTokenSource();
        if (!downloads.TryAdd(downloadId, cancellation)) throw new DownloaderException("download_start_failed", "保存処理を開始できませんでした。");
        _ = RunDownloadAsync(downloadId, new(url, kind, contentType, title, headers), cancellation);
        return new { downloadId };
    }

    private object CancelDownload(JsonElement payload)
    {
        var id = RequiredString(payload, "downloadId", 64);
        if (!downloads.TryGetValue(id, out var cancellation)) return new { cancelled = false };
        cancellation.Cancel();
        return new { cancelled = true };
    }

    private async Task RunDownloadAsync(string id, MediaRequest request, CancellationTokenSource cancellation)
    {
        try
        {
            using var transport = new HttpTransport();
            var coordinator = new DownloadCoordinator(transport, tools, history, new MediaValidator(tools), new DefenderScanner());
            var progress = new Progress<DownloadProgress>(item => _ = messaging.WriteAsync(new { version = 1, type = "download.progress", downloadId = id, stage = item.Stage, percent = item.Percent, detail = item.Detail }));
            var result = await coordinator.DownloadAsync(id, request, progress, cancellation.Token).ConfigureAwait(false);
            await messaging.WriteAsync(new { version = 1, type = "download.progress", downloadId = id, stage = "completed", percent = 100, filename = result.Filename, detail = string.Join(" ", result.Warnings) }).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await messaging.WriteAsync(new { version = 1, type = "download.progress", downloadId = id, stage = "cancelled" }).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            var code = error is DownloaderException downloader ? downloader.Code : "download_failed";
            var message = error is DownloaderException ? error.Message : "ローカル保存を完了できませんでした。";
            await messaging.WriteAsync(new { version = 1, type = "download.progress", downloadId = id, stage = "failed", error = message, errorCode = code }).ConfigureAwait(false);
        }
        finally { downloads.TryRemove(id, out _); cancellation.Dispose(); }
    }

    private static string RequiredString(JsonElement element, string name, int max)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) throw new DownloaderException("invalid_message", $"{name}が必要です。");
        var text = value.GetString() ?? "";
        if (text.Length is < 1 || text.Length > max || text.Any(char.IsControl)) throw new DownloaderException("invalid_message", $"{name}を確認してください。");
        return text;
    }

    private static string? OptionalString(JsonElement element, string name, int max) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? (value.GetString() ?? "")[..Math.Min(value.GetString()?.Length ?? 0, max)] : null;
    private static long RequiredLong(JsonElement element, string name) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) ? number : throw new DownloaderException("invalid_message", $"{name}が必要です。");
}

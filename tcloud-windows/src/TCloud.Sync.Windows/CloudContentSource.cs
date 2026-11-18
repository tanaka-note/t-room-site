using System.Net;
using System.Net.Http.Headers;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

/// <summary>Reads ciphertext only from the current authenticated T-Cloud origin.</summary>
public sealed class CloudContentSource : IEncryptedRangeSource
{
    private readonly HttpClient client;
    private readonly Uri endpoint;
    private readonly long encryptedLength;

    public CloudContentSource(HttpClient client, long fileId, long encryptedLength)
    {
        ArgumentNullException.ThrowIfNull(client);
        if (fileId < 1 || encryptedLength < 33) throw new ArgumentOutOfRangeException(nameof(fileId));
        if (!client.DefaultRequestHeaders.TryGetValues("X-TCloud-Session", out var values)
            || values.Count() != 1 || string.IsNullOrWhiteSpace(values.Single()))
            throw new InvalidOperationException("認証済みのT-Cloudセッションが必要です。");
        this.client = client;
        this.encryptedLength = encryptedLength;
        endpoint = new(WindowsPasskey.Origin + "/cloud/api/files/" + fileId + "/download");
    }

    public async ValueTask<EncryptedRangeResponse> ReadAsync(long offset, int length, string? expectedEntityTag,
        CancellationToken cancellationToken)
    {
        if (offset < 0 || length is < 1 or > 64 * 1024 * 1024 + 32 || offset > encryptedLength - length)
            throw new ArgumentOutOfRangeException(nameof(offset));
        if (expectedEntityTag is not null && !CiphertextEntityTag.IsStrong(expectedEntityTag))
            throw new InvalidDataException("ファイルの版が不正です。");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        var token = timeout.Token;
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Range = new RangeHeaderValue(offset, offset + length - 1);
        if (expectedEntityTag is not null) request.Headers.IfMatch.Add(EntityTagHeaderValue.Parse(expectedEntityTag));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new UnauthorizedAccessException("T-Cloudのログインまたは権限の再確認が必要です。");
        if (response.StatusCode != HttpStatusCode.PartialContent)
            throw new HttpRequestException("暗号化ファイルの指定範囲を取得できません。", null, response.StatusCode);
        var range = response.Content.Headers.ContentRange;
        var entityTag = response.Headers.ETag?.ToString();
        if (range?.Unit != "bytes" || range.From != offset || range.To != offset + length - 1 || range.Length != encryptedLength
            || response.Content.Headers.ContentLength is { } contentLength && contentLength != length
            || !CiphertextEntityTag.IsStrong(entityTag)
            || expectedEntityTag is not null && !StringComparer.Ordinal.Equals(expectedEntityTag, entityTag))
            throw new IOException("取得した暗号化ファイルの範囲または版が一致しません。");
        await using var body = await response.Content.ReadAsStreamAsync(token);
        var ciphertext = new byte[length];
        await body.ReadExactlyAsync(ciphertext, token);
        if (await body.ReadAsync(new byte[1], token) != 0) throw new IOException("暗号化ファイルの応答が指定範囲を超えています。");
        return new(ciphertext, entityTag!, encryptedLength);
    }
}

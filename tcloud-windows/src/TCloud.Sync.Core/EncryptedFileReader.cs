using System.Net.Http.Headers;
using System.Security.Cryptography;

namespace TCloud.Sync.Core;

public sealed record EncryptedFileLayout(long SizeBytes, int ChunkSizeBytes, int ChunkCount, long EncryptedSizeBytes)
{
    public void Validate()
    {
        if (SizeBytes < 1 || ChunkSizeBytes is < 1 or > 64 * 1024 * 1024 || ChunkCount is < 1 or > 10000
            || (SizeBytes - 1) / ChunkSizeBytes + 1 != ChunkCount
            || SizeBytes > 64L * 1024 * 1024 * 10000
            || EncryptedSizeBytes != SizeBytes + 32L * ChunkCount)
            throw new InvalidDataException("暗号化ファイルの分割情報が不正です。");
    }
}

public sealed record EncryptedRangeResponse(byte[] Ciphertext, string EntityTag, long TotalBytes);
public interface IEncryptedRangeSource
{
    ValueTask<EncryptedRangeResponse> ReadAsync(long offset, int length, string? expectedEntityTag, CancellationToken cancellationToken);
}

public static class CiphertextEntityTag
{
    public static bool IsStrong(string? value) => value is { Length: > 1 and <= 256 }
        && EntityTagHeaderValue.TryParse(value, out var tag) && !tag.IsWeak && tag.Tag != "*";
}

/// <summary>Authenticates whole TRC1 chunks and never joins ciphertext from different R2 versions.</summary>
public sealed class EncryptedFileReader : IAsyncDisposable
{
    private readonly EncryptedFileLayout layout;
    private readonly IEncryptedRangeSource source;
    private readonly byte[] fileKey;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private byte[]? cached;
    private int cachedIndex = -1;
    private string? entityTag;
    private int disposed;
    public long Length => layout.SizeBytes;
    public string? EntityTag => entityTag;

    public EncryptedFileReader(EncryptedFileLayout layout, ReadOnlySpan<byte> fileKey,
        IEncryptedRangeSource source, string? expectedEntityTag = null)
    {
        layout.Validate();
        ArgumentNullException.ThrowIfNull(source);
        if (fileKey.Length != 32) throw new CryptographicException("ファイル鍵の形式が不正です。");
        if (expectedEntityTag is not null && !CiphertextEntityTag.IsStrong(expectedEntityTag))
            throw new InvalidDataException("ファイルの版を確認できません。");
        this.layout = layout;
        this.source = source;
        this.fileKey = fileKey.ToArray();
        entityTag = expectedEntityTag;
    }

    public async ValueTask<int> ReadAsync(long offset, Memory<byte> destination, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        var token = linked.Token;
        await gate.WaitAsync(token);
        var written = 0;
        try
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            foreach (var slice in ChunkRanges.ForRead(layout.SizeBytes, layout.ChunkSizeBytes, offset, destination.Length))
            {
                if (cachedIndex != slice.Index)
                {
                    var response = await source.ReadAsync(slice.EncryptedOffset, slice.EncryptedLength, entityTag, token);
                    token.ThrowIfCancellationRequested();
                    if (response.Ciphertext.Length != slice.EncryptedLength || response.TotalBytes != layout.EncryptedSizeBytes
                        || !CiphertextEntityTag.IsStrong(response.EntityTag)
                        || entityTag is not null && !StringComparer.Ordinal.Equals(entityTag, response.EntityTag))
                        throw new IOException("取得中にファイルの版または保存内容が変わりました。");
                    entityTag ??= response.EntityTag;
                    var plaintext = EncryptedChunks.Decrypt(fileKey, response.Ciphertext, slice.Index);
                    if (cached is not null) CryptographicOperations.ZeroMemory(cached);
                    cached = plaintext;
                    cachedIndex = slice.Index;
                }
                token.ThrowIfCancellationRequested();
                cached!.AsMemory(slice.PlainOffset, slice.PlainLength).CopyTo(destination[written..]);
                written += slice.PlainLength;
            }
            return written;
        }
        catch
        {
            // A failed cross-chunk read must not expose a partly copied result.
            destination.Span[..written].Clear();
            throw;
        }
        finally { gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        await lifetime.CancelAsync();
        await gate.WaitAsync();
        try
        {
            if (cached is not null) CryptographicOperations.ZeroMemory(cached);
            cached = null;
            CryptographicOperations.ZeroMemory(fileKey);
        }
        finally { gate.Release(); gate.Dispose(); lifetime.Dispose(); }
    }
}

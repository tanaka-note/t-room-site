using System.Security.Cryptography;
using System.Text;

namespace TCloud.Sync.Core;

/// <summary>TRC1 envelopes shared with cloud-worker/public/crypto-vault.js.</summary>
public static class EncryptedChunks
{
    private const int HeaderLength = 16;
    private const int TagLength = 16;
    private const int MaxChunkBytes = 64 * 1024 * 1024;
    private static readonly byte[] Magic = "TRC1"u8.ToArray();

    public static byte[] Encrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> plaintext, int index)
    {
        Validate(key, plaintext.Length, index);
        var envelope = new byte[plaintext.Length + HeaderLength + TagLength];
        Magic.CopyTo(envelope, 0);
        RandomNumberGenerator.Fill(envelope.AsSpan(4, 12));
        using var aes = new AesGcm(key, TagLength);
        aes.Encrypt(envelope.AsSpan(4, 12), plaintext, envelope.AsSpan(HeaderLength, plaintext.Length),
            envelope.AsSpan(HeaderLength + plaintext.Length, TagLength), Context(index));
        return envelope;
    }

    public static byte[] Decrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> envelope, int index)
    {
        if (envelope.Length < HeaderLength + TagLength || !envelope[..4].SequenceEqual(Magic))
            throw new CryptographicException("暗号化ファイルの形式が一致しません。");
        var length = envelope.Length - HeaderLength - TagLength;
        Validate(key, length, index);
        var plaintext = new byte[length];
        try
        {
            using var aes = new AesGcm(key, TagLength);
            aes.Decrypt(envelope.Slice(4, 12), envelope.Slice(HeaderLength, length),
                envelope[^TagLength..], plaintext, Context(index));
            return plaintext;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(plaintext);
            throw;
        }
    }

    private static byte[] Context(int index) => Encoding.UTF8.GetBytes($"T-ROOM Cloud Storage file chunk v1|{index}");

    private static void Validate(ReadOnlySpan<byte> key, int length, int index)
    {
        if (key.Length != 32) throw new ArgumentException("ファイル鍵は256ビットである必要があります。", nameof(key));
        if (length > MaxChunkBytes || index is < 0 or >= 10000) throw new ArgumentOutOfRangeException(nameof(index));
    }
}

public sealed record ChunkSlice(int Index, long EncryptedOffset, int EncryptedLength, int PlainOffset, int PlainLength);

public static class ChunkRanges
{
    public static IReadOnlyList<ChunkSlice> ForRead(long fileSize, int chunkSize, long offset, int length)
    {
        if (fileSize < 0 || chunkSize is < 1 or > 64 * 1024 * 1024 || offset < 0 || length < 0)
            throw new ArgumentOutOfRangeException(nameof(offset));
        if (offset >= fileSize || length == 0) return [];
        var end = offset + Math.Min((long)length, fileSize - offset);
        var result = new List<ChunkSlice>();
        for (var position = offset; position < end;)
        {
            var index = checked((int)(position / chunkSize));
            if (index >= 10000) throw new ArgumentOutOfRangeException(nameof(fileSize));
            var start = (long)index * chunkSize;
            var plaintextSize = (int)Math.Min(chunkSize, fileSize - start);
            var skip = (int)(position - start);
            var take = (int)Math.Min(end - position, plaintextSize - skip);
            result.Add(new(index, (long)index * (chunkSize + 32L), plaintextSize + 32, skip, take));
            position += take;
        }
        return result;
    }
}

namespace TCloud.Sync.Windows;

public readonly record struct CloudFilesRange(long Offset, long Length)
{
    public static CloudFilesRange ForVerifiedChunks(long fileSize, int chunkSize, long offset, long length)
    {
        if (chunkSize is < 4096 or > 64 * 1024 * 1024 || chunkSize % 4096 != 0)
            throw new ArgumentOutOfRangeException(nameof(chunkSize));
        var requested = ForRequest(fileSize, offset, length);
        var start = requested.Offset / chunkSize * chunkSize;
        var end = requested.Offset + requested.Length;
        var padding = (chunkSize - end % chunkSize) % chunkSize;
        end += Math.Min(padding, fileSize - end);
        return new(start, end - start);
    }

    /// <summary>TRANSFER_DATA needs 4 KiB boundaries, except for the final length at logical EOF.</summary>
    public static CloudFilesRange ForRequest(long fileSize, long offset, long length)
    {
        if (fileSize <= 0 || offset < 0 || offset >= fileSize || length == 0 || length < -1)
            throw new ArgumentOutOfRangeException(nameof(offset), "Cloud Filesの取得範囲が不正です。");
        var start = offset / 4096 * 4096;
        var end = length == -1 || length >= fileSize - offset ? fileSize : offset + length;
        var padding = (4096 - end % 4096) % 4096;
        end += Math.Min(padding, fileSize - end);
        return new(start, end - start);
    }
}

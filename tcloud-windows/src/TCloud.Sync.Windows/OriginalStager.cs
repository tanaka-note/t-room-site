using System.Security.Cryptography;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record VerifiedOriginal(Stream Body,string Sha256):IAsyncDisposable
{
    public ValueTask DisposeAsync()=>Body.DisposeAsync();
}

/// <summary>Never exposes a partial original. Failed ciphertext remains outside the user-visible file.</summary>
public static class OriginalStager
{
    public static async Task<VerifiedOriginal> DownloadAsync(string ownedStagingDirectory,EncryptedFileLayout layout,
        ReadOnlyMemory<byte> fileKey,IEncryptedRangeSource source,IProgress<long>? progress=null,CancellationToken token=default)
    {
        layout.Validate();
        await using var reader=new EncryptedFileReader(layout,fileKey.Span,source);
        return await Stage(ownedStagingDirectory,layout.SizeBytes,async(offset,buffer,ct)=>await reader.ReadAsync(offset,buffer,ct),progress,token);
    }

    public static async Task<VerifiedOriginal> DownloadLegacyAsync(string ownedStagingDirectory,long size,
        IEncryptedRangeSource source,IProgress<long>? progress=null,CancellationToken token=default)
    {
        string? etag=null;
        return await Stage(ownedStagingDirectory,size,async(offset,buffer,ct)=>
        {
            var response=await source.ReadAsync(offset,buffer.Length,etag,ct);
            if(response.TotalBytes!=size||response.Ciphertext.Length!=buffer.Length||!CiphertextEntityTag.IsStrong(response.EntityTag)
                ||etag is not null&&etag!=response.EntityTag)throw new IOException("取得中に原本が変わりました。");
            etag=response.EntityTag;response.Ciphertext.CopyTo(buffer);return buffer.Length;
        },progress,token);
    }

    private static async Task<VerifiedOriginal> Stage(string directory,long size,
        Func<long,Memory<byte>,CancellationToken,ValueTask<int>> read,IProgress<long>? progress,CancellationToken token)
    {
        if(size<1||size>64L*1024*1024*10000)throw new InvalidDataException("原本のサイズが不正です。");
        // Caller owns this directory and validates its volume on every source read.
        var full=Path.GetFullPath(directory);
        _=VolumeInspector.ValidateDestination(full,[]);
        Directory.CreateDirectory(full);
        if(new DirectoryInfo(full).LinkTarget is not null)throw new IOException("リンク経由では一時保存しません。");
        if(new DriveInfo(Path.GetPathRoot(full)!).AvailableFreeSpace<size+16L*1024*1024)
            throw new IOException("原本の一時保存に必要な空き容量がありません。保存済み原本は削除しません。");
        var path=Path.Combine(full,Guid.NewGuid().ToString("N")+".partial");
        var body=new FileStream(path,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None,1024*1024,
            FileOptions.Asynchronous|FileOptions.SequentialScan|FileOptions.DeleteOnClose);
        var buffer=new byte[(int)Math.Min(size,8*1024*1024)];
        try
        {
            using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            for(long offset=0;offset<size;)
            {
                token.ThrowIfCancellationRequested();
                var count=(int)Math.Min(buffer.Length,size-offset);
                if(await read(offset,buffer.AsMemory(0,count),token)!=count)throw new EndOfStreamException("原本の取得が完了していません。");
                hash.AppendData(buffer,0,count);await body.WriteAsync(buffer.AsMemory(0,count),token);
                offset+=count;progress?.Report(offset);
            }
            await body.FlushAsync(token);body.Flush(flushToDisk:true);body.Position=0;
            return new(body,Convert.ToHexString(hash.GetHashAndReset()));
        }
        catch {await body.DisposeAsync();throw;}
        finally {CryptographicOperations.ZeroMemory(buffer);}
    }
}

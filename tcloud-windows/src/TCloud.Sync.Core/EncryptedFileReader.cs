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
    private readonly Dictionary<int,PendingChunk> pending = [];
    private readonly AdaptiveReadAhead readAhead = new();
    private readonly bool prefetch;
    private int activeRequests;
    private long overlapGeneration;
    private byte[]? cached;
    private int cachedIndex = -1;
    private string? entityTag;
    private int disposed;
    public long Length => layout.SizeBytes;
    public string? EntityTag => entityTag;

    public EncryptedFileReader(EncryptedFileLayout layout, ReadOnlySpan<byte> fileKey,
        IEncryptedRangeSource source, string? expectedEntityTag = null, bool prefetch = false)
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
        this.prefetch = prefetch && layout.ChunkSizeBytes <= 8 * 1024 * 1024;
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
                    if(!pending.ContainsKey(slice.Index)&&pending.Count>0)await ClearPendingAsync();
                    var next=Start(slice.Index,cancellationToken);
                    try {
                        var response=await next.Transfer.WaitAsync(token);token.ThrowIfCancellationRequested();
                        entityTag ??= response.EntityTag;
                        var plaintext=EncryptedChunks.Decrypt(fileKey,response.Ciphertext,slice.Index);
                        if(cached is not null)CryptographicOperations.ZeroMemory(cached);
                        cached=plaintext;cachedIndex=slice.Index;
                    }finally {if(next.Transfer.IsCompleted){pending.Remove(slice.Index);next.Cancellation.Dispose();}}
                    // Only ciphertext is read ahead, after the initial ETag is
                    // pinned. The consumer still authenticates chunks in order.
                    if(prefetch)for(int index=slice.Index+1;index<layout.ChunkCount&&index<=slice.Index+readAhead.Window;index++) {
                        if(pending.Count>=readAhead.Window)break;Start(index,cancellationToken);
                    }
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
            await ClearPendingAsync();
            throw;
        }
        finally { gate.Release(); }
    }

    private sealed record PendingChunk(CancellationTokenSource Cancellation,Task<EncryptedRangeResponse> Transfer);
    private PendingChunk Start(int index,CancellationToken caller)
    {
        if(pending.TryGetValue(index,out var existing))return existing;
        var cancel=CancellationTokenSource.CreateLinkedTokenSource(caller,lifetime.Token);
        var item=new PendingChunk(cancel,FetchAsync(index,entityTag,cancel.Token));pending.Add(index,item);return item;
    }
    private async Task<EncryptedRangeResponse> FetchAsync(int index,string? expected,CancellationToken token)
    {
        var bytes=(int)Math.Min(layout.ChunkSizeBytes,layout.SizeBytes-(long)index*layout.ChunkSizeBytes)+32;
        var generation=Interlocked.Read(ref overlapGeneration);
        if(Interlocked.Increment(ref activeRequests)>1)Interlocked.Increment(ref overlapGeneration);
        var timer=System.Diagnostics.Stopwatch.StartNew();
        try {
            var response=await source.ReadAsync((long)index*(layout.ChunkSizeBytes+32L),bytes,expected,token);
            token.ThrowIfCancellationRequested();
            if(response.Ciphertext.Length!=bytes||response.TotalBytes!=layout.EncryptedSizeBytes
                ||!CiphertextEntityTag.IsStrong(response.EntityTag)||expected is not null&&response.EntityTag!=expected)
                throw new IOException("取得中にファイルの版または保存内容が変わりました。");
            readAhead.Observe(bytes,Math.Max(timer.Elapsed.TotalSeconds,0.000001),generation!=Interlocked.Read(ref overlapGeneration));return response;
        }finally{Interlocked.Decrement(ref activeRequests);}
    }
    private async Task ClearPendingAsync()
    {
        var abandoned=pending.Values.ToArray();pending.Clear();
        foreach(var item in abandoned)item.Cancellation.Cancel();
        try{await Task.WhenAll(abandoned.Select(item=>item.Transfer));}catch(Exception){ /* Every abandoned transfer is observed. */ }
        foreach(var item in abandoned)item.Cancellation.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        await lifetime.CancelAsync();
        await gate.WaitAsync();
        try
        {
            await ClearPendingAsync();
            if (cached is not null) CryptographicOperations.ZeroMemory(cached);
            cached = null;
            CryptographicOperations.ZeroMemory(fileKey);
        }
        finally { gate.Release(); gate.Dispose(); lifetime.Dispose(); }
    }
}

internal sealed class AdaptiveReadAhead
{
    private readonly object gate=new();
    private int window=1,soloSamples,cooldown,overlapSamples;
    private double soloRate,overlapRate;
    public int Window {get{lock(gate)return window;}}
    public void Observe(long bytes,double seconds,bool overlapped)
    {
        lock(gate) {
            var rate=bytes/seconds;
            if(!overlapped) {
                soloRate=soloSamples++==0?rate:soloRate*0.75+rate*0.25;
                if(cooldown>0)cooldown--;else if(soloSamples>=2)window=2;
            }else {
                overlapRate+=rate;overlapSamples++;
                if(overlapSamples>=4) {
                    // Two slower flows must beat the single-flow baseline in
                    // aggregate; otherwise back off before trying again later.
                    if(soloRate>0&&overlapRate/overlapSamples<soloRate*0.6){window=1;cooldown=8;}
                    overlapRate=0;overlapSamples=0;
                }
            }
        }
    }
}

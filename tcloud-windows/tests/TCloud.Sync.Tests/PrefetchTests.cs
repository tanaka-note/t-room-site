using System.Security.Cryptography;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class PrefetchTests
{
    public static async Task Reads()
    {
        foreach(var mode in new[]{"valid","damaged","changed"}) {
            using var source=new Source(mode);
            await using var reader=new EncryptedFileReader(source.Layout,source.Key,source,prefetch:true);
            var bytes=new byte[source.Plain.Length];
            try {
                _=await reader.ReadAsync(0,bytes);
                Check(mode=="valid"&&bytes.AsSpan().SequenceEqual(source.Plain),"ordered authenticated plaintext");
                Check(source.Peak==2,"two bounded ciphertext reads actually overlap");
                var oldCalls=source.Calls;await reader.ReadAsync(source.Plain.Length-1,new byte[1]);Check(source.Calls==oldCalls,"cached tail is reused");
            }catch(Exception error)when(mode=="damaged"&&error is CryptographicException||mode=="changed"&&error is IOException) {
                Check(bytes.All(b=>b==0),"failed prefetch never leaves partly copied plaintext");
            }
            Check(source.Peak<=2&&source.Active==0,"bounded transfers settle after success or failure");
        }
        using var canceled=new Source("blocked");
        var pending=new EncryptedFileReader(canceled.Layout,canceled.Key,canceled,prefetch:true);
        await pending.ReadAsync(0,new byte[1024]);await canceled.Blocked.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await pending.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        Check(canceled.Active==0,"disposing a reader cancels and observes speculative work");
        var policy=new AdaptiveReadAhead();policy.Observe(100,1,false);policy.Observe(100,1,false);Check(policy.Window==2,"tries two after a single-flow baseline");
        for(int i=0;i<4;i++)policy.Observe(100,4,true);Check(policy.Window==1,"slow parallel flows back off");
        for(int i=0;i<9;i++)policy.Observe(100,1,false);Check(policy.Window==2,"bounded retry after single-flow cooldown");
    }
    public static async Task Ownership()
    {
        using var lifetime=new CancellationTokenSource();int calls=0;TrackedStream? last=null;
        var cache=new WindowsOriginalPrefetch((_,progress,token)=>{calls++;progress.Report(42);return Task.FromResult<Stream>(last=new TrackedStream());},lifetime.Token);
        cache.Start("first");cache.Start("second");Check(calls==1,"only one next original is staged");
        Check(cache.Claim("other",new Progress(),default)is null,"version identity must match");
        var received=new Progress();var claimed=await cache.Claim("first",received,default)!;await cache.ClearAsync();
        Check(!last!.Disposed&&received.Value==42,"claim keeps the stream alive and forwards completed progress");
        await claimed.DisposeAsync();Check(last.Disposed,"consumer owns disposal");
        cache.Start("unused");await cache.ClearAsync();Check(last!.Disposed,"unclaimed staged originals are released");
        var canceled=false;var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiting=new WindowsOriginalPrefetch(async(_,_,token)=>{started.TrySetResult();try{await Task.Delay(Timeout.InfiniteTimeSpan,token);}finally{canceled=true;}return new MemoryStream();},lifetime.Token);
        waiting.Start("waiting");await started.Task;await waiting.ClearAsync();Check(canceled,"abandoning prefetch cancels the request");
        var failed=new WindowsOriginalPrefetch((_,_,_)=>Task.FromException<Stream>(new IOException("synthetic transfer failure")),lifetime.Token);
        failed.Start("failed");await failed.ClearAsync();
    }
    private sealed class Progress:IProgress<long>{public long Value;public void Report(long value)=>Value=value;}
    private sealed class TrackedStream:MemoryStream{public bool Disposed;protected override void Dispose(bool disposing){Disposed=true;base.Dispose(disposing);}}
    private sealed class Source(string mode):IEncryptedRangeSource,IDisposable
    {
        public byte[] Plain {get;}=RandomNumberGenerator.GetBytes(10*1024);
        public byte[] Key {get;}=RandomNumberGenerator.GetBytes(32);
        public EncryptedFileLayout Layout {get;}=new(10*1024,1024,10,10*1056);
        public int Active,Peak,Calls;
        public TaskCompletionSource Blocked {get;}=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async ValueTask<EncryptedRangeResponse> ReadAsync(long offset,int length,string? expected,CancellationToken token)
        {
            var index=(int)(offset/1056);Check(length==1056&&expected is null or "\"pinned\"","request keeps the same strong version");
            Interlocked.Increment(ref Calls);var active=Interlocked.Increment(ref Active);int old;
            do{old=Peak;if(old>=active)break;}while(Interlocked.CompareExchange(ref Peak,active,old)!=old);
            try {
                if(mode=="blocked"&&index>0){Blocked.TrySetResult();await Task.Delay(Timeout.InfiniteTimeSpan,token);}
                await Task.Delay(15,token);
                var data=EncryptedChunks.Encrypt(Key,Plain.AsSpan(index*1024,1024),index);if(mode=="damaged"&&index==4)data[^1]^=1;
                return new(data,mode=="changed"&&index==4?"\"changed\"":"\"pinned\"",Layout.EncryptedSizeBytes);
            }finally{Interlocked.Decrement(ref Active);}
        }
        public void Dispose(){CryptographicOperations.ZeroMemory(Plain);CryptographicOperations.ZeroMemory(Key);}
    }
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
}

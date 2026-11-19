namespace TCloud.Sync.Windows;

/// <summary>One owned next original. Claiming transfers ownership to the provider; abandoning it releases all staging.</summary>
internal sealed class WindowsOriginalPrefetch(Func<string,IProgress<long>,CancellationToken,Task<Stream>> fetch,CancellationToken lifetime)
{
    private readonly object gate=new();
    private Item? pending;
    public void Start(string identity)
    {
        lock(gate) {
            if(pending is not null)return;
            var cancel=CancellationTokenSource.CreateLinkedTokenSource(lifetime);
            var progress=new ForwardProgress();
            pending=new(identity,cancel,progress,fetch(identity,progress,cancel.Token));
        }
    }
    public Task<Stream>? Claim(string identity,IProgress<long> progress,CancellationToken token)
    {
        Item item;
        lock(gate){if(pending?.Identity!=identity)return null;item=pending;pending=null;}
        return ConsumeAsync(item,progress,token);
    }
    private static async Task<Stream> ConsumeAsync(Item item,IProgress<long> progress,CancellationToken token)
    {
        var registration=token.Register(()=>item.Cancellation.Cancel());item.Progress.Attach(progress);
        try{return await item.Transfer;}
        finally{registration.Dispose();item.Cancellation.Dispose();}
    }
    public async Task ClearAsync()
    {
        Item? item;lock(gate){item=pending;pending=null;}if(item is null)return;
        item.Cancellation.Cancel();
        try{await using var unused=await item.Transfer;}catch(Exception){ /* Observe an unclaimed failure without publishing it. */ }
        finally{item.Cancellation.Dispose();}
    }
    private sealed record Item(string Identity,CancellationTokenSource Cancellation,ForwardProgress Progress,Task<Stream> Transfer);
    private sealed class ForwardProgress:IProgress<long>
    {
        private IProgress<long>? target;private long value;
        public void Report(long next){Interlocked.Exchange(ref value,next);Volatile.Read(ref target)?.Report(next);}
        public void Attach(IProgress<long> progress){Volatile.Write(ref target,progress);progress.Report(Interlocked.Read(ref value));}
    }
}

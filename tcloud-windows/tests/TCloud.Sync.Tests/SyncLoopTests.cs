using System.Text.Json;
using TCloud.Sync.Windows;

internal static class SyncLoopTests
{
    private static readonly string Epoch=new('a',32);
    private static readonly string Hash=new('b',64);
    private static WindowsCatalogEntry Item(long id,long revision)=>new("file",id,revision,"present",JsonSerializer.SerializeToElement(new {name="saved.txt"}),null,null);

    public static async Task CompleteViews()
    {
        using var fixture=new CatalogFixture();var store=fixture.Store;
        var first=new WindowsCatalogStart(Epoch,2);var calls=0;
        var source=new Source(()=>first,async(start,after,snapshot,token)=>
        {
            Check(snapshot,"initial enumeration uses the snapshot endpoint");calls++;
            if(after==0)return new(start.Epoch,2,1,false,[Item(1,1)]);
            Check((await store.LoadAsync(token)).RemotePosition is null,"partial online pages remain unpublished");
            await store.UpdateAsync(value=>value with {Originals=[new(9,1,"offline.txt",Hash,20,Hash,true)]},token);
            return new(start.Epoch,2,2,true,[Item(2,2)]);
        });
        var result=await new WindowsCatalogSynchronizer(source,store).RefreshAsync();
        Check(calls==2&&result.Remote.Length==2&&result.RemotePosition==first,"all snapshot pages publish one complete view");
        Check(result.Originals.Length==1,"foreground hydration baselines committed during enumeration survive");
        var before=await store.LoadAsync();
        var broken=new Source(()=>new(Epoch,4),(start,after,snapshot,token)=>
        {
            Check(!snapshot,"subsequent polling uses the last complete cursor");
            return after==2?Task.FromResult(new WindowsCatalogPage(Epoch,4,3,false,[Item(1,3)]))
                :throw new HttpRequestException("fixture transport interrupted");
        });
        await Throws<HttpRequestException>(()=>new WindowsCatalogSynchronizer(broken,store).RefreshAsync());
        var unchanged=await store.LoadAsync();
        Check(unchanged.RemotePosition==before.RemotePosition&&JsonSerializer.Serialize(unchanged.Remote)==JsonSerializer.Serialize(before.Remote),"failed later page cannot publish changes or advance the cursor");
        using(var cancellation=new CancellationTokenSource())
        {
            var interrupted=new Source(()=>new(Epoch,3),(start,after,snapshot,token)=>
            {cancellation.Cancel();return Task.FromResult(new WindowsCatalogPage(Epoch,3,3,true,[Item(1,3)]));});
            await Throws<OperationCanceledException>(()=>new WindowsCatalogSynchronizer(interrupted,store).RefreshAsync(cancellation.Token));
            Check((await store.LoadAsync()).RemotePosition==before.RemotePosition,"cancellation before publish preserves the last complete cursor");
        }
        var resetEpoch=new string('c',32);
        var reset=new Source(()=>new(resetEpoch,1),(start,after,snapshot,token)=>
        {
            Check(snapshot&&after==0,"a new epoch restarts snapshot enumeration");throw new WindowsCatalogResetException();
        });
        await Throws<WindowsCatalogResetException>(()=>new WindowsCatalogSynchronizer(reset,store).RefreshAsync());
        Check((await store.LoadAsync()).RemotePosition==before.RemotePosition,"reset during enumeration leaves the last confirmed view intact");
        reset.Page=(start,after,snapshot,token)=>Task.FromResult(new WindowsCatalogPage(resetEpoch,1,1,true,[]));
        result=await new WindowsCatalogSynchronizer(reset,store).RefreshAsync();
        Check(result.RemotePosition==new WindowsCatalogStart(resetEpoch,1)&&result.Remote.Length==0&&result.Originals.Single().Id==9,
            "successful empty resnapshot never loses original records or interprets absence as deletion");
        var updates=Enumerable.Range(10,20).Select(id=>store.UpdateAsync(value=>value with
            {Originals=[..value.Originals,new(id,1,$"offline-{id}.txt",Hash,10,Hash,true)]}));
        await Task.WhenAll(updates);
        Check((await store.LoadAsync()).Originals.Length==21,"concurrent atomic record updates cannot overwrite each other");
        var descriptor=new OriginalDescriptor(77,5,"verified.txt",19,Hash);
        var staged=await store.RecordStagedOriginalAsync(descriptor,Hash);
        Check(!staged.Originals.Single(e=>e.Id==77).Complete,"verified staging does not imply complete CFAPI hydration");
        await store.MarkOriginalRetainedAsync(descriptor);
        var retained=await store.RecordStagedOriginalAsync(descriptor,Hash);
        Check(retained.Originals.Single(e=>e.Id==77).Complete,"repeated identical staging does not lose completed retention");
        await Throws<InvalidDataException>(()=>store.RecordStagedOriginalAsync(descriptor with {Revision=4},Hash));
        await Throws<InvalidDataException>(()=>store.RecordStagedOriginalAsync(descriptor,new string('c',64)));
        await store.RecordStagedOriginalAsync(descriptor with {Revision=6},Hash);
        await Throws<InvalidDataException>(()=>store.MarkOriginalRetainedAsync(descriptor));
        Check(!(await store.LoadAsync()).Originals.Single(e=>e.Id==77).Complete,"late older hydration completion cannot mark a newer revision retained");
    }

    public static async Task ResumeAfterFailure()
    {
        using var fixture=new CatalogFixture();using var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var available=false;var failures=0;var reconciled=0;var statuses=new List<WindowsSyncStatus>();
        var source=new Source(()=>new(Epoch,1),(start,after,snapshot,token)=>
        {
            Check(available,"an unavailable HDD never initiates online enumeration");
            if(failures++==0)throw new HttpRequestException("temporary fixture outage");
            return Task.FromResult(new WindowsCatalogPage(Epoch,1,1,true,[Item(1,1)]));
        });
        var progress=new InlineProgress(status=>
        {
            statuses.Add(status);
            if(status.State==WindowsSyncState.DestinationUnavailable)available=true;
            if(status.State==WindowsSyncState.Current)cancel.Cancel();
        });
        var loop=new WindowsSyncLoop(new(source,fixture.Store),()=>
        {if(!available)throw new IOException("fixture disk absent");},(state,token)=>
        {Check(state.Remote.Length==1,"only a complete view reaches reconciliation");reconciled++;return Task.CompletedTask;},progress,
            retryInterval:TimeSpan.FromMilliseconds(1));
        Check(await loop.RunAsync(cancel.Token)==WindowsSyncState.Stopped,"cancellation stops without deleting registrations or local files");
        Check(failures==2&&reconciled==1,"both HDD reconnection and network failure retry automatically");
        Check(statuses.Any(s=>s.State==WindowsSyncState.DestinationUnavailable)&&statuses.Any(s=>s.State==WindowsSyncState.ConnectionPending),
            "disk absence and connectivity failure are visible without requesting a login");
        Check(statuses.Last().LastCompletedAt is not null&&(await fixture.Store.LoadAsync()).RemotePosition==new WindowsCatalogStart(Epoch,1),
            "confirmed cursor and completion time survive stopping");
    }

    public static async Task RevocationStops()
    {
        foreach(var initial in new[]{false,true})
        {
            using var fixture=new CatalogFixture();var calls=0;var reconciled=0;
            var source=new Source(()=>{calls++;throw initial?new WindowsDeviceRegistrationIncompleteException():new WindowsDeviceRevokedException();},
                (start,after,snapshot,token)=>throw new InvalidOperationException("must not request data"));
            WindowsSyncStatus? final=null;
            var loop=new WindowsSyncLoop(new(source,fixture.Store),()=>{},(state,token)=>{reconciled++;return Task.CompletedTask;},
                new InlineProgress(value=>final=value));
            var result=await loop.RunAsync(CancellationToken.None);
            Check(result==(initial?WindowsSyncState.InitialRegistrationIncomplete:WindowsSyncState.AuthorizationRevoked)&&calls==1&&reconciled==0,
                "revocation and incomplete initial registration stop without renewal loops or file operations");
            Check(final?.State==result&&!(await fixture.Store.LoadAsync()).Remote.Any(),"terminal status never fabricates an applied empty view");
        }
        using(var fixture=new CatalogFixture())
        {
            await File.WriteAllTextAsync(fixture.Path,"invalid local checkpoint");var calls=0;
            var source=new Source(()=>{calls++;return new(Epoch,0);},(start,after,snapshot,token)=>Task.FromResult(new WindowsCatalogPage(Epoch,0,0,true,[])));
            var loop=new WindowsSyncLoop(new(source,fixture.Store),()=>{},(_,_)=>throw new InvalidOperationException("must not reconcile corrupt state"));
            Check(await loop.RunAsync(CancellationToken.None)==WindowsSyncState.StateInvalid&&calls==0,"damaged restart state stops before online access");
            Check(await File.ReadAllTextAsync(fixture.Path)=="invalid local checkpoint","corrupt checkpoint is preserved for recovery");
        }
    }

    public static async Task RequestedCheck()
    {
        using var fixture=new CatalogFixture();using var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var first=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls=0;
        var source=new Source(()=>new(Epoch,0),(start,after,snapshot,token)=>Task.FromResult(new WindowsCatalogPage(Epoch,0,0,true,[])));
        var loop=new WindowsSyncLoop(new(source,fixture.Store),()=>{},(_,_)=>Task.CompletedTask,new InlineProgress(status=>{
            if(status.State!=WindowsSyncState.Current)return;
            if(++calls==1)first.TrySetResult();else cancel.Cancel();
        }),pollInterval:TimeSpan.FromMinutes(1));
        var run=loop.RunAsync(cancel.Token);await first.Task.WaitAsync(cancel.Token);
        loop.RequestCheck();
        Check(await run==WindowsSyncState.Stopped&&calls==2,"manual check wakes the existing poll loop before its next interval");
    }

    private sealed class Source(Func<WindowsCatalogStart> start,
        Func<WindowsCatalogStart,long,bool,CancellationToken,Task<WindowsCatalogPage>> page):IWindowsCatalogSource
    {
        public Func<WindowsCatalogStart,long,bool,CancellationToken,Task<WindowsCatalogPage>> Page=page;
        public Task<WindowsCatalogStart> StartAsync(CancellationToken token=default)=>Task.FromResult(start());
        public Task<WindowsCatalogPage> PageAsync(WindowsCatalogStart value,long after,bool snapshot,CancellationToken token=default)=>Page(value,after,snapshot,token);
    }
    private sealed class InlineProgress(Action<WindowsSyncStatus> report):IProgress<WindowsSyncStatus>
    {public void Report(WindowsSyncStatus value)=>report(value);}
    private sealed class CatalogFixture:IDisposable
    {
        private readonly string directory=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"tcloud-sync-loop-"+Guid.NewGuid().ToString("N"));
        public string Path=>System.IO.Path.Combine(directory,"catalog.json");
        public LocalSyncCatalog Store{get;}
        public CatalogFixture()
        {
            Directory.CreateDirectory(directory);
            Store=new(Path,new(1,Guid.NewGuid().ToString("N"),Hash,Hash,new string('d',64),System.IO.Path.Combine(directory,"originals"),new("fixture-volume",1,"originals"),123));
        }
        public void Dispose()=>Directory.Delete(directory,true);
    }
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    private static async Task Throws<T>(Func<Task> action)where T:Exception
    {try{await action();}catch(T){return;}throw new InvalidOperationException("Expected "+typeof(T).Name);}
}

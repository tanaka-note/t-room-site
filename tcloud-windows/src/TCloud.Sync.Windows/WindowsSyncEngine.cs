using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record WindowsTransferStatus(string Message,int Complete,int Total);

/// <summary>One durable local worker; catalog polling and foreground opens remain independent.</summary>
public sealed class WindowsSyncEngine:IAsyncDisposable
{
    private readonly WindowsDeviceClient device;
    private readonly WindowsDeviceRegistration registration;
    private readonly CloudFilesRootRegistration root;
    private readonly LocalSyncCatalog catalog;
    private readonly RSACng key;
    private readonly string staging;
    private readonly string metadataPath;
    private readonly WindowsUploadJournal uploads;
    private readonly WindowsFileUploader uploader;
    private readonly WindowsRemoteExchange exchange;
    private readonly CloudFilesProvider provider;
    private readonly IProgress<WindowsTransferStatus>? progress;
    private readonly Action<string>? protectFolder;
    private readonly ConcurrentDictionary<string,(WindowsCatalogEntry Entry,WindowsCatalogEntry[] Catalog,string Path)> downloads=new();
    private readonly Dictionary<string,(WindowsFileState State,long Since)> newFiles=new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string,long> localChanges=new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<long,(WindowsFileState State,string Path,long Change,string? Sha256)> verifiedLocal=new();
    private readonly SemaphoreSlim wake=new(0,1);
    private readonly CancellationTokenSource lifetime=new();
    private readonly Task worker;
    private JsonElement keys;
    private bool ready;
    private readonly FileSystemWatcher watcher;
    private readonly object passGate=new();
    private CancellationTokenSource? currentPass;
    private string? activeHydrationPath;
    private long lastLocalChange;
    private WindowsCatalogStart? lastRemotePosition;
    private volatile bool ignoreLocalEvents;
    private bool needsWork=true;
    private long generation;
    public WindowsSyncEngine(WindowsDeviceClient device,WindowsDeviceRegistration registration,CloudFilesRootRegistration root,
        LocalSyncCatalog catalog,string pcDirectory,IProgress<WindowsTransferStatus>? progress=null,Action<string>? protectFolder=null)
    {
        this.device=device;this.registration=registration;this.root=root;this.catalog=catalog;this.progress=progress;this.protectFolder=protectFolder;
        root.VerifyPresent();key=WindowsPrivateKey.Open(registration.DataKeyId);
        staging=Path.Combine(Path.GetDirectoryName(root.Root)!,".TCloud-"+registration.DeviceId);
        _=VolumeInspector.ValidateDestination(staging,[]);Directory.CreateDirectory(staging);
        if(!VolumeInspector.Inspect(staging).Matches(registration.Volume))throw new IOException("同期用の保全領域が登録したHDDと一致しません。");
        metadataPath=Path.Combine(pcDirectory,"metadata.json");
        uploads=new(Path.Combine(pcDirectory,"uploads"),staging,registration);uploader=new(device,registration,root,uploads,staging);
        provider=new(root,OpenOriginalAsync);exchange=new(root,provider,catalog,registration,staging,Path.Combine(pcDirectory,"exchange.json"));
        watcher=new(root.Root){IncludeSubdirectories=true,NotifyFilter=NotifyFilters.FileName|NotifyFilters.DirectoryName|NotifyFilters.LastWrite|NotifyFilters.Size};
        watcher.Changed+=LocalChanged;watcher.Created+=LocalChanged;watcher.Deleted+=LocalChanged;watcher.Renamed+=LocalChanged;
        watcher.Error+=(_,_)=>{verifiedLocal.Clear();Interrupt(local:true);};watcher.EnableRaisingEvents=true;
        worker=Task.Run(()=>RunAsync(lifetime.Token));
    }
    public string RecoveryDirectory=>WindowsRecovery.DirectoryFor(staging);
    public ConcurrentQueue<Exception> Errors {get;}=new();
    public Task Completion=>worker;
    internal Action<string>? BeforeHydrationValidation {get;set;}
    public async Task ReconcileAsync(LocalSyncSnapshot snapshot,CancellationToken token)
    {
        root.VerifyPresent();if(ready&&lastRemotePosition==snapshot.RemotePosition)return;
        if(!ready){keys=await device.ReadKeysAsync(token);ready=true;}
        if(lastRemotePosition is not null&&lastRemotePosition!=snapshot.RemotePosition)Interrupt(local:false);
        lastRemotePosition=snapshot.RemotePosition;
        using var resolver=new CloudOriginalResolver(key,snapshot.Remote,keys);
        foreach(var entry in snapshot.Remote.Where(e=>e.Kind=="file"&&e.State=="present")) {
            using var value=resolver.Resolve(entry);
            var path=snapshot.Originals.SingleOrDefault(e=>e.Id==entry.Id)?.RelativePath??value.RelativePath;
            downloads[Identity(entry)]=(entry,snapshot.Remote,path);
        }
        var currentIdentities=snapshot.Remote.Where(e=>e.Kind=="file"&&e.State=="present").Select(Identity).ToHashSet(StringComparer.Ordinal);
        foreach(var identity in downloads.Keys)if(!currentIdentities.Contains(identity))downloads.TryRemove(identity,out _);
        try{if(wake.CurrentCount==0)wake.Release();}catch(SemaphoreFullException){ }
    }
    private string Identity(WindowsCatalogEntry entry)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        "TCloud.Windows.Original.v1\n"+registration.ScopeHash+"\n"+entry.Id+"\n"+entry.Revision)));
    private static string? Version(WindowsCatalogEntry entry)=>entry.Value is {} v&&v.TryGetProperty("contentVersion",out var p)?p.GetString():null;
    private async Task<Stream> OpenOriginalAsync(string identity,IProgress<long> progress,CancellationToken token)
    {
        if(!downloads.TryGetValue(identity,out var item))throw new IOException("原本の取得情報を確認しています。同期後にもう一度開いてください。");
        using var resolver=new CloudOriginalResolver(key,item.Catalog,keys);
        var transfer=new WindowsOriginalTransfer(device,root,resolver,registration,staging,catalog);transfer.Register(item.Entry,item.Path);
        return await transfer.OpenAsync(identity,progress,token);
    }
    private async Task RunAsync(CancellationToken token)
    {
        long processedGeneration=-1,lastScan=0;int failures=0;
        try {
            while(!ready){await wake.WaitAsync(token);}
            await exchange.ResumeAsync(token);
            while(true) {
                token.ThrowIfCancellationRequested();root.VerifyPresent();
                if(!needsWork&&Interlocked.Read(ref generation)==processedGeneration&&Environment.TickCount64-lastScan<300000) {
                    await wake.WaitAsync(TimeSpan.FromSeconds(30),token);continue;
                }
                while(Environment.TickCount64-Interlocked.Read(ref lastLocalChange)<750)await Task.Delay(150,token);
                using var pass=CancellationTokenSource.CreateLinkedTokenSource(token);
                lock(passGate)currentPass=pass;
                var passGeneration=Interlocked.Read(ref generation);needsWork=true;
                try {await WorkAsync(pass.Token);processedGeneration=passGeneration;lastScan=Environment.TickCount64;failures=0;}
                catch(OperationCanceledException)when(!token.IsCancellationRequested) { }
                catch(Exception error)when(error is HttpRequestException or IOException or System.ComponentModel.Win32Exception) {
                    if(error is InvalidDataException)throw;
                    Errors.Enqueue(error);while(Errors.Count>32)Errors.TryDequeue(out _);
                    failures=Math.Min(failures+1,5);
                    progress?.Report(new(error is IOException?error.Message:"接続・保存処理の完了を待って再試行します。",0,0));
                }
                finally{lock(passGate)currentPass=null;}
                await wake.WaitAsync(TimeSpan.FromSeconds(Math.Min(60,2*Math.Pow(2,failures))),token);
            }
        }catch(OperationCanceledException)when(token.IsCancellationRequested) { }
    }
    private void LocalChanged(object sender,FileSystemEventArgs args)
    {
        if(ignoreLocalEvents||Ignored(Path.GetFileName(args.FullPath)))return;
        try{if(File.Exists(args.FullPath)&&(CloudFilesLocalStorage.PlaceholderState(args.FullPath)&0x30)!=0)return;}
        catch(Exception error)when(error is IOException or System.ComponentModel.Win32Exception or UnauthorizedAccessException) { }
        localChanges.AddOrUpdate(args.FullPath,1,(_,n)=>n+1);
        Interrupt(local:true,hydrationNoticePath:args.ChangeType==WatcherChangeTypes.Changed?args.FullPath:null);
    }
    private void Interrupt(bool local,string? hydrationNoticePath=null)
    {
        Interlocked.Increment(ref generation);
        if(local)Interlocked.Exchange(ref lastLocalChange,Environment.TickCount64);
        // Hydration itself emits write notifications. Validate that one body
        // before deciding whether it is a user edit; renames, other files,
        // remote changes and notification overflow still interrupt immediately.
        lock(passGate)if(hydrationNoticePath is null||!string.Equals(activeHydrationPath,hydrationNoticePath,StringComparison.OrdinalIgnoreCase))currentPass?.Cancel();
        try{if(wake.CurrentCount==0)wake.Release();}catch(Exception error)when(error is ObjectDisposedException or SemaphoreFullException){ }
    }
    private async Task WorkAsync(CancellationToken token)
    {
        var snapshot=await catalog.LoadAsync(token);if(snapshot.RemotePosition is null)return;
        using var resolver=new CloudOriginalResolver(key,snapshot.Remote,keys);
        await exchange.ResumeAsync(token);
        if(await ResumeMetadataAsync(snapshot,token))return;
        foreach(var pending in await uploads.LoadAsync(token)) {
            try {await FinishUploadAsync(await uploader.TransferAsync(pending,resolver,token:token),token);}
            catch(WindowsUploadConflictException){await PreserveUploadConflictAsync(pending,token);}
        }
        if((await uploads.LoadAsync(token)).Length!=0)return;
        snapshot=await catalog.LoadAsync(token);
        long remaining=0,largest=0;
        foreach(var entry in snapshot.Remote.Where(e=>e.Kind=="file"&&e.State=="present")) {
            var baseline=snapshot.Originals.SingleOrDefault(o=>o.Id==entry.Id);var size=entry.Value!.Value.GetProperty("sizeBytes").GetInt64();
            var cached=baseline?.Sha256 is not null&&baseline.ContentVersion==Version(entry)
                &&File.Exists(LocalPaths.ResolveUnderRoot(root.Root,baseline.RelativePath))
                &&(CloudFilesLocalStorage.PlaceholderState(LocalPaths.ResolveUnderRoot(root.Root,baseline.RelativePath))&0x30)==0;
            if(!cached){remaining=checked(remaining+size);largest=Math.Max(largest,size);}
        }
        var needed=checked(remaining+largest+64L*1024*1024);var available=VolumeInspector.Inspect(root.Root).AvailableBytes;
        if(available<needed)throw new IOException($"HDDの空き容量が不足しています。必要: {Math.Ceiling(needed/1073741824d):N0} GB、空き: {Math.Floor(available/1073741824d):N0} GB。保存済みの原本は保持しています。");
        var tree=ScanTree();
        ignoreLocalEvents=true;
        try {if(await ReconcileFoldersAsync(snapshot,resolver,tree,token))return;}
        finally {ignoreLocalEvents=false;}
        snapshot=await catalog.LoadAsync(token);
        // Publish the complete namespace before any background body transfer.
        var seeded=snapshot.Originals.ToList();var reserved=seeded.Select(e=>e.RelativePath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach(var entry in snapshot.Remote.Where(e=>e.Kind=="file"&&e.State=="present"&&!seeded.Any(s=>s.Id==e.Id))) {
            using var resolved=resolver.Resolve(entry);var desired=MappedPath(resolved.RelativePath,entry,snapshot.Folders??[]);
            var relative=UniquePath(desired,entry.Id,reserved,seeded);reserved.Add(relative);
            var full=LocalPaths.ResolveUnderRoot(root.Root,relative);if(File.Exists(full))PreserveConflict(full,relative);
            seeded.Add(new(entry.Id,entry.Revision,relative,Identity(entry),resolved.SizeBytes,null,false,Version(entry),RemoteName:resolved.Metadata?.Name));
        }
        if(seeded.Count!=snapshot.Originals.Length) {
            snapshot=await catalog.UpdateAsync(s=>s with {Originals=[..s.Originals,..seeded.Where(e=>!s.Originals.Any(old=>old.Id==e.Id))]},token);
        }
        foreach(var record in snapshot.Originals.Where(e=>!e.Complete&&e.Sha256 is null&&!e.Deleted)) {
            var entry=snapshot.Remote.SingleOrDefault(e=>e.Kind=="file"&&e.Id==record.Id&&e.State=="present");if(entry is null)continue;
            var full=LocalPaths.ResolveUnderRoot(root.Root,record.RelativePath);
            if(!File.Exists(full)) {
                downloads[record.PlaceholderIdentity]=(entry,snapshot.Remote,record.RelativePath);provider.Add(record.RelativePath,record.SizeBytes,record.PlaceholderIdentity);
            }
        }
        var folders=(snapshot.Folders??[]).Where(f=>snapshot.Remote.Any(e=>e.Kind=="folder"&&e.Id==f.Id&&e.State=="present"))
            .ToDictionary(e=>e.RelativePath,e=>e.Id,StringComparer.OrdinalIgnoreCase);
        var claimed=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var records=snapshot.Originals.ToDictionary(e=>e.Id);
        var files=snapshot.Remote.Where(e=>e.Kind=="file").ToArray();int done=0,total=files.Count(e=>e.State=="present");
        var bodiesNeeded=new List<(WindowsCatalogEntry Entry,string Path,bool Hydrate)>();
        // Tombstones are handled before new local files, so an autosave cannot resurrect a Web deletion.
        foreach(var entry in files.Where(e=>e.State!="present")) {
            if(!records.TryGetValue(entry.Id,out var old))continue;
            claimed.Add(old.RelativePath);var path=Locate(old,tree);
            if(path is not null) {
                var full=LocalPaths.ResolveUnderRoot(root.Root,path);
                if((CloudFilesLocalStorage.PlaceholderState(full)&0x30)!=0){using var mutation=provider.AllowLocalMutation(full);File.Delete(full);}
                else {
                    using var mutation=provider.AllowLocalMutation(full);root.VerifyPresent();
                    // Move atomically first, then inspect the ACTUAL removed body; a late save is never discarded.
                    var saved=await WindowsRecovery.PlanAsync(staging,path,"オンラインで削除された原本の未送信編集",token);File.Move(full,saved);
                    if(await WindowsRecovery.DeleteIfUnchangedAsync(saved,old.Sha256,root.VerifyPresent,token))File.Delete(saved+".json");
                }
            }
            await PutAsync(old with {Deleted=true,LocalState=null},token);
        }
        foreach(var entry in files.Where(e=>e.State=="present")) {
            token.ThrowIfCancellationRequested();root.VerifyPresent();
            using var resolved=resolver.Resolve(entry);records.TryGetValue(entry.Id,out var old);
            var mapped=MappedPath(resolved.RelativePath,entry,snapshot.Folders??[]);
            if(old?.RemoteName==resolved.Metadata?.Name&&old is not null)mapped=Path.Combine(Path.GetDirectoryName(mapped)??"",Path.GetFileName(old.RelativePath));
            var desired=UniquePath(mapped,entry.Id,new HashSet<string>(StringComparer.OrdinalIgnoreCase),snapshot.Originals);
            var actual=old is null?null:Locate(old,tree);
            var path=actual??old?.RelativePath??UniquePath(desired,entry.Id,claimed,snapshot.Originals);
            claimed.Add(path);
            if(old is {Deleted:true}) {
                // A genuine online restore has a new present revision; same-path leftovers remain preserved.
                path=UniquePath(desired,entry.Id,claimed,snapshot.Originals.Where(e=>e.Id!=entry.Id));
            }
            var full=LocalPaths.ResolveUnderRoot(root.Root,path);Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            // A save/rename after the directory scan is not a missing original.
            // Re-enumerate before deciding to recreate anything at its old path.
            if(actual is not null&&!File.Exists(full))return;
            var remoteBodyChanged=old is not null&&old.ContentVersion!=Version(entry);
            if(File.Exists(full)&&old is {Sha256:not null}&&!old.Deleted&&(CloudFilesLocalStorage.PlaceholderState(full)&0x30)==0) {
                var stamp=WindowsFileState.Read(full);var localMoved=!path.Equals(old.RelativePath,StringComparison.Ordinal);
                var change=localChanges.GetValueOrDefault(full);
                var verified=verifiedLocal.TryGetValue(stamp.Id,out var proof)&&proof.State==stamp&&proof.Path==full&&proof.Change==change&&proof.Sha256==old.Sha256;
                var changed=!stamp.SameSavedBytes(old.LocalState)&&!verified;bool dirty=false;
                if(changed) {
                    await using var check=await LocalOriginalSnapshot.CaptureAsync(full,staging,token:token);
                    dirty=check.Sha256!=old.Sha256;
                    if(!dirty&&stamp.Id==check.SourceFileId&&stamp.Usn==check.SourceUsn) {
                        old=old with {Complete=true,LocalState=stamp,LocalFileId=stamp.Id};
                        await PutAsync(old,token);
                        if(change==localChanges.GetValueOrDefault(full)&&WindowsFileState.Read(full)==stamp)verifiedLocal[stamp.Id]=(stamp,full,change,old.Sha256);
                    }
                }
                if(dirty&&(entry.Revision!=old.Revision||remoteBodyChanged)) {
                    path=PreserveConflict(full,path);claimed.Add(path);full=LocalPaths.ResolveUnderRoot(root.Root,old.RelativePath);
                    actual=null;path=old.RelativePath;
                }else if(dirty) {
                    if(!folders.TryGetValue(Path.GetDirectoryName(path)??"",out var folder))continue;
                    var name=Path.GetFileName(path)!=Path.GetFileName(old.RelativePath)?Path.GetFileName(path):resolved.Metadata!.Name;
                    await using var prepared=await uploader.PrepareAsync(resolver,entry,folder,path,snapshot.RemotePosition!.Epoch,
                        resolved.Metadata! with {Name=name,LastModified=new DateTimeOffset(File.GetLastWriteTimeUtc(full)).ToUnixTimeMilliseconds()},token);
                    try {await FinishUploadAsync(await uploader.TransferAsync(prepared.Record,resolver,prepared.Snapshot.Body,token:token),token);}
                    catch(WindowsUploadConflictException){await PreserveUploadConflictAsync(prepared.Record,token);}
                    return;
                }else if((CloudFilesLocalStorage.PlaceholderState(full)&1)==0) {
                    CloudFilesLocalStorage.ConvertSavedBody(full,old.PlaceholderIdentity);
                    await PutAsync(old with {LocalState=null,LocalFileId=WindowsFileState.Read(full).Id},token);return;
                }else if(localMoved&&entry.Revision==old.Revision) {
                    if(!folders.TryGetValue(Path.GetDirectoryName(path)??"",out var folder))continue;
                    await RenameFileAsync(entry,resolver,folder,path,snapshot.RemotePosition!.Epoch,
                        Path.GetFileName(path)!=Path.GetFileName(old.RelativePath)?Path.GetFileName(path):resolved.Metadata!.Name,token);return;
                }else if(!remoteBodyChanged) {
                    // Online-only rename/move has no reason to fetch the video again.
                    var target=LocalPaths.ResolveUnderRoot(root.Root,desired);
                    if(!path.Equals(desired,StringComparison.Ordinal)&&(!File.Exists(target)||WindowsFileState.Read(target).Id==stamp.Id)) {
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Move(full,target);path=desired;
                    }
                    var currentState=WindowsFileState.Read(LocalPaths.ResolveUnderRoot(root.Root,path));
                    var updated=old with {Complete=true,Revision=entry.Revision,RelativePath=path,ContentVersion=Version(entry),LocalState=currentState==stamp?stamp:null,LocalFileId=currentState.Id,RemoteName=resolved.Metadata?.Name};
                    // A stable body needs no checkpoint. In particular, do not
                    // reload and validate the entire catalog for every sibling.
                    if(updated!=old)await PutAsync(updated,token);
                    done++;continue;
                }
            }
            if(!File.Exists(full)) {
                if(actual is not null||old?.LocalFileId is >0&&ScanTree().Files.Any(f=>f.State.Id==old.LocalFileId))return;
                var descriptor=new RetainedOriginalRecord(entry.Id,entry.Revision,path,Identity(entry),resolved.SizeBytes,null,false,Version(entry),RemoteName:resolved.Metadata?.Name);
                await PutAsync(descriptor,token);downloads[descriptor.PlaceholderIdentity]=(entry,snapshot.Remote,path);
                provider.Add(path,resolved.SizeBytes,descriptor.PlaceholderIdentity);
            }
            var state=CloudFilesLocalStorage.PlaceholderState(full);
            if((state&0x30)!=0&&old is not null&&old.Revision!=entry.Revision) {
                using(var mutation=provider.AllowLocalMutation(full))File.Delete(full);
                var replacement=new RetainedOriginalRecord(entry.Id,entry.Revision,path,Identity(entry),resolved.SizeBytes,null,false,Version(entry),RemoteName:resolved.Metadata?.Name);
                await PutAsync(replacement,token);downloads[replacement.PlaceholderIdentity]=(entry,snapshot.Remote,path);
                provider.Add(path,resolved.SizeBytes,replacement.PlaceholderIdentity);remoteBodyChanged=false;
            }
            // Finish local saves, names and tombstones before waiting on a remote body.
            bodiesNeeded.Add((entry,path,(state&0x30)!=0&&!remoteBodyChanged));
        }
        snapshot=await catalog.LoadAsync(token);tree=ScanTree();
        foreach(var deletedFolder in snapshot.Remote.Where(e=>e.Kind=="folder"&&e.State!="present")) {
            var oldFolder=(snapshot.Folders??[]).SingleOrDefault(f=>f.Id==deletedFolder.Id);if(oldFolder is null)continue;
            var full=LocalPaths.ResolveUnderRoot(root.Root,oldFolder.RelativePath);if(!Directory.Exists(full))continue;
            bool Under(string relative)=>relative.Equals(oldFolder.RelativePath,StringComparison.OrdinalIgnoreCase)
                ||relative.StartsWith(oldFolder.RelativePath+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
            // A file moved out online is reconciled before its former directory.
            if(snapshot.Originals.Any(o=>!o.Deleted&&Under(o.RelativePath)&&snapshot.Remote.Any(e=>e.Kind=="file"&&e.Id==o.Id&&e.State=="present")))continue;
            var members=Directory.EnumerateFileSystemEntries(full,"*",SearchOption.AllDirectories).Prepend(full).ToArray();
            var leases=new List<IDisposable>();
            try {
                foreach(var member in members){_=LocalPaths.ResolveUnderRoot(root.Root,Path.GetRelativePath(root.Root,member));leases.Add(provider.AllowLocalMutation(member));}
                var saved=await WindowsRecovery.PlanAsync(staging,oldFolder.RelativePath,"オンラインで削除されたフォルダの未送信データ",token);
                root.VerifyPresent();Directory.Move(full,saved);
            }finally{foreach(var lease in leases)lease.Dispose();}
        }
        tree=ScanTree();
        var blocked=snapshot.Originals.Select(e=>e.RelativePath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var ownedIds=snapshot.Originals.Select(e=>e.LocalFileId!=0?e.LocalFileId:e.LocalState?.Id??0).Where(id=>id!=0).ToHashSet();
        foreach(var local in tree.Files.Where(e=>!blocked.Contains(e.Path)&&!claimed.Contains(e.Path)&&!ownedIds.Contains(e.State.Id))) {
            if(!folders.TryGetValue(Path.GetDirectoryName(local.Path)??"",out var folder))continue;
            if(!newFiles.TryGetValue(local.Path,out var observed)||observed.State!=local.State){newFiles[local.Path]=(local.State,Environment.TickCount64);continue;}
            if(Environment.TickCount64-observed.Since<2000)continue;
            var full=LocalPaths.ResolveUnderRoot(root.Root,local.Path);var info=new FileInfo(full);if(info.Length==0)continue;
            var (mime,kind)=MediaType(info.Extension);
            await using var prepared=await uploader.PrepareAsync(resolver,null,folder,local.Path,snapshot.RemotePosition!.Epoch,
                new(Path.GetFileName(local.Path),mime,kind,new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds()),token);
            await FinishUploadAsync(await uploader.TransferAsync(prepared.Record,resolver,prepared.Snapshot.Body,token:token),token);return;
        }
        var waiting=tree.Files.Where(e=>!blocked.Contains(e.Path)&&!claimed.Contains(e.Path)&&!ownedIds.Contains(e.State.Id)).ToArray();
        needsWork=waiting.Any(e=>folders.ContainsKey(Path.GetDirectoryName(e.Path)??""));
        if(waiting.Any(e=>e.State.Size>0&&folders.ContainsKey(Path.GetDirectoryName(e.Path)??""))) {
            progress?.Report(new("保存の完了を待ってアップロードします。",done,total));return;
        }
        foreach(var neededBody in bodiesNeeded) {
            progress?.Report(new("原本をHDDへ保存しています。",done,total));
            var (entry,path,hydrate)=neededBody;token.ThrowIfCancellationRequested();root.VerifyPresent();
            var full=LocalPaths.ResolveUnderRoot(root.Root,path);
            using var resolved=resolver.Resolve(entry);
            if(hydrate) {
                downloads[Identity(entry)]=(entry,snapshot.Remote,path);
                long validatedChange=-1;
                lock(passGate)activeHydrationPath=full;
                try {
                    await provider.HydrateAsync(path,token);
                    BeforeHydrationValidation?.Invoke(full);
                    var retained=(await catalog.LoadAsync(token)).Originals.Single(e=>e.Id==entry.Id);
                    var stamp=WindowsFileState.Read(full);var change=localChanges.GetValueOrDefault(full);
                    await using var check=await LocalOriginalSnapshot.CaptureAsync(full,staging,token:token);
                    // Never mistake a save made as soon as the file opens for
                    // provider traffic. Compare actual bytes and a stable stamp.
                    if(check.Sha256!=retained.Sha256||stamp.Id!=check.SourceFileId||stamp.Usn!=check.SourceUsn
                        ||WindowsFileState.Read(full)!=stamp||localChanges.GetValueOrDefault(full)!=change) {
                        Interrupt(local:true);return;
                    }
                    await PutAsync(retained with {Complete=true,ContentVersion=Version(entry),LocalState=stamp,LocalFileId=stamp.Id},token);
                    verifiedLocal[stamp.Id]=(stamp,full,change,retained.Sha256);validatedChange=change;
                }finally {
                    lock(passGate) {
                        activeHydrationPath=null;
                        // An edit racing the final checkpoint must not remain
                        // deferred behind the rest of the initial backup.
                        if(localChanges.GetValueOrDefault(full)!=validatedChange)currentPass?.Cancel();
                    }
                }
            }else {
                // Recheck the current catalog before exchanging any body downloaded from an older view.
                var source=new CloudContentSource(device,resolved.Id,resolved.StoredBytes,resolved.Revision);
                await using var staged=resolved.Layout is {} layout
                    ?await OriginalStager.DownloadAsync(staging,layout,resolved.FileKey!,source,token:token,retain:true)
                    :await OriginalStager.DownloadLegacyAsync(staging,resolved.SizeBytes,source,token:token,retain:true);
                var current=(await catalog.LoadAsync(token)).Remote.SingleOrDefault(e=>e.Kind=="file"&&e.Id==entry.Id);
                if(current?.Revision!=entry.Revision){await staged.DisposeAsync();root.VerifyPresent();File.Delete(staged.PersistedPath!);return;}
                await exchange.InstallAsync(staged,new(entry.Id,entry.Revision,path,Identity(entry),resolved.SizeBytes,staged.Sha256,true,Version(entry),RemoteName:resolved.Metadata?.Name),token);
            }
            done++;progress?.Report(new("原本をHDDへ保存しています。",done,total));
        }
        if(waiting.Any(e=>string.IsNullOrEmpty(Path.GetDirectoryName(e.Path)))||tree.Folders.Any(f=>string.IsNullOrEmpty(Path.GetDirectoryName(f.Path))
            &&!(snapshot.Folders??[]).Any(known=>known.FileId==f.State.Id)))
            progress?.Report(new("新しいデータは既存のT-Cloudフォルダ内へ保存してください。最上位フォルダの作成はWebから行えます。",done,total));
        else progress?.Report(new(waiting.Length>0?"保存の完了を待ってアップロードします。":"同期済み。原本はHDDに保存されています。",done,total));
    }
    private async Task PutAsync(RetainedOriginalRecord record,CancellationToken token)=>
        _=await catalog.UpdateAsync(value=>value.Originals.SingleOrDefault(e=>e.Id==record.Id)==record?value
            :value with {Originals=[..value.Originals.Where(e=>e.Id!=record.Id),record]},token);
    private async Task FinishUploadAsync(PendingWindowsUpload record,CancellationToken token)
    {
        var result=record.Result??throw new InvalidDataException("送信結果が未確定です。");root.VerifyPresent();
        var current=(await catalog.LoadAsync(token)).Originals.SingleOrDefault(e=>e.Id==result.FileId);
        var full=LocalPaths.ResolveUnderRoot(root.Root,record.RelativePath);WindowsFileState? stamp=null;
        if(File.Exists(full)) {
            var now=WindowsFileState.Read(full);
            if(now.Id==record.SourceFileId&&now.Usn!=0&&now.Usn==record.SourceUsn)stamp=now;
            if((CloudFilesLocalStorage.PlaceholderState(full)&1)==0)CloudFilesLocalStorage.ConvertSavedBody(full,current?.PlaceholderIdentity??Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("upload:"+record.OperationId))));
        }
        // The catalog may still describe the previous head until the next poll.
        // A pending acknowledgement blocks resubmission until that exact revision is observed.
        var snapshot=await catalog.LoadAsync(token);var remote=snapshot.Remote.SingleOrDefault(e=>e.Kind=="file"&&e.Id==result.FileId&&e.Revision>=result.Revision);
        if(remote is null)return;
        if(result.ContentVersion?.Length!=64)throw new InvalidDataException("送信原本の版情報がありません。");
        var baseline=new RetainedOriginalRecord(result.FileId,result.Revision,record.RelativePath,Identity(remote with {Revision=result.Revision}),record.SizeBytes,record.Sha256,true,result.ContentVersion,stamp,LocalFileId:record.SourceFileId,RemoteName:record.MetadataName);
        await PutAsync(baseline,token);await uploads.ForgetAsync(record,token);root.VerifyPresent();File.Delete(uploads.SnapshotPath(record));
    }
    private async Task PreserveUploadConflictAsync(PendingWindowsUpload record,CancellationToken token)
    {
        // Keep the captured save in Recovery even if the foreground path has since changed.
        await uploader.CancelAsync(record,token);
        await WindowsRecovery.RetainAsync(staging,uploads.SnapshotPath(record),record.RelativePath,"送信が競合した保存済み原本",token);
        await uploads.ForgetAsync(record,token);
        var full=LocalPaths.ResolveUnderRoot(root.Root,record.RelativePath);if(File.Exists(full))PreserveConflict(full,record.RelativePath);
        progress?.Report(new("競合した編集を別名で保全しました。",0,0));
    }
    private string PreserveConflict(string full,string relative)
    {
        var extension=Path.GetExtension(relative);var candidate=relative[..^extension.Length]+" (競合 "+DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N")[..6]+")"+extension;
        root.VerifyPresent();File.Move(full,LocalPaths.ResolveUnderRoot(root.Root,candidate));return candidate;
    }
    private async Task RenameFileAsync(WindowsCatalogEntry entry,CloudOriginalResolver resolver,long folder,string path,string epoch,string name,CancellationToken token)
    {
        using var original=resolver.Resolve(entry);var value=entry.Value!.Value;
        var metadata=original.Metadata! with {Name=name};
        var encrypted=CloudFileCrypto.EncryptMetadata(original.FileKey!,metadata);
        var parent=resolver.CopyFolderKey(folder);CloudCipherEnvelope wrap;
        try {wrap=CloudFileCrypto.WrapFile(parent,original.FileKey!);}finally{CryptographicOperations.ZeroMemory(parent);}
        var request=JsonSerializer.SerializeToElement(new {
            windowsEpoch=epoch,windowsExpectedRevision=entry.Revision,expectedFolderId=value.GetProperty("folderId").GetInt64(),folderId=folder,
            expectedEncryptedMetadata=value.GetProperty("encryptedMetadata").GetString(),expectedMetadataIv=value.GetProperty("metadataIv").GetString(),
            encryptedMetadata=encrypted.Ciphertext,metadataIv=encrypted.Iv,wrappedFileKey=wrap.Ciphertext,fileKeyIv=wrap.Iv,
            fastDisplay=value.TryGetProperty("displayMetadataVersion",out var display)&&display.GetInt32()==1&&metadata.MediaKind!="video"
                ?(object)new{name=metadata.Name,mimeType=metadata.MimeType,mediaKind=metadata.MediaKind,lastModified=metadata.LastModified}:null});
        var intent=new WindowsMetadataIntent(registration.ScopeHash,registration.RootFileId!.Value,"file",entry.Id,entry.Revision,epoch,path,
            WindowsFileState.Read(LocalPaths.ResolveUnderRoot(root.Root,path)).Id,request);
        await WindowsAtomicState.SaveAsync(metadataPath,intent,token);await ResumeMetadataAsync(await catalog.LoadAsync(token),token);
    }
    private async Task<bool> ResumeMetadataAsync(LocalSyncSnapshot snapshot,CancellationToken token)
    {
        var intent=await WindowsAtomicState.LoadAsync<WindowsMetadataIntent>(metadataPath,token);if(intent is null)return false;
        root.VerifyPresent();_=LocalPaths.ResolveUnderRoot(root.Root,intent.RelativePath);
        if(intent.ScopeHash!=registration.ScopeHash||intent.RootFileId!=registration.RootFileId||intent.Kind is not("file" or "folder" or "create-folder")
            ||intent.Id<1||intent.Kind!="create-folder"&&intent.ExpectedRevision<1||intent.Request.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("名前変更の再開情報が一致しません。");
        if(intent.Kind=="create-folder") {
            var created=snapshot.Remote.SingleOrDefault(e=>e.Kind=="folder"&&e.State=="present"&&e.Value is {} v
                &&v.TryGetProperty("encryptedName",out var name)&&name.GetString()==intent.Request.GetProperty("encryptedName").GetString()
                &&v.GetProperty("nameIv").GetString()==intent.Request.GetProperty("nameIv").GetString());
            if(created is not null) {
                await catalog.UpdateAsync(s=>s with {Folders=[..(s.Folders??[]).Where(f=>f.Id!=created.Id),new(created.Id,intent.RelativePath,intent.LocalFileId,created.Revision)]},token);
                File.Delete(metadataPath);return false;
            }
            if(snapshot.RemotePosition?.Epoch!=intent.Epoch)throw new InvalidDataException("新規フォルダの同期中にオンラインの復旧を検出しました。ローカルの原本を保持して停止しました。");
            if(!intent.Acknowledged) {
                using var createdResponse=await device.SendDataAsync("windows-folders",HttpMethod.Post,()=>JsonContent.Create(intent.Request),token:token);
                createdResponse.EnsureSuccessStatusCode();await WindowsAtomicState.SaveAsync(metadataPath,intent with {Acknowledged=true},token);
            }
            return true;
        }
        var remote=snapshot.Remote.SingleOrDefault(e=>e.Kind==intent.Kind&&e.Id==intent.Id);
        if(remote is null)return true;
        if(remote.State!="present"){File.Delete(metadataPath);return false;}
        var value=remote.Value!.Value;
        bool Same(string name)=>value.TryGetProperty(name,out var actual)&&intent.Request.TryGetProperty(name,out var expected)&&actual.GetRawText()==expected.GetRawText();
        var matches=intent.Kind=="file"?Same("encryptedMetadata")&&Same("metadataIv")&&Same("folderId")
            :intent.Request.TryGetProperty("parentId",out _)?Same("parentId")&&Same("parentWrappedKey")&&Same("parentWrapIv"):Same("name");
        if(matches) {
            if(intent.Kind=="file") {
                var original=snapshot.Originals.Single(e=>e.Id==intent.Id);
                using var resolver=new CloudOriginalResolver(key,snapshot.Remote,keys);using var resolved=resolver.Resolve(remote);
                await PutAsync(original with {Revision=remote.Revision,RelativePath=intent.RelativePath,ContentVersion=Version(remote),LocalState=null,LocalFileId=intent.LocalFileId,RemoteName=resolved.Metadata?.Name},token);
            }else await catalog.UpdateAsync(s=>s with {Folders=(s.Folders??[]).Select(f=>f.Id==intent.Id?f with {Revision=remote.Revision,RelativePath=intent.RelativePath}:f).ToArray()},token);
            File.Delete(metadataPath);return false;
        }
        if(remote.Revision!=intent.ExpectedRevision||snapshot.RemotePosition?.Epoch!=intent.Epoch) {
            if(intent.Kind=="file") {
                var path=LocalPaths.ResolveUnderRoot(root.Root,intent.RelativePath);if(File.Exists(path))PreserveConflict(path,intent.RelativePath);
                var original=snapshot.Originals.Single(e=>e.Id==intent.Id);await PutAsync(original with {LocalFileId=0,LocalState=null,Complete=false},token);
            }
            File.Delete(metadataPath);progress?.Report(new("オンラインの名前変更との競合を保全し、最新状態を反映します。",0,0));return false;
        }
        if(intent.Acknowledged)return true;
        using var response=await device.SendDataAsync((intent.Kind=="file"?"files/":"folders/")+intent.Id,HttpMethod.Patch,
            ()=>JsonContent.Create(intent.Request),token:token);
        if(response.StatusCode==HttpStatusCode.Conflict)return true;
        response.EnsureSuccessStatusCode();await WindowsAtomicState.SaveAsync(metadataPath,intent with {Acknowledged=true},token);return true;
    }
    private sealed record Tree((string Path,WindowsFileState State)[] Files,(string Path,WindowsFileState State)[] Folders);
    private Tree ScanTree()
    {
        var files=new List<(string,WindowsFileState)>();var dirs=new List<(string,WindowsFileState)>();
        void Walk(string path) {
            foreach(var item in Directory.EnumerateFileSystemEntries(path)) {
                var relative=Path.GetRelativePath(root.Root,item);_=LocalPaths.ResolveUnderRoot(root.Root,relative);
                var attrs=File.GetAttributes(item);if((attrs&FileAttributes.Directory)!=0){dirs.Add((relative,WindowsFileState.Read(item)));Walk(item);}
                else if(!Ignored(Path.GetFileName(item)))files.Add((relative,WindowsFileState.Read(item)));
            }
        }
        Walk(root.Root);return new(files.ToArray(),dirs.ToArray());
    }
    private static bool Ignored(string name)=>name.Equals("desktop.ini",StringComparison.OrdinalIgnoreCase)||name.StartsWith("~$",StringComparison.Ordinal)
        ||System.Text.RegularExpressions.Regex.IsMatch(name,"^[0-9a-fA-F]{8}$")
        ||name.StartsWith("~WR",StringComparison.OrdinalIgnoreCase)||name.EndsWith(".tmp",StringComparison.OrdinalIgnoreCase);
    private static string? Locate(RetainedOriginalRecord record,Tree tree)=>record.Deleted
        ?tree.Files.FirstOrDefault(f=>f.Path.Equals(record.RelativePath,StringComparison.OrdinalIgnoreCase)).Path
        :tree.Files.FirstOrDefault(f=>f.State.Id==(record.LocalFileId!=0?record.LocalFileId:record.LocalState?.Id)).Path
            ??tree.Files.FirstOrDefault(f=>f.Path.Equals(record.RelativePath,StringComparison.OrdinalIgnoreCase)).Path;
    private static string UniquePath(string desired,long id,ISet<string> claimed,IEnumerable<RetainedOriginalRecord> originals)
    {
        if(!claimed.Contains(desired)&&!originals.Any(e=>e.Id!=id&&e.RelativePath.Equals(desired,StringComparison.OrdinalIgnoreCase)))return desired;
        var ext=Path.GetExtension(desired);return desired[..^ext.Length]+" (T-Cloud "+id+")"+ext;
    }
    private static string MappedPath(string path,WindowsCatalogEntry entry,LocalFolderRecord[] folders)
    {
        var parent=entry.Value!.Value.GetProperty("folderId");
        var mapped=parent.ValueKind==JsonValueKind.Null?null:folders.SingleOrDefault(f=>f.Id==parent.GetInt64());return mapped is null?path:Path.Combine(mapped.RelativePath,Path.GetFileName(path));
    }
    private async Task<bool> ReconcileFoldersAsync(LocalSyncSnapshot snapshot,CloudOriginalResolver resolver,Tree tree,CancellationToken token)
    {
        var known=(snapshot.Folders??[]).ToList();var remote=resolver.DescribeFolders();
        foreach(var folder in remote.OrderBy(e=>e.RelativePath.Count(c=>c=='\\'))) {
            var old=known.SingleOrDefault(e=>e.Id==folder.Id);
            var actual=old is null?null:tree.Folders.FirstOrDefault(e=>e.State.Id==old.FileId).Path;
            var desired=folder.RelativePath;
            if(folder.ParentId is {} parent&&known.SingleOrDefault(e=>e.Id==parent) is {} mapped)desired=Path.Combine(mapped.RelativePath,Path.GetFileName(desired));
            if(known.Any(f=>f.Id!=folder.Id&&f.RelativePath.Equals(desired,StringComparison.OrdinalIgnoreCase))
                ||old is null&&Directory.Exists(LocalPaths.ResolveUnderRoot(root.Root,desired)))desired+=" (T-Cloud "+folder.Id+")";
            if(old is not null&&actual is not null&&actual!=old.RelativePath&&folder.Revision==old.Revision) {
                var value=snapshot.Remote.Single(e=>e.Kind=="folder"&&e.Id==folder.Id).Value!.Value;
                var actualParent=Path.GetDirectoryName(actual)??"";
                var destinationParent=known.SingleOrDefault(f=>f.RelativePath.Equals(actualParent,StringComparison.OrdinalIgnoreCase));
                JsonElement body;var baselinePath=actual;
                if(destinationParent is not null&&destinationParent.Id!=folder.ParentId) {
                    var parentKey=resolver.CopyFolderKey(destinationParent.Id);var folderKey=resolver.CopyFolderKey(folder.Id);
                    try {
                        var wrap=CloudFileCrypto.WrapChildFolder(parentKey,folderKey);
                        body=JsonSerializer.SerializeToElement(new {name=value.GetProperty("name").GetString(),parentId=destinationParent.Id,expectedParentId=folder.ParentId,
                            parentWrappedKey=wrap.Ciphertext,parentWrapIv=wrap.Iv,windowsEpoch=snapshot.RemotePosition!.Epoch,windowsExpectedRevision=folder.Revision});
                        baselinePath=Path.Combine(actualParent,Path.GetFileName(folder.RelativePath));
                    }finally{CryptographicOperations.ZeroMemory(parentKey);CryptographicOperations.ZeroMemory(folderKey);}
                }else if(actualParent!=Path.GetDirectoryName(old.RelativePath)) {
                    progress?.Report(new("移動先には既存のT-Cloudフォルダを選択してください。原本はHDDに保持されています。",0,0));return true;
                }else body=JsonSerializer.SerializeToElement(new {name=Path.GetFileName(actual),windowsEpoch=snapshot.RemotePosition!.Epoch,windowsExpectedRevision=folder.Revision});
                await WindowsAtomicState.SaveAsync(metadataPath,new WindowsMetadataIntent(registration.ScopeHash,registration.RootFileId!.Value,"folder",folder.Id,folder.Revision,
                    snapshot.RemotePosition!.Epoch,baselinePath,old.FileId,body),token);
                await ResumeMetadataAsync(snapshot,token);return true;
            }
            var relative=actual??old?.RelativePath??desired;
            var full=LocalPaths.ResolveUnderRoot(root.Root,relative);
            if(old is not null&&actual is not null&&old.Revision!=folder.Revision&&actual==old.RelativePath&&relative!=desired
                &&(!Directory.Exists(LocalPaths.ResolveUnderRoot(root.Root,desired))||WindowsFileState.Read(LocalPaths.ResolveUnderRoot(root.Root,desired)).Id==old.FileId)) {
                var target=LocalPaths.ResolveUnderRoot(root.Root,desired);Directory.CreateDirectory(Path.GetDirectoryName(target)!);Directory.Move(full,target);relative=desired;full=target;
            }
            Directory.CreateDirectory(full);protectFolder?.Invoke(full);
            known.RemoveAll(e=>e.Id==folder.Id);known.Add(new(folder.Id,relative,WindowsFileState.Read(full).Id,folder.Revision));
        }
        if(!known.SequenceEqual(snapshot.Folders??[]))await catalog.UpdateAsync(value=>value with {Folders=known.ToArray()},token);
        var ids=known.Select(f=>f.FileId).ToHashSet();
        var deletedPaths=known.Where(f=>snapshot.Remote.Any(e=>e.Kind=="folder"&&e.Id==f.Id&&e.State!="present")).Select(f=>f.RelativePath).ToArray();
        foreach(var local in tree.Folders.OrderBy(e=>e.Path.Count(c=>c=='\\')).Where(f=>!ids.Contains(f.State.Id))) {
            if(deletedPaths.Any(p=>local.Path.Equals(p,StringComparison.OrdinalIgnoreCase)||local.Path.StartsWith(p+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)))continue;
            var parentPath=Path.GetDirectoryName(local.Path)??"";var parent=known.SingleOrDefault(f=>f.RelativePath.Equals(parentPath,StringComparison.OrdinalIgnoreCase));
            if(parent is null)continue;
            var parentKey=resolver.CopyFolderKey(parent.Id);var child=RandomNumberGenerator.GetBytes(32);
            try {
                using var config=await device.SendDataAsync("crypto-config",HttpMethod.Get,token:token);config.EnsureSuccessStatusCode();
                var publicConfig=await WindowsDeviceClient.ReadJsonAsync(config,token);using var rsa=RSA.Create();
                var jwk=publicConfig.GetProperty("publicKeyJwk");
                static byte[] Decode(string text)=>Convert.FromBase64String(text.Replace('-','+').Replace('_','/').PadRight((text.Length+3)/4*4,'='));
                rsa.ImportParameters(new RSAParameters{Modulus=Decode(jwk.GetProperty("n").GetString()!),Exponent=Decode(jwk.GetProperty("e").GetString()!)});
                var wrap=CloudFileCrypto.WrapChildFolder(parentKey,child);var name=CloudFileCrypto.EncryptFolderName(child,Path.GetFileName(local.Path));
                var admin=Convert.ToBase64String(rsa.Encrypt(child,RSAEncryptionPadding.OaepSHA256)).TrimEnd('=').Replace('+','-').Replace('/','_');
                var body=JsonSerializer.SerializeToElement(new{operationId=Guid.NewGuid().ToString("N"),epoch=snapshot.RemotePosition!.Epoch,parentId=parent.Id,
                    name=Path.GetFileName(local.Path),cryptoVersion=1,encryptedName=name.Ciphertext,nameIv=name.Iv,adminWrappedKey=admin,parentWrappedKey=wrap.Ciphertext,parentWrapIv=wrap.Iv});
                await WindowsAtomicState.SaveAsync(metadataPath,new WindowsMetadataIntent(registration.ScopeHash,registration.RootFileId!.Value,"create-folder",parent.Id,0,
                    snapshot.RemotePosition.Epoch,local.Path,local.State.Id,body),token);
                await ResumeMetadataAsync(snapshot,token);return true;
            }finally{CryptographicOperations.ZeroMemory(parentKey);CryptographicOperations.ZeroMemory(child);}
        }
        return false;
    }
    private static (string Mime,string Kind) MediaType(string extension)=>extension.ToLowerInvariant() switch {
        ".jpg" or ".jpeg"=>("image/jpeg","image"),".png"=>("image/png","image"),".heic"=>("image/heic","image"),".webp"=>("image/webp","image"),
        ".mp4"=>("video/mp4","video"),".mov"=>("video/quicktime","video"),".mkv"=>("video/x-matroska","video"),
        ".docx"=>("application/vnd.openxmlformats-officedocument.wordprocessingml.document","document"),
        ".xlsx"=>("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","document"),
        ".pptx"=>("application/vnd.openxmlformats-officedocument.presentationml.presentation","document"),".pdf"=>("application/pdf","document"),
        ".txt"=>("text/plain","document"),_=>("application/octet-stream","other")};
    public async ValueTask DisposeAsync()
    {
        watcher.Dispose();lifetime.Cancel();try{await worker;}finally{provider.Dispose();key.Dispose();lifetime.Dispose();wake.Dispose();}
    }
}

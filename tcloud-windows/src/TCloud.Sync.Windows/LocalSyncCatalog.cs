using System.Text.Json;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record RetainedOriginalRecord(long Id,long Revision,string RelativePath,string PlaceholderIdentity,
    long SizeBytes,string? Sha256,bool Complete,string? ContentVersion=null,WindowsFileState? LocalState=null,bool Deleted=false,long LocalFileId=0,string? RemoteName=null);
public sealed record LocalFolderRecord(long Id,string RelativePath,long FileId,long Revision);
public sealed record LocalSyncSnapshot(int Version,string ScopeHash,VolumeBinding Volume,long RootFileId,
    WindowsCatalogStart? RemotePosition,WindowsCatalogEntry[] Remote,RetainedOriginalRecord[] Originals,LocalFolderRecord[]? Folders=null);

/// <summary>Atomic PC-side restart state. No Cookie, access token, PRF or plaintext key fields.</summary>
public sealed class LocalSyncCatalog(string path,WindowsDeviceRegistration registration)
{
    private readonly string path=Path.GetFullPath(path);
    private readonly SemaphoreSlim gate=new(1,1);
    private const int MaxBytes=64*1024*1024;
    public LocalSyncSnapshot Empty()=>new(1,registration.ScopeHash,registration.Volume,
        registration.RootFileId??throw new InvalidOperationException("保存先の初期登録が完了していません。"),null,[],[]);
    public async Task<LocalSyncSnapshot> LoadAsync(CancellationToken token=default)
    {
        await gate.WaitAsync(token);
        try {return await LoadCoreAsync(token);}
        finally {gate.Release();}
    }
    private async Task<LocalSyncSnapshot> LoadCoreAsync(CancellationToken token)
    {
        ValidatePath();
        if(!File.Exists(path))return Empty();
        await using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,4096,FileOptions.Asynchronous);
        if(stream.Length is <1 or >MaxBytes)throw new InvalidDataException("同期記録のサイズが不正です。");
        var value=await JsonSerializer.DeserializeAsync<LocalSyncSnapshot>(stream,cancellationToken:token)
            ??throw new InvalidDataException("同期記録を読み取れません。");
        Validate(value);return value;
    }
    public async Task SaveAsync(LocalSyncSnapshot value,CancellationToken token=default)
    {
        Validate(value);await gate.WaitAsync(token);
        try {await SaveCoreAsync(value,token);}
        finally {gate.Release();}
    }
    public Task<LocalSyncSnapshot> RecordStagedOriginalAsync(OriginalDescriptor descriptor,string sha256,CancellationToken token=default)
        =>UpdateAsync(current=>
        {
            var old=current.Originals.SingleOrDefault(e=>e.Id==descriptor.Id);
            if(old is not null&&(old.Revision>descriptor.Revision||old.Revision==descriptor.Revision&&old.Sha256 is not null&&old.Sha256!=sha256))
                throw new InvalidDataException("保存済み原本より古い版、または同じ版の異なる内容は確定できません。");
            var retained=old is {Complete:true}&&old.Revision==descriptor.Revision&&old.SizeBytes==descriptor.SizeBytes
                &&old.PlaceholderIdentity==descriptor.Identity&&old.RelativePath==descriptor.RelativePath&&old.Sha256==sha256;
            var remote=current.Remote.SingleOrDefault(e=>e.Kind=="file"&&e.Id==descriptor.Id&&e.Revision==descriptor.Revision);
            var version=remote?.Value is {} value&&value.TryGetProperty("contentVersion",out var content)?content.GetString():null;
            return current with {Originals=[..current.Originals.Where(e=>e.Id!=descriptor.Id),
                new(descriptor.Id,descriptor.Revision,descriptor.RelativePath,descriptor.Identity,descriptor.SizeBytes,sha256,retained,version,
                    LocalFileId:old?.LocalFileId??0,RemoteName:descriptor.RemoteName)]};
        },token);
    public Task<LocalSyncSnapshot> MarkOriginalRetainedAsync(OriginalDescriptor descriptor,CancellationToken token=default)
        =>UpdateAsync(current=>
        {
            var original=current.Originals.SingleOrDefault(e=>e.Id==descriptor.Id);
            if(original is null||original.Revision!=descriptor.Revision||original.PlaceholderIdentity!=descriptor.Identity
                ||original.RelativePath!=descriptor.RelativePath||original.SizeBytes!=descriptor.SizeBytes||original.Sha256 is null)
                throw new InvalidDataException("取得完了を記録する原本の版が一致しません。");
            return current with {Originals=current.Originals.Select(e=>e.Id==descriptor.Id?e with {Complete=true}:e).ToArray()};
        },token);
    // Catalog polling and foreground hydration share this store. Loading and
    // saving under separate locks would silently lose one writer's baseline.
    public async Task<LocalSyncSnapshot> UpdateAsync(Func<LocalSyncSnapshot,LocalSyncSnapshot> update,CancellationToken token=default)
    {
        ArgumentNullException.ThrowIfNull(update);await gate.WaitAsync(token);
        try
        {
            var before=await LoadCoreAsync(token);var value=update(before);Validate(value);
            if(ReferenceEquals(before,value))return value;
            await SaveCoreAsync(value,token);return value;
        }
        finally {gate.Release();}
    }
    private async Task SaveCoreAsync(LocalSyncSnapshot value,CancellationToken token)
    {
        var pending=path+"."+Guid.NewGuid().ToString("N")+".pending";
        try
        {
            ValidatePath();Directory.CreateDirectory(Path.GetDirectoryName(path)!);ValidatePath();
            var bytes=JsonSerializer.SerializeToUtf8Bytes(value);
            if(bytes.Length>MaxBytes)throw new InvalidDataException("同期記録が上限を超えています。");
            await using(var stream=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {await stream.WriteAsync(bytes,token);await stream.FlushAsync(token);stream.Flush(flushToDisk:true);}
            token.ThrowIfCancellationRequested();ValidatePath();
            if(File.Exists(path))File.Replace(pending,path,null);else File.Move(pending,path);
        }
        finally {if(File.Exists(pending))File.Delete(pending);}
    }
    public static LocalSyncSnapshot ApplyPage(LocalSyncSnapshot snapshot,WindowsCatalogStart start,WindowsCatalogPage page,bool reset=false)
    {
        if(page.Epoch!=start.Epoch||page.Until!=start.Cursor||page.Next>start.Cursor||page.Next<0||page.Complete!=(page.Next==start.Cursor))
            throw new InvalidDataException("差分の確認位置が一致しません。");
        if(!reset&&snapshot.RemotePosition is {} previous&&(previous.Epoch!=start.Epoch||page.Next<previous.Cursor))
            throw new WindowsCatalogResetException();
        var entries=(reset?[]:snapshot.Remote).ToDictionary(e=>(e.Kind,e.Id));
        foreach(var item in page.Items)
            if(!entries.TryGetValue((item.Kind,item.Id),out var old)||old.Revision<item.Revision)entries[(item.Kind,item.Id)]=item;
        // A resnapshot may drop remote visibility but never drops a local body
        // record. Only an explicit authenticated tombstone authorizes deletion.
        return snapshot with {RemotePosition=new(start.Epoch,page.Next),Remote=entries.Values.OrderBy(e=>e.Kind).ThenBy(e=>e.Id).ToArray()};
    }
    private void Validate(LocalSyncSnapshot value)
    {
        if(value.Version!=1||value.ScopeHash!=registration.ScopeHash||value.Volume!=registration.Volume
            ||value.RootFileId!=registration.RootFileId||value.RootFileId==0||value.Remote is null||value.Originals is null
            ||value.Remote.Length>100000||value.Originals.Length>100000
            ||value.Remote.Any(e=>e is null)||value.Originals.Any(e=>e is null)
            ||value.Remote.Select(e=>(e.Kind,e.Id)).Distinct().Count()!=value.Remote.Length
            ||value.Originals.Select(e=>e.Id).Distinct().Count()!=value.Originals.Length)
            throw new InvalidDataException("同期記録のアカウント・媒体・保存先が一致しません。");
        foreach(var item in value.Remote)
            if(item.Id<1||item.Revision<1||item.Kind is not("file" or "folder")||item.State is not("present" or "trashed" or "purged"))
                throw new InvalidDataException("オンラインの同期記録が不正です。");
        if(value.RemotePosition is {} position&&(position.Epoch?.Length!=32||position.Epoch.Any(c=>!char.IsAsciiHexDigit(c))||position.Cursor<0
            ||value.Remote.Any(e=>e.Revision>position.Cursor))||value.RemotePosition is null&&value.Remote.Length!=0)
            throw new InvalidDataException("同期記録の確認位置が不正です。");
        foreach(var item in value.Originals)
        {
            static bool Hash(string? text)=>text?.Length==64&&text.All(char.IsAsciiHexDigit);
            if(item.Id<1||item.Revision<1||item.SizeBytes<1||!Hash(item.PlaceholderIdentity)||item.Sha256 is not null&&!Hash(item.Sha256)
                ||item.Complete&&item.Sha256 is null)throw new InvalidDataException("原本の保存記録が不正です。");
        }
        if(value.Originals.Select(e=>e.RelativePath).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=value.Originals.Length)
            throw new InvalidDataException("複数の原本が同じ保存先を使用しています。");
        if(value.Folders is {} folders) {
            if(folders.Length>100000||folders.Any(f=>f is null||f.Id<1||f.FileId==0||f.Revision<1)
                ||folders.Select(f=>f.Id).Distinct().Count()!=folders.Length
                ||folders.Select(f=>f.RelativePath).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=folders.Length)
                throw new InvalidDataException("フォルダの同期記録が不正です。");
        }
        LocalPaths.ValidateAllUnderRoot(registration.Destination,value.Originals.Select(o=>o.RelativePath)
            .Concat((value.Folders??[]).Select(f=>f.RelativePath)));
    }
    private void ValidatePath()
    {
        if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の同期記録は使用しません。");
        for(var directory=Directory.GetParent(path);directory is not null;directory=directory.Parent)
            if(directory.Exists&&directory.LinkTarget is not null)throw new IOException("リンク経由の同期記録は使用しません。");
    }
}

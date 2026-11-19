using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record OriginalDescriptor(long Id,long Revision,string RelativePath,long SizeBytes,string Identity);

/// <summary>Connects scoped device HTTP, existing vault crypto and complete local staging to CFAPI.</summary>
public sealed class WindowsOriginalTransfer
{
    private readonly WindowsDeviceClient device;
    private readonly CloudFilesRootRegistration root;
    private readonly CloudOriginalResolver resolver;
    private readonly WindowsDeviceRegistration registration;
    private readonly string staging;
    private readonly Func<OriginalDescriptor,string,CancellationToken,Task> checkpoint;
    private readonly ConcurrentDictionary<string,(WindowsCatalogEntry Entry,OriginalDescriptor Descriptor)> entries=new(StringComparer.Ordinal);
    public WindowsOriginalTransfer(WindowsDeviceClient device,CloudFilesRootRegistration root,CloudOriginalResolver resolver,
        WindowsDeviceRegistration registration,string staging,LocalSyncCatalog catalog)
        :this(device,root,resolver,registration,staging,async(descriptor,hash,token)=>
            {await catalog.RecordStagedOriginalAsync(descriptor,hash,token);}) { }
    public WindowsOriginalTransfer(WindowsDeviceClient device,CloudFilesRootRegistration root,CloudOriginalResolver resolver,
        WindowsDeviceRegistration registration,string staging,Func<OriginalDescriptor,string,CancellationToken,Task> checkpoint)
    {
        this.device=device;this.root=root;this.resolver=resolver;this.registration=registration;this.staging=Path.GetFullPath(staging);this.checkpoint=checkpoint;
        root.VerifyPresent();var actual=VolumeInspector.Inspect(this.staging);
        if(!actual.Matches(registration.Volume))throw new IOException("原本の一時保存先は同じHDDにしてください。");
        _=VolumeInspector.ValidateDestination(this.staging,[]);
    }
    public OriginalDescriptor Register(WindowsCatalogEntry entry,string? relativePath=null)
    {
        root.VerifyPresent();
        using var value=resolver.Resolve(entry);
        var path=relativePath??value.RelativePath;_=LocalPaths.ResolveUnderRoot(root.Root,path);
        var identity=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            "TCloud.Windows.Original.v1\n"+registration.ScopeHash+"\n"+entry.Id+"\n"+entry.Revision)));
        var descriptor=new OriginalDescriptor(entry.Id,entry.Revision,path,value.SizeBytes,identity);
        entries.AddOrUpdate(identity,(entry,descriptor),(_,old)=>old.Descriptor==descriptor?old
            :throw new InvalidDataException("同じ原本の保存先が複数指定されています。"));
        return descriptor;
    }
    public async Task<Stream> OpenAsync(string identity,IProgress<long> progress,CancellationToken token)
    {
        root.VerifyPresent();
        if(!entries.TryGetValue(identity,out var known))throw new IOException("登録済み原本の取得情報を確認できません。");
        using var resolved=resolver.Resolve(known.Entry);
        if(new DriveInfo(Path.GetPathRoot(staging)!).AvailableFreeSpace<2*resolved.SizeBytes+32L*1024*1024)
            throw new IOException("取得と原本保持に必要な空き容量がありません。保存済み原本は削除しません。");
        var source=new BoundSource(root,new CloudContentSource(device,resolved.Id,resolved.StoredBytes,resolved.Revision));
        var staged=resolved.Layout is {} layout
            ?await OriginalStager.DownloadAsync(staging,layout,resolved.FileKey!,source,progress,token)
            :await OriginalStager.DownloadLegacyAsync(staging,resolved.SizeBytes,source,progress,token);
        try
        {
            root.VerifyPresent();
            // The baseline must be durable before a foreground application can
            // read and immediately edit the newly hydrated original.
            await checkpoint(known.Descriptor,staged.Sha256,token);
            return staged.Body;
        }
        catch {await staged.DisposeAsync();throw;}
    }
    private sealed class BoundSource(CloudFilesRootRegistration root,IEncryptedRangeSource inner):IEncryptedRangeSource
    {
        public async ValueTask<EncryptedRangeResponse> ReadAsync(long offset,int length,string? etag,CancellationToken token)
        {
            root.VerifyPresent();var result=await inner.ReadAsync(offset,length,etag,token);root.VerifyPresent();return result;
        }
    }
}

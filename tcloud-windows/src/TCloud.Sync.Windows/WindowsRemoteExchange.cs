using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

internal sealed record PendingRemoteExchange(string ScopeHash,long RootFileId,RetainedOriginalRecord Baseline,string StagedName,string BackupName,string? PreviousSha256);

/// <summary>Durable replace intent precedes the atomic filesystem exchange; late edits survive in Recovery.</summary>
internal sealed class WindowsRemoteExchange(CloudFilesRootRegistration root,CloudFilesProvider provider,
    LocalSyncCatalog catalog,WindowsDeviceRegistration registration,string directory,string intentPath)
{
    private string PathIn(string relative)=>LocalPaths.ResolveUnderRoot(directory,relative);
    public async Task InstallAsync(VerifiedOriginal staged,RetainedOriginalRecord baseline,CancellationToken token)
    {
        if(staged.PersistedPath is null)throw new ArgumentException("保存済みの取得原本が必要です。");
        var name=Path.GetFileName(staged.PersistedPath);
        if(PathIn(name)!=Path.GetFullPath(staged.PersistedPath))throw new InvalidDataException("取得原本の保存先が一致しません。");
        var previous=(await catalog.LoadAsync(token)).Originals.SingleOrDefault(e=>e.Id==baseline.Id);
        var intent=new PendingRemoteExchange(registration.ScopeHash,registration.RootFileId!.Value,baseline,name,Guid.NewGuid().ToString("N")+".recovery",previous?.Sha256);
        await staged.DisposeAsync();await WindowsAtomicState.SaveAsync(intentPath,intent,token);await ResumeAsync(token);
    }
    public async Task ResumeAsync(CancellationToken token)
    {
        var intent=await WindowsAtomicState.LoadAsync<PendingRemoteExchange>(intentPath,token);if(intent is null)return;
        root.VerifyPresent();
        if(intent.ScopeHash!=registration.ScopeHash||intent.RootFileId!=registration.RootFileId
            ||!System.Text.RegularExpressions.Regex.IsMatch(intent.StagedName,"^[a-f0-9]{32}\\.partial$")
            ||!System.Text.RegularExpressions.Regex.IsMatch(intent.BackupName,"^[a-f0-9]{32}\\.recovery$"))throw new InvalidDataException("原本の交換記録が一致しません。");
        var target=LocalPaths.ResolveUnderRoot(root.Root,intent.Baseline.RelativePath);
        var staged=PathIn(intent.StagedName);var backup=PathIn(intent.BackupName);
        // The staging copy was completely authenticated and flushed before the intent.
        if(File.Exists(staged)) {
            await using(var verify=await LocalOriginalSnapshot.CaptureAsync(staged,directory,token:token))
                if(verify.Sha256!=intent.Baseline.Sha256)throw new InvalidDataException("取得済み原本の検証に失敗しました。");
            root.VerifyPresent();Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if(File.Exists(target)) {
                if((CloudFilesLocalStorage.PlaceholderState(target)&0x30)!=0) {
                    using var mutation=provider.AllowLocalMutation(target);File.Delete(target);File.Move(staged,target);
                }else{
                    using var mutation=provider.AllowLocalMutation(target);File.Replace(staged,target,backup);
                }
            }else File.Move(staged,target);
        }
        if(!File.Exists(target))throw new InvalidDataException("交換後の原本が見つかりません。保全領域は削除していません。");
        if((CloudFilesLocalStorage.PlaceholderState(target)&1)==0)CloudFilesLocalStorage.ConvertSavedBody(target,intent.Baseline.PlaceholderIdentity);
        // Capture a new identity stamp only while a stable copy still matches the uploaded/downloaded bytes.
        WindowsFileState? stamp=WindowsFileState.Read(target);
        await using(var verify=await LocalOriginalSnapshot.CaptureAsync(target,directory,token:token)) {
            if(verify.Sha256!=intent.Baseline.Sha256||verify.SourceFileId!=stamp.Id||verify.SourceUsn!=stamp.Usn)stamp=null;
        }
        await catalog.UpdateAsync(value=>value with {Originals=[..value.Originals.Where(e=>e.Id!=intent.Baseline.Id),intent.Baseline with {Complete=true,LocalState=stamp,LocalFileId=WindowsFileState.Read(target).Id}]},token);
        if(File.Exists(backup))_=await WindowsRecovery.DeleteIfUnchangedAsync(backup,intent.PreviousSha256,root.VerifyPresent,token);
        if(File.Exists(backup))await WindowsRecovery.RetainAsync(directory,backup,intent.Baseline.RelativePath,"原本の更新直前に行われた編集",token);
        // A differing backup is a late save and remains in the recovery area.
        root.VerifyPresent();WindowsAtomicState.Check(intentPath);File.Delete(intentPath);
    }
}

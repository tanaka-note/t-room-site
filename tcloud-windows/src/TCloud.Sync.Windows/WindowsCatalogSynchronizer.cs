namespace TCloud.Sync.Windows;

/// <summary>Publishes a fixed, complete online view atomically. Failed pages never advance the durable cursor.</summary>
public sealed class WindowsCatalogSynchronizer(IWindowsCatalogSource source,LocalSyncCatalog store)
{
    private readonly SemaphoreSlim refresh=new(1,1);
    public async Task<LocalSyncSnapshot> RefreshAsync(CancellationToken token=default)
    {
        await refresh.WaitAsync(token);
        try
        {
            var before=await store.LoadAsync(token);
            var start=await source.StartAsync(token);
            if(before.RemotePosition==start)return before;
            var snapshot=before.RemotePosition is not {} position||position.Epoch!=start.Epoch||position.Cursor>start.Cursor;
            var after=snapshot?0:before.RemotePosition!.Cursor;
            var candidate=before;
            var first=true;
            do
            {
                var page=await source.PageAsync(start,after,snapshot,token);
                if(page.Next<after||!page.Complete&&page.Next<=after)
                    throw new InvalidDataException("一覧の続きの位置が進んでいません。");
                candidate=LocalSyncCatalog.ApplyPage(candidate,start,page,reset:snapshot&&first);
                if(candidate.Remote.Length>100000)throw new InvalidDataException("同期項目数が上限を超えています。");
                after=page.Next;first=false;
                if(page.Complete)break;
            }while(true);
            token.ThrowIfCancellationRequested();
            return await store.UpdateAsync(current=>
            {
                if(current.RemotePosition!=before.RemotePosition)
                    throw new IOException("ほかの同期処理が確認位置を変更しました。再確認します。");
                // Keep any original baselines committed by foreground downloads
                // while these HTTP pages were being obtained.
                return current with {Remote=candidate.Remote,RemotePosition=candidate.RemotePosition};
            },token);
        }
        finally {refresh.Release();}
    }
}

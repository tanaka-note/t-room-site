using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

/// <summary>FULL, permanently retained originals. The factory returns a complete, verified plaintext stream.</summary>
public sealed class CloudFilesProvider : IDisposable
{
    private readonly CloudFilesRootRegistration root;
    private readonly Func<string,IProgress<long>,CancellationToken,Task<Stream>> original;
    private readonly CloudFilesNative.Callback fetch, cancel, delete, rename;
    private readonly CancellationTokenSource lifetime=new();
    private readonly SemaphoreSlim downloads=new(2,2);
    private readonly object gate=new();
    private readonly ManualResetEventSlim finished=new(true);
    private int workers,disposed;
    private long connection;
    private readonly ConcurrentDictionary<long,int> localMutations=new();
    private readonly ConcurrentDictionary<string,Task> hydrationTasks=new(StringComparer.OrdinalIgnoreCase);
    public ConcurrentQueue<Exception> Errors {get;}=new();

    public CloudFilesProvider(CloudFilesRootRegistration root,Func<string,IProgress<long>,CancellationToken,Task<Stream>> original)
    {
        this.root=root;this.original=original;
        root.VerifyPresent();
        fetch=Fetch;cancel=Cancel;delete=Delete;rename=Rename;
        CloudFilesNative.CallbackRegistration[] callbacks=[
            new(){Type=0,Function=Marshal.GetFunctionPointerForDelegate(fetch)},
            new(){Type=2,Function=Marshal.GetFunctionPointerForDelegate(cancel)},
            new(){Type=9,Function=Marshal.GetFunctionPointerForDelegate(delete)},
            new(){Type=11,Function=Marshal.GetFunctionPointerForDelegate(rename)},new(){Type=-1}];
        CloudFilesNative.Check(CloudFilesNative.CfConnectSyncRoot(root.Root,callbacks,0,6,out connection));
    }
    public void Add(string relativePath,long size,string identity)
    {
        ObjectDisposedException.ThrowIf(disposed!=0,this);root.VerifyPresent();
        if(size<1 || size>64L*1024*1024*10000 || identity.Length!=64 || identity.Any(ch=>!char.IsAsciiHexDigit(ch)))
            throw new InvalidDataException("ファイルの識別情報またはサイズが不正です。");
        var path=LocalPaths.ResolveUnderRoot(root.Root,relativePath);
        if(File.Exists(path)||Directory.Exists(path))throw new IOException("既存ファイルをプレースホルダーで上書きしません。");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var bytes=Encoding.ASCII.GetBytes(identity);var memory=Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes,0,memory,bytes.Length);var time=DateTime.UtcNow.ToFileTimeUtc();
            CloudFilesNative.Placeholder[] entries=[new(){RelativeFileName=Path.GetFileName(path),FileIdentity=memory,
                FileIdentityLength=(uint)bytes.Length,Flags=2|8,FsMetadata=new(){FileSize=size,
                    Basic=new(){Attributes=(uint)FileAttributes.Normal,CreationTime=time,LastWriteTime=time,LastAccessTime=time,ChangeTime=time}}}];
            CloudFilesNative.Check(CloudFilesNative.CfCreatePlaceholders(Path.GetDirectoryName(path)!,entries,1,1,out var processed));
            if(processed!=1)throw new IOException("ファイルの作成を確認できません。");
            CloudFilesNative.Check(entries[0].Result);
        }
        finally {Marshal.FreeHGlobal(memory);}
    }
    public async Task HydrateAsync(string relativePath,CancellationToken token=default)
    {
        ObjectDisposedException.ThrowIf(disposed!=0,this);root.VerifyPresent();
        var path=LocalPaths.ResolveUnderRoot(root.Root,relativePath);
        if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の原本は取得できません。");
        var task=hydrationTasks.GetOrAdd(path,_=>Task.Run(()=>
        {
            using var handle=File.OpenHandle(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete);
            CloudFilesLocalStorage.HydrateAndKeep(handle);
        }));
        try{await task.WaitAsync(token);}
        finally{if(task.IsCompleted)hydrationTasks.TryRemove(new KeyValuePair<string,Task>(path,task));}
    }
    private static CloudFilesNative.OperationInfo Operation(in CloudFilesNative.CallbackInfo info,int type)=>new()
    {StructSize=(uint)Marshal.SizeOf<CloudFilesNative.OperationInfo>(),Type=type,
        ConnectionKey=info.ConnectionKey,TransferKey=info.TransferKey,RequestKey=info.RequestKey};
    private void Fetch(in CloudFilesNative.CallbackInfo info,in CloudFilesNative.CallbackParameters parameters)
    {
        var operation=Operation(info,0);var request=parameters;var size=info.FileSize;
        try
        {
            if(info.FileIdentityLength!=64)throw new InvalidDataException("ファイルの識別情報が不正です。");
            var identity=Marshal.PtrToStringUTF8(info.FileIdentity,64)!;
            if(identity.Any(ch=>!char.IsAsciiHexDigit(ch)))throw new InvalidDataException("ファイルの識別情報が不正です。");
            lock(gate)
            {
                if(disposed!=0)return;
                workers++;finished.Reset();
                _=Task.Run(async()=>
                {
                    try {await Transfer(operation,request,size,identity);}
                    finally {lock(gate){if(--workers==0)finished.Set();}}
                });
            }
        }
        catch(Exception error){Errors.Enqueue(error);Fail(operation,request);}
    }
    private async Task Transfer(CloudFilesNative.OperationInfo operation,CloudFilesNative.CallbackParameters request,long size,string identity)
    {
        using var heartbeat=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        var progress=new DownloadProgress();
        var pulse=ReportProgress(operation,size,progress,heartbeat.Token);
        var acquired=false;
        try
        {
            await downloads.WaitAsync(lifetime.Token);acquired=true;root.VerifyPresent();
            await using var body=await original(identity,progress,lifetime.Token);
            if(!body.CanRead || !body.CanSeek || body.Length!=size)throw new InvalidDataException("取得済み原本のサイズを確認できません。");
            var range=CloudFilesRange.ForVerifiedChunks(size,8*1024*1024,request.RequiredOffset,request.RequiredLength);
            body.Position=range.Offset;var buffer=new byte[(int)Math.Min(8*1024*1024,range.Length)];
            var pin=GCHandle.Alloc(buffer,GCHandleType.Pinned);
            try
            {
                for(long offset=range.Offset;offset<range.Offset+range.Length;offset+=buffer.Length)
                {
                    lifetime.Token.ThrowIfCancellationRequested();root.VerifyPresent();
                    var count=(int)Math.Min(buffer.Length,range.Offset+range.Length-offset);
                    await body.ReadExactlyAsync(buffer.AsMemory(0,count),lifetime.Token);
                    var transfer=new CloudFilesNative.TransferParameters {ParamSize=(uint)Marshal.SizeOf<CloudFilesNative.TransferParameters>(),
                        Buffer=pin.AddrOfPinnedObject(),Offset=offset,Length=count};
                    var result=CloudFilesNative.CfExecute(operation,transfer);
                    if(result==unchecked((int)0x8007018E))return;
                    CloudFilesNative.Check(result);
                }
            }
            finally {pin.Free();CryptographicOperations.ZeroMemory(buffer);}
        }
        catch(OperationCanceledException) {if(disposed==0)Fail(operation,request);}
        catch(Exception error) {if(disposed==0){Errors.Enqueue(error);Fail(operation,request);}}
        finally
        {
            heartbeat.Cancel();await pulse;
            if(acquired)downloads.Release();
        }
    }
    private static async Task ReportProgress(CloudFilesNative.OperationInfo operation,long size,DownloadProgress progress,CancellationToken token)
    {
        // Staging a large original can exceed CFAPI's 60-second FETCH_DATA timeout.
        // Report out-of-band progress until the verified complete stream is ready.
        try
        {
            using var timer=new PeriodicTimer(TimeSpan.FromSeconds(10));
            do { _=CloudFilesNative.CfReportProviderProgress(operation.ConnectionKey,operation.TransferKey,size,Math.Min(size,progress.Completed)); }
            while(await timer.WaitForNextTickAsync(token));
        }
        catch(OperationCanceledException)when(token.IsCancellationRequested) { }
    }
    private sealed class DownloadProgress:IProgress<long>
    {
        private long completed;public long Completed=>Interlocked.Read(ref completed);
        public void Report(long value){if(value>=0)Interlocked.Exchange(ref completed,value);}
    }
    private void Fail(CloudFilesNative.OperationInfo operation,CloudFilesNative.CallbackParameters request)
    {
        _=CloudFilesNative.CfExecute(operation,new CloudFilesNative.TransferParameters {
            ParamSize=(uint)Marshal.SizeOf<CloudFilesNative.TransferParameters>(),CompletionStatus=CloudFilesNative.StatusUnsuccessful,
            Offset=request.RequiredOffset,Length=request.RequiredLength});
    }
    private void Cancel(in CloudFilesNative.CallbackInfo info,in CloudFilesNative.CallbackParameters parameters)
    { /* All originals remain background targets even if a consumer cancels. CfExecute detects a canceled request. */ }
    public IDisposable AllowLocalMutation(string path)
    {
        root.VerifyPresent();var id=WindowsFileState.Read(path).Id;
        localMutations.AddOrUpdate(id,1,(_,n)=>n+1);return new MutationLease(localMutations,id);
    }
    private sealed class MutationLease(ConcurrentDictionary<long,int> values,long id):IDisposable
    {public void Dispose(){values.AddOrUpdate(id,0,(_,n)=>Math.Max(0,n-1));}}
    private bool IsLocalMutation(in CloudFilesNative.CallbackInfo info)=>info.ProcessInfo!=0
        &&Marshal.ReadInt32(info.ProcessInfo,4)==Environment.ProcessId&&localMutations.TryGetValue(info.FileId,out var count)&&count>0;
    private void Delete(in CloudFilesNative.CallbackInfo info,in CloudFilesNative.CallbackParameters parameters)
        =>Acknowledge(info,6,IsLocalMutation(info)?0:CloudFilesNative.StatusAccessDenied);
    private void Rename(in CloudFilesNative.CallbackInfo info,in CloudFilesNative.CallbackParameters parameters)
        =>Acknowledge(info,7,(parameters.Flags&4)!=0||IsLocalMutation(info)?0:CloudFilesNative.StatusAccessDenied);
    private void Acknowledge(in CloudFilesNative.CallbackInfo info,int type,int status)
    {
        try {CloudFilesNative.Check(CloudFilesNative.CfExecute(Operation(info,type),new CloudFilesNative.TransferParameters {ParamSize=16,CompletionStatus=status}));}
        catch(Exception error){if(disposed==0)Errors.Enqueue(error);}
    }
    public void Dispose()
    {
        lock(gate){if(disposed!=0)return;disposed=1;}
        lifetime.Cancel();var key=Interlocked.Exchange(ref connection,0);
        if(key!=0)CloudFilesNative.Check(CloudFilesNative.CfDisconnectSyncRoot(key));
        if(!finished.Wait(TimeSpan.FromSeconds(15)))throw new TimeoutException("同期の終了処理を待っています。");
        downloads.Dispose();finished.Dispose();lifetime.Dispose();
        GC.KeepAlive(fetch);GC.KeepAlive(cancel);GC.KeepAlive(delete);GC.KeepAlive(rename);
        // Registration and all saved bodies deliberately survive process shutdown.
    }
}

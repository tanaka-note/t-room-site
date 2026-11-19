using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

/// <summary>Copies a local save before network upload; concurrent writes invalidate the snapshot.</summary>
public static class LocalOriginalSnapshot
{
    public static async Task<VerifiedOriginal> CaptureAsync(string path,string ownedStagingDirectory,
        IProgress<long>? progress=null,CancellationToken token=default,bool retain=false)
    {
        var source=Path.GetFullPath(path);
        _=VolumeInspector.ValidateDestination(source,[]);
        if(new FileInfo(source).LinkTarget is not null)throw new IOException("リンク経由のファイルは送信しません。");
        // RH protection yields the handle when a foreground opener needs it,
        // instead of surfacing a sharing violation to the saving application.
        var opened=CfOpenFileWithOplock(source,1 /* EXCLUSIVE, read-only */,out var handle);
        SharedReadLease? shared=null;
        if(opened<0) {
            if(opened!=unchecked((int)0x80070020))CloudFilesNative.Check(opened);
            // Office retains compatible read/write handles after Save. A
            // share-all oplock lets it keep working; inspect the kernel's
            // completion state directly rather than waiting for a callback.
            shared=SharedReadLease.Open(source);
        }
        nint Raw()=>shared is null?CfGetWin32HandleFromProtectedHandle(handle):shared.Handle;
        IDisposable Protect()=>shared is null?Reference(handle):shared.Reference();
        try
        {
            using var owned=Protect();
            var raw=Raw();
            var before=WindowsFileState.Read(source);
            if(!GetFileSizeEx(raw,out var size))throw new Win32Exception(Marshal.GetLastWin32Error());
            if(size<1||size>64L*1024*1024*10000)throw new IOException("送信対象のサイズが不正です。");
            owned.Dispose();
            var full=Path.GetFullPath(ownedStagingDirectory);_=VolumeInspector.ValidateDestination(full,[]);Directory.CreateDirectory(full);
            if(new DriveInfo(Path.GetPathRoot(full)!).AvailableFreeSpace<size+16L*1024*1024)
                throw new IOException("送信用の保存領域が不足しています。原本は削除しません。");
            var output=new FileStream(Path.Combine(full,Guid.NewGuid().ToString("N")+".upload"),FileMode.CreateNew,
                FileAccess.ReadWrite,retain?FileShare.Read|FileShare.Delete:FileShare.None,1024*1024,FileOptions.Asynchronous|FileOptions.WriteThrough|(retain?FileOptions.None:FileOptions.DeleteOnClose));
            var buffer=new byte[(int)Math.Min(size,1024*1024)];
            try
            {
                using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                for(long offset=0;offset<size;)
                {
                    token.ThrowIfCancellationRequested();var count=(int)Math.Min(buffer.Length,size-offset);
                    // Reference only one local I/O unit. Never delay an Office
                    // save by retaining an oplock reference during network I/O.
                    using(var current=Protect())
                        await Task.Run(()=>Read(Raw(),offset,buffer,count,token),token);
                    hash.AppendData(buffer,0,count);await output.WriteAsync(buffer.AsMemory(0,count),token);
                    offset+=count;progress?.Report(offset);
                }
                using(var current=Protect())
                    if(!GetFileSizeEx(Raw(),out var after)||after!=size||WindowsFileState.Read(source)!=before)
                        throw new IOException("コピー中に原本が変わりました。");
                await output.FlushAsync(token);output.Flush(flushToDisk:true);output.Position=0;
                return new(output,Convert.ToHexString(hash.GetHashAndReset()),retain?output.Name:null,before.Id,before.Usn);
            }
            catch {await output.DisposeAsync();if(retain)File.Delete(output.Name);throw;}
            finally {CryptographicOperations.ZeroMemory(buffer);}
        }
        finally {if(shared is null)CfCloseHandle(handle);else shared.Dispose();}
    }
    private static ReferenceLease Reference(nint handle)
    {
        if(!CfReferenceProtectedHandle(handle))throw new IOException("保存中の変更を検出しました。保存完了後に再試行します。");
        return new(handle);
    }
    private sealed class ReferenceLease(nint handle):IDisposable
    {private bool disposed;public void Dispose(){if(disposed)return;disposed=true;CfReleaseProtectedHandle(handle);}}
    private sealed class SharedReadLease:IDisposable
    {
        private readonly SafeFileHandle file;
        private readonly ManualResetEvent signal=new(false);
        private readonly nint overlap,input,output;
        private bool pending,disposed;
        public nint Handle=>file.DangerousGetHandle();
        private SharedReadLease(SafeFileHandle file)
        {
            this.file=file;
            overlap=Marshal.AllocHGlobal(Marshal.SizeOf<NativeOverlapped>());
            input=Marshal.AllocHGlobal(12);output=Marshal.AllocHGlobal(24);
            Marshal.Copy(new byte[24],0,output,24);
        }
        public static SharedReadLease Open(string source)
        {
            var file=OpenShared(source,0x80000000,7,0,3,0x48000000,0);
            if(file.IsInvalid){file.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
            var result=new SharedReadLease(file);
            try {
                foreach(var level in new uint[]{5,1}) {
                    result.signal.Reset();
                    Marshal.StructureToPtr(new NativeOverlapped{EventHandle=(nint)((long)result.signal.SafeWaitHandle.DangerousGetHandle()|1L)},result.overlap,false);
                    Marshal.WriteInt16(result.input,0,1);Marshal.WriteInt16(result.input,2,12);
                    Marshal.WriteInt32(result.input,4,(int)level);Marshal.WriteInt32(result.input,8,1);
                    if(!DeviceIoControl(file,0x00090240,result.input,12,result.output,24,out _,result.overlap)) {
                        var error=Marshal.GetLastWin32Error();
                        if(error==997){result.pending=true;result.Check();return result;}
                        if(error!=300)throw new Win32Exception(error);
                    }
                }
                throw new IOException("保存中のファイルを安定して読み取れません。保存完了後に再試行します。");
            }catch{result.Dispose();throw;}
        }
        private void Check()
        {
            Thread.MemoryBarrier();
            if(disposed||!pending||Marshal.ReadIntPtr(overlap)!=(nint)0x103||signal.WaitOne(0))
                throw new IOException("コピー中の変更を検出しました。保存完了後に再試行します。");
        }
        public IDisposable Reference(){Check();return new SharedReference(this);}
        private sealed class SharedReference(SharedReadLease owner):IDisposable
        {private bool disposed;public void Dispose(){if(disposed)return;disposed=true;owner.Check();}}
        public void Dispose()
        {
            if(disposed)return;disposed=true;
            if(pending) {
                CancelIoEx(Handle,overlap);
                GetOverlappedResult(Handle,overlap,out _,true);
            }
            file.Dispose();signal.Dispose();Marshal.FreeHGlobal(overlap);Marshal.FreeHGlobal(input);Marshal.FreeHGlobal(output);
        }
        [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
        private static extern SafeFileHandle OpenShared(string path,uint access,uint share,nint security,uint creation,uint flags,nint template);
        [DllImport("kernel32.dll",SetLastError=true)]
        [return:MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(SafeFileHandle file,uint control,nint input,uint inputSize,nint output,uint outputSize,out uint returned,nint overlapped);
    }
    [DllImport("CldApi.dll",CharSet=CharSet.Unicode)]
    private static extern int CfOpenFileWithOplock(string path,uint flags,out nint handle);
    [DllImport("CldApi.dll")]
    [return:MarshalAs(UnmanagedType.U1)]
    private static extern bool CfReferenceProtectedHandle(nint handle);
    [DllImport("CldApi.dll")]
    private static extern nint CfGetWin32HandleFromProtectedHandle(nint handle);
    [DllImport("CldApi.dll")]
    private static extern void CfReleaseProtectedHandle(nint handle);
    [DllImport("CldApi.dll")]
    private static extern void CfCloseHandle(nint handle);
    private static void Read(nint file,long offset,byte[] bytes,int length,CancellationToken token)
    {
        using var ready=CreateEvent(0,true,false,null);
        if(ready.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        var memory=Marshal.AllocHGlobal(Marshal.SizeOf<Overlapped>());var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);
        try
        {
            // The CFAPI handle already belongs to its own completion port. Set
            // the low event bit so our I/O never delivers an alien OVERLAPPED
            // to that port, and wait for completion before releasing any buffer.
            Marshal.StructureToPtr(new Overlapped {Offset=(uint)offset,OffsetHigh=(uint)((ulong)offset>>32),
                Event=ready.DangerousGetHandle()|1},memory,false);
            token.ThrowIfCancellationRequested();
            if(!ReadFile(file,pin.AddrOfPinnedObject(),(uint)length,0,memory)&&Marshal.GetLastWin32Error()!=997)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            while(WaitForSingleObject(ready,100)==258)
                if(token.IsCancellationRequested)CancelIoEx(file,memory);
            if(!GetOverlappedResult(file,memory,out var count,true))
            {token.ThrowIfCancellationRequested();throw new Win32Exception(Marshal.GetLastWin32Error());}
            token.ThrowIfCancellationRequested();if(count!=length)throw new EndOfStreamException("コピー中に原本が変わりました。");
        }
        finally {pin.Free();Marshal.FreeHGlobal(memory);}
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Overlapped {public nint Internal,InternalHigh;public uint Offset,OffsetHigh;public nint Event;}
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileSizeEx(nint file,out long length);
    [DllImport("kernel32.dll",EntryPoint="CreateEventW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeWaitHandle CreateEvent(nint security,[MarshalAs(UnmanagedType.Bool)]bool manual,[MarshalAs(UnmanagedType.Bool)]bool initial,string? name);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(nint file,nint buffer,uint length,nint count,nint overlapped);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOverlappedResult(nint file,nint overlapped,out uint count,[MarshalAs(UnmanagedType.Bool)]bool wait);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelIoEx(nint file,nint overlapped);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(SafeWaitHandle handle,uint milliseconds);
}

using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

/// <summary>Copies a local save before network upload; concurrent writes invalidate the snapshot.</summary>
public static class LocalOriginalSnapshot
{
    public static async Task<VerifiedOriginal> CaptureAsync(string path,string ownedStagingDirectory,
        IProgress<long>? progress=null,CancellationToken token=default)
    {
        var source=Path.GetFullPath(path);
        _=VolumeInspector.ValidateDestination(source,[]);
        if(new FileInfo(source).LinkTarget is not null)throw new IOException("リンク経由のファイルは送信しません。");
        // RH protection yields the handle when a foreground opener needs it,
        // instead of surfacing a sharing violation to the saving application.
        CloudFilesNative.Check(CfOpenFileWithOplock(source,1 /* EXCLUSIVE, read-only */,out var handle));
        try
        {
            using var owned=Reference(handle);
            var raw=CfGetWin32HandleFromProtectedHandle(handle);
            if(!GetFileSizeEx(raw,out var size))throw new Win32Exception(Marshal.GetLastWin32Error());
            if(size<1||size>64L*1024*1024*10000)throw new IOException("送信対象のサイズが不正です。");
            owned.Dispose();
            var full=Path.GetFullPath(ownedStagingDirectory);_=VolumeInspector.ValidateDestination(full,[]);Directory.CreateDirectory(full);
            if(new DriveInfo(Path.GetPathRoot(full)!).AvailableFreeSpace<size+16L*1024*1024)
                throw new IOException("送信用の保存領域が不足しています。原本は削除しません。");
            var output=new FileStream(Path.Combine(full,Guid.NewGuid().ToString("N")+".upload"),FileMode.CreateNew,
                FileAccess.ReadWrite,FileShare.None,1024*1024,FileOptions.Asynchronous|FileOptions.DeleteOnClose);
            var buffer=new byte[(int)Math.Min(size,1024*1024)];
            try
            {
                using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                for(long offset=0;offset<size;)
                {
                    token.ThrowIfCancellationRequested();var count=(int)Math.Min(buffer.Length,size-offset);
                    // Reference only one local I/O unit. Never delay an Office
                    // save by retaining an oplock reference during network I/O.
                    using(var current=Reference(handle))
                        await Task.Run(()=>Read(CfGetWin32HandleFromProtectedHandle(handle),offset,buffer,count,token),token);
                    hash.AppendData(buffer,0,count);await output.WriteAsync(buffer.AsMemory(0,count),token);
                    offset+=count;progress?.Report(offset);
                }
                using(var current=Reference(handle))
                    if(!GetFileSizeEx(CfGetWin32HandleFromProtectedHandle(handle),out var after)||after!=size)
                        throw new IOException("コピー中に原本が変わりました。");
                await output.FlushAsync(token);output.Flush(flushToDisk:true);output.Position=0;
                return new(output,Convert.ToHexString(hash.GetHashAndReset()));
            }
            catch {await output.DisposeAsync();throw;}
            finally {CryptographicOperations.ZeroMemory(buffer);}
        }
        finally {CfCloseHandle(handle);}
    }
    private static ReferenceLease Reference(nint handle)
    {
        if(!CfReferenceProtectedHandle(handle))throw new IOException("保存中の変更を検出しました。保存完了後に再試行します。");
        return new(handle);
    }
    private sealed class ReferenceLease(nint handle):IDisposable
    {private bool disposed;public void Dispose(){if(disposed)return;disposed=true;CfReleaseProtectedHandle(handle);}}
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

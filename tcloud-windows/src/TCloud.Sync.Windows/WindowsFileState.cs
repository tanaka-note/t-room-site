using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

public sealed record WindowsFileState(long Id,long Usn,long Size,long LastWriteTicks,uint Links,long ChangeTime=0)
{
    public static WindowsFileState Read(string path)
    {
        using var handle=CreateFile(path,0x80,7,0,3,0x02200000,0);
        if(handle.IsInvalid||!GetFileInformationByHandle(handle,out var info))throw new Win32Exception(Marshal.GetLastWin32Error());
        // Never upload an external hard link as if it were an isolated original.
        if(info.Links!=1)throw new IOException("複数のハードリンクがあるファイルは同期しません。");
        long usn=0;var bytes=new byte[4096];
        if(DeviceIoControl(handle,0x000900eb,0,0,bytes,(uint)bytes.Length,out var returned,0)&&returned>=32&&BitConverter.ToUInt16(bytes,4)==2)
            usn=BitConverter.ToInt64(bytes,24);
        if(!GetFileInformationByHandleEx(handle,0,out var basic,40))throw new Win32Exception(Marshal.GetLastWin32Error());
        return new(unchecked((long)(((ulong)info.IndexHigh<<32)|info.IndexLow)),usn,
            checked((long)(((ulong)info.SizeHigh<<32)|info.SizeLow)),unchecked((long)(((ulong)info.WriteHigh<<32)|info.WriteLow)),info.Links,basic.Change);
    }
    // Without an NTFS change number, callers must obtain another stable hash.
    public bool SameSavedBytes(WindowsFileState? other)=>other is not null&&Id==other.Id&&Usn!=0&&Usn==other.Usn&&Size==other.Size&&LastWriteTicks==other.LastWriteTicks;
    [StructLayout(LayoutKind.Sequential)] private struct Info
    {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Serial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [StructLayout(LayoutKind.Sequential)] private struct Basic {public long Creation,Access,Write,Change;public uint Attributes;}
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,nint security,uint creation,uint flags,nint template);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out Basic info,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle file,uint control,nint input,uint inputSize,[Out]byte[] output,uint outputSize,out uint returned,nint overlap);
}

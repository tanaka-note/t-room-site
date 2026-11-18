using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

/// <summary>Persistent registration. Stopping the application never unregisters or removes originals.</summary>
public sealed class CloudFilesRootRegistration
{
    private const string ProviderName="T-Cloud";
    private readonly byte[] identity;
    private readonly VolumeBinding volume;
    public string Root { get; }

    private CloudFilesRootRegistration(string root,VolumeBinding volume,byte[] identity)
    {Root=root;this.volume=volume;this.identity=identity;}

    public static CloudFilesRootRegistration Attach(WindowsDeviceRegistration registration,IEnumerable<string> otherSyncRoots)
    {
        var root=ResolveDestination(registration);
        var actual=VolumeInspector.ValidateDestination(root,otherSyncRoots);
        if(actual!=registration.Volume)throw new IOException("登録時と異なる保存先です。");
        var identity=SHA256.HashData(Encoding.UTF8.GetBytes("TCloud.Windows.Root.v1\n"+registration.ScopeHash+"\n"
            +actual.GuidPath.ToUpperInvariant()+"\n"+actual.SerialNumber.ToString(CultureInfo.InvariantCulture)+"\n"+actual.RelativeRoot.ToUpperInvariant()));
        var result=new CloudFilesRootRegistration(root,actual,identity);
        Directory.CreateDirectory(root);
        var existing=ReadInfo(root);
        if(existing is not null)
        {
            result.ValidateOwner(existing);return result;
        }
        if(Directory.EnumerateFileSystemEntries(root).Any())throw new IOException("初回は空のT-Cloud専用フォルダを選択してください。既存ファイルは変更しません。");
        var memory=Marshal.AllocHGlobal(identity.Length);
        try
        {
            Marshal.Copy(identity,0,memory,identity.Length);
            var native=new CloudFilesNative.Registration {StructSize=(uint)Marshal.SizeOf<CloudFilesNative.Registration>(),
                ProviderName=ProviderName,ProviderVersion="0.1.0",ProviderId=new("c8a5eaf6-5f6a-4582-a79a-a684de208c48"),
                SyncRootIdentity=memory,SyncRootIdentityLength=(uint)identity.Length};
            var policies=new CloudFilesNative.Policies {StructSize=(uint)Marshal.SizeOf<CloudFilesNative.Policies>(),
                Hydration=new(){Primary=2},Population=new(){Primary=3}};
            CloudFilesNative.Check(CloudFilesNative.CfRegisterSyncRoot(root,native,policies,0));
        }
        finally {Marshal.FreeHGlobal(memory);}
        result.ValidateOwner(ReadInfo(root)??throw new IOException("同期フォルダの登録を確認できません。"));return result;
    }

    public void VerifyPresent()
    {
        if(!VolumeInspector.IsExpectedVolumePresent(Root,volume))throw new IOException("登録した保存先が接続されていません。");
        VolumeInspector.ValidateDestination(Root,[]);
    }
    // Only an explicit local unlink/uninstall uses this. It leaves every body in place.
    public void UnregisterPreservingOriginals()
    {
        VerifyPresent();ValidateOwner(ReadInfo(Root)??throw new IOException("同期登録を確認できません。"));
        CloudFilesNative.Check(CloudFilesNative.CfUnregisterSyncRoot(Root));
    }
    public static string ResolveDestination(WindowsDeviceRegistration registration)
    {
        if(VolumeInspector.IsExpectedVolumePresent(registration.Destination,registration.Volume))return Path.GetFullPath(registration.Destination);
        foreach(var drive in DriveInfo.GetDrives().Where(d=>d.DriveType==DriveType.Fixed))
        {
            try
            {
                var candidate=Path.Combine(drive.RootDirectory.FullName,registration.Volume.RelativeRoot);
                if(VolumeInspector.IsExpectedVolumePresent(candidate,registration.Volume))return candidate;
            }
            catch(Exception error)when(error is IOException or Win32Exception or UnauthorizedAccessException) { }
        }
        throw new IOException("登録した保存先の接続を待っています。");
    }
    private void ValidateOwner(RootInfo info)
    {
        if(info.FileId!=DirectoryFileId(Root) || info.Provider!=ProviderName || !info.Identity.AsSpan().SequenceEqual(identity)
            || info.HydrationPrimary!=2 || info.HydrationModifier!=0 || info.PopulationPrimary!=3)
            throw new IOException("別の同期サービス・登録範囲と重なる保存先は使用できません。");
    }
    private sealed record RootInfo(long FileId,string Provider,ushort HydrationPrimary,ushort HydrationModifier,ushort PopulationPrimary,byte[] Identity);
    private static RootInfo? ReadInfo(string root)
    {
        const int capacity=4096;var memory=Marshal.AllocHGlobal(capacity);
        try
        {
            var result=CloudFilesNative.CfGetSyncRootInfoByPath(root,1 /* STANDARD */,memory,capacity,out var returned);
            if(result is unchecked((int)0x80070186) or unchecked((int)0x80070195) or unchecked((int)0x80070178))return null;
            CloudFilesNative.Check(result);
            // Win64 STANDARD: 8-byte file ID, policies/status (20), two WCHAR[256], length, identity.
            if(returned<1056 || returned>capacity)throw new InvalidDataException("同期登録の応答長が不正です。");
            var length=Marshal.ReadInt32(memory,1052);
            if(length<0 || length>returned-1056)throw new InvalidDataException("同期登録の識別情報が不正です。");
            var bytes=new byte[length];Marshal.Copy(memory+1056,bytes,0,length);
            var provider=Marshal.PtrToStringUni(memory+28,256)!.Split('\0')[0];
            return new(Marshal.ReadInt64(memory),provider,(ushort)Marshal.ReadInt16(memory,8),(ushort)Marshal.ReadInt16(memory,10),
                (ushort)Marshal.ReadInt16(memory,12),bytes);
        }
        finally {Marshal.FreeHGlobal(memory);}
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfoNative
    {
        public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
        public uint Serial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    private static long DirectoryFileId(string root)
    {
        using var handle=CreateFile(root,0x80,7,0,3,0x02200000,0);
        if(handle.IsInvalid || !GetFileInformationByHandle(handle,out var value))throw new Win32Exception(Marshal.GetLastWin32Error());
        return unchecked((long)(((ulong)value.IndexHigh<<32)|value.IndexLow));
    }
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,nint security,uint creation,uint flags,nint template);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfoNative info);
}

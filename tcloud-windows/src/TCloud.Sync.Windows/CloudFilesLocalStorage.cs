using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;

namespace TCloud.Sync.Windows;

/// <summary>Retains the complete original. Success from pinning alone is not download completion.</summary>
public static class CloudFilesLocalStorage
{
    public static uint PlaceholderState(string path)
    {
        using var handle=CreateFile(path,0x80,7,0,3,0x02200000,0);
        if(handle.IsInvalid||!GetFileInformationByHandleEx(handle,9,out var attributes,8))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return CfGetPlaceholderStateFromAttributeTag(attributes.Attributes,attributes.Tag);
    }
    public static void ConvertSavedBody(string path,string identity)
    {
        if(string.IsNullOrEmpty(identity)||identity.Length>4096)throw new ArgumentException("原本の識別情報が不正です。",nameof(identity));
        // This only adds metadata and retention to the existing saved body.
        // It never dehydrates, rewrites data, or declares the local edit uploaded.
        var bytes=Encoding.UTF8.GetBytes(identity);
        using var handle=File.OpenHandle(path,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete);
        CloudFilesNative.Check(CloudFilesNative.CfConvertToPlaceholder(handle,bytes,(uint)bytes.Length,8 /* ALWAYS_FULL */,out _,0));
        CloudFilesNative.Check(CloudFilesNative.CfSetPinState(handle,1,0,0));
    }
    // Called by the background download worker with a handle to its validated destination.
    // Both calls are synchronous; do not call this method on the UI/native callback thread.
    public static void HydrateAndKeep(SafeFileHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        if (handle.IsInvalid || handle.IsClosed) throw new ArgumentException("保存先のファイルが開かれていません。", nameof(handle));
        CloudFilesNative.Check(CloudFilesNative.CfSetPinState(handle, 1 /* PINNED */, 0, 0));
        CloudFilesNative.Check(CloudFilesNative.CfHydratePlaceholder(handle, 0, -1 /* CF_EOF */, 0, 0));
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTag {public uint Attributes,Tag;}
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,nint security,uint creation,uint flags,nint template);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int infoClass,out AttributeTag info,uint size);
    [DllImport("CldApi.dll")]
    private static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes,uint tag);
}

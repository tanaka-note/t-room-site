using TCloud.Sync.Core;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

internal sealed record WindowsRecoveryRecord(string OriginalRelativePath,string Reason,DateTimeOffset SavedAt,string? Sha256=null);

internal static class WindowsRecovery
{
    public static string DirectoryFor(string staging)=>Path.Combine(staging,"Recovery");
    // Save the identifying information BEFORE removing the original path.
    public static async Task<string> PlanAsync(string staging,string original,string reason,CancellationToken token)
    {
        var directory=DirectoryFor(staging);_=VolumeInspector.ValidateDestination(directory,[]);Directory.CreateDirectory(directory);
        var name=Path.GetFileName(original);var extension=Path.GetExtension(name);if(extension.Length>24)extension=".bin";
        var stem=Path.GetFileNameWithoutExtension(name);if(stem.Length>150)stem=stem[..150];
        var target=LocalPaths.ResolveUnderRoot(directory,stem+" (保全 "+DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N")[..8]+")"+extension);
        await WindowsAtomicState.SaveAsync(target+".json",new WindowsRecoveryRecord(original,reason,DateTimeOffset.UtcNow),token);
        return target;
    }
    public static async Task RetainAsync(string staging,string source,string original,string reason,CancellationToken token)
    {
        if(!File.Exists(source))return;
        var target=await PlanAsync(staging,original,reason,token);WindowsAtomicState.Check(source);File.Move(source,target);
    }
    public static Task<bool> DeleteIfUnchangedAsync(string path,string? expectedHash,Action verify,CancellationToken token)=>Task.Run(()=>{
        if(expectedHash is null)return false;verify();WindowsAtomicState.Check(path);
        // Share-none + DELETE holds the decision through the hash and deletion.
        // An Office handle that might save again prevents this cleanup.
        using var handle=Open(path,0x80010080,0,0,3,0x08000000,0);
        if(handle.IsInvalid)return false;
        using var stream=new FileStream(handle,FileAccess.Read,1024*1024,isAsync:false);
        token.ThrowIfCancellationRequested();var actual=Convert.ToHexString(SHA256.HashData(stream));token.ThrowIfCancellationRequested();
        if(!actual.Equals(expectedHash,StringComparison.OrdinalIgnoreCase))return false;
        verify();var disposition=new Disposition{Delete=1};return SetFileInformationByHandle(handle,4,ref disposition,1);
    },token);
    [StructLayout(LayoutKind.Sequential)] private struct Disposition {public byte Delete;}
    [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle Open(string path,uint access,uint share,nint security,uint creation,uint flags,nint template);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,ref Disposition info,uint size);
}

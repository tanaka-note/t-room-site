using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Tlain.Downloader2.Host;

internal sealed class CredentialStore
{
    private const string Target = "Tlain.Downloader2.DeviceCredential";
    private const uint CredTypeGeneric = 1;
    private const uint PersistLocalMachine = 2;

    public bool Exists() => TryRead() is not null;

    public (string DeviceId, byte[] Key) GetOrCreate()
    {
        var existing = TryRead();
        if (existing is not null) return (DeviceId(existing), existing);
        var key = RandomNumberGenerator.GetBytes(32);
        Write(key);
        return (DeviceId(key), key);
    }

    public string? DeviceIdOrNull() => TryRead() is { } key ? DeviceId(key) : null;

    private static string DeviceId(byte[] key) => Convert.ToHexString(SHA256.HashData(key)).ToLowerInvariant()[..24];

    private static byte[]? TryRead()
    {
        if (!OperatingSystem.IsWindows() || !CredRead(Target, CredTypeGeneric, 0, out var pointer)) return null;
        try
        {
            var credential = Marshal.PtrToStructure<CREDENTIAL>(pointer);
            if (credential.CredentialBlobSize != 32 || credential.CredentialBlob == IntPtr.Zero) return null;
            var result = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, result, 0, result.Length);
            return result;
        }
        finally { CredFree(pointer); }
    }

    private static void Write(byte[] key)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows Credential Managerが必要です。");
        var blob = Marshal.AllocCoTaskMem(key.Length);
        try
        {
            Marshal.Copy(key, 0, blob, key.Length);
            var credential = new CREDENTIAL
            {
                Type = CredTypeGeneric, TargetName = Target, CredentialBlobSize = (uint)key.Length,
                CredentialBlob = blob, Persist = PersistLocalMachine, UserName = Environment.UserName,
                Comment = "T-lain Downloader 2 device credential"
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "端末credentialをWindows Credential Managerへ保存できませんでした。");
        }
        finally { Marshal.FreeCoTaskMem(blob); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public uint Flags; public uint Type; public string TargetName; public string? Comment; public long LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount;
        public IntPtr Attributes; public string? TargetAlias; public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr buffer);
}

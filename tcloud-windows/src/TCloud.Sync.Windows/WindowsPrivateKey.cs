using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

/// <summary>User-scoped, decrypt-only RSA key import. Session authorization remains the caller's responsibility.</summary>
public static class WindowsPrivateKey
{
    private const string Prefix = "TCloud.Session.";
    private const uint Silent = 0x40;
    private const uint DoNotFinalize = 0x400;

    public static void Import(string keyId, byte[] pkcs8)
    {
        var name = KeyName(keyId);
        using var gate = Acquire(name);
        try
        {
            if (CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent))
                throw new CryptographicException("同じセッションの端末鍵は既に保存されています。置き換えません。");
            ImportNew(name, pkcs8);
        }
        finally { gate.ReleaseMutex(); }
    }

    private static void ImportNew(string name, byte[] pkcs8)
    {
        ArgumentNullException.ThrowIfNull(pkcs8);
        if (pkcs8.Length is < 256 or > 16384) throw new CryptographicException("秘密鍵の形式が不正です。");
        // NCrypt's byte[] P/Invoke pins the input. No unmanaged copy of the private blob is created here.
        Check(Native.NCryptOpenStorageProvider(out var provider, CngProvider.MicrosoftSoftwareKeyStorageProvider.Provider, 0));
        using (provider)
        {
            var nameBytes = Encoding.Unicode.GetBytes(name + '\0');
            var namePin = GCHandle.Alloc(nameBytes, GCHandleType.Pinned);
            var bufferMemory = Marshal.AllocHGlobal(Marshal.SizeOf<Native.Buffer>());
            try
            {
                var buffer = new Native.Buffer { Size = (uint)nameBytes.Length, Type = 45, Data = namePin.AddrOfPinnedObject() };
                Marshal.StructureToPtr(buffer, bufferMemory, false);
                var parameters = new Native.BufferDescriptor { Count = 1, Buffers = bufferMemory };
                Check(Native.NCryptImportKey(provider, 0, "PKCS8_PRIVATEKEY", ref parameters,
                    out var key, pkcs8, (uint)pkcs8.Length, DoNotFinalize | Silent));
                using (key)
                {
                    var finalized = false;
                    try
                    {
                        // No overwrite, machine-key, legacy-store or export permission flags.
                        Check(Native.NCryptSetProperty(key, "Export Policy", BitConverter.GetBytes(0), 4, 0));
                        Check(Native.NCryptSetProperty(key, "Key Usage", BitConverter.GetBytes(1), 4, 0));
                        Check(Native.NCryptFinalizeKey(key, Silent));
                        finalized = true;
                        using var imported = CngKey.Open(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent);
                        Validate(imported);
                    }
                    catch
                    {
                        // Only our newly imported key is eligible for cleanup; an existing key is never overwritten.
                        if (finalized) Check(Native.NCryptDeleteKey(key, Silent));
                        throw;
                    }
                }
            }
            finally { Marshal.FreeHGlobal(bufferMemory); namePin.Free(); }
        }
    }

    public static RSACng Open(string keyId)
    {
        using var key = CngKey.Open(KeyName(keyId), CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent);
        Validate(key);
        return new RSACng(key);
    }

    public static void Delete(string keyId)
    {
        var name = KeyName(keyId);
        using var gate = Acquire(name);
        try
        {
            using var key = CngKey.Open(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent);
            key.Delete();
        }
        finally { gate.ReleaseMutex(); }
    }

    private static string KeyName(string id) => id is not null && id.Length == 64 && id.All(char.IsAsciiHexDigit)
        ? Prefix + id.ToLowerInvariant() : throw new ArgumentException("端末鍵の識別情報が不正です。", nameof(id));

    private static Mutex Acquire(string name)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new CryptographicException("Windowsアカウントを確認できません。");
        var scope = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid + "\0" + name)));
        var gate = new Mutex(false, "Global\\TCloud.SessionKey." + scope);
        try
        {
            if (!gate.WaitOne(TimeSpan.FromSeconds(5))) throw new IOException("端末鍵の処理が完了していません。");
            return gate;
        }
        catch (AbandonedMutexException)
        {
            gate.ReleaseMutex();
            gate.Dispose();
            throw new CryptographicException("前回の端末鍵処理が中断されました。状態の再確認が必要です。");
        }
        catch { gate.Dispose(); throw; }
    }

    private static void Validate(CngKey key)
    {
        if (key.IsEphemeral || key.IsMachineKey || key.AlgorithmGroup != CngAlgorithmGroup.Rsa
            || key.ExportPolicy != CngExportPolicies.None || key.KeyUsage != CngKeyUsages.Decryption)
            throw new CryptographicException("端末鍵の保護設定が一致しません。");
    }

    private static void Check(int status) { if (status != 0) throw new CryptographicException(status); }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct Buffer { public uint Size; public uint Type; public nint Data; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct BufferDescriptor { public uint Version; public uint Count; public nint Buffers; }
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        internal static extern int NCryptOpenStorageProvider(out SafeNCryptProviderHandle provider, string name, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        internal static extern int NCryptImportKey(SafeNCryptProviderHandle provider, nint importKey, string blobType,
            ref BufferDescriptor parameters, out SafeNCryptKeyHandle key, byte[] data, uint size, uint flags);
        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        internal static extern int NCryptSetProperty(SafeNCryptKeyHandle key, string name, byte[] data, uint size, uint flags);
        [DllImport("ncrypt.dll")]
        internal static extern int NCryptFinalizeKey(SafeNCryptKeyHandle key, uint flags);
        [DllImport("ncrypt.dll")]
        internal static extern int NCryptDeleteKey(SafeNCryptKeyHandle key, uint flags);
    }
}

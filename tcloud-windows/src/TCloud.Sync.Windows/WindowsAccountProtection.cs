using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace TCloud.Sync.Windows;

/// <summary>DPAPI CurrentUser protection for cookie bytes. This does not validate or extend a server session.</summary>
public static class WindowsAccountProtection
{
    private const int MaxBytes = 64 * 1024;

    public static byte[] Protect(ReadOnlySpan<byte> plaintext, ReadOnlySpan<byte> sessionBinding) => Transform(plaintext, sessionBinding, true);
    public static byte[] Unprotect(ReadOnlySpan<byte> ciphertext, ReadOnlySpan<byte> sessionBinding) => Transform(ciphertext, sessionBinding, false);

    private static byte[] Transform(ReadOnlySpan<byte> value, ReadOnlySpan<byte> binding, bool protect)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (value.Length is 0 or > MaxBytes || binding.Length != 32)
            throw new ArgumentException("保護データまたはセッション識別情報が不正です。");
        var input = value.ToArray();
        var purpose = Encoding.UTF8.GetBytes("TCloud.Windows.Session.Cookie.v1");
        var entropy = new byte[purpose.Length + binding.Length];
        purpose.CopyTo(entropy, 0);
        binding.CopyTo(entropy.AsSpan(purpose.Length));
        var inputPin = GCHandle.Alloc(input, GCHandleType.Pinned);
        var entropyPin = GCHandle.Alloc(entropy, GCHandleType.Pinned);
        Native.Blob output = default;
        try
        {
            var inputBlob = new Native.Blob { Size = input.Length, Data = inputPin.AddrOfPinnedObject() };
            var entropyBlob = new Native.Blob { Size = entropy.Length, Data = entropyPin.AddrOfPinnedObject() };
            // UI_FORBIDDEN only; LOCAL_MACHINE is deliberately absent.
            var success = protect
                ? Native.CryptProtectData(inputBlob, null, entropyBlob, 0, 0, 1, out output)
                : Native.CryptUnprotectData(inputBlob, 0, entropyBlob, 0, 0, 1, out output);
            if (!success) throw new CryptographicException("Windowsアカウントの保護データを使用できません。",
                new Win32Exception(Marshal.GetLastWin32Error()));
            if (output.Size is <= 0 or > MaxBytes || output.Data == 0)
                throw new CryptographicException("Windowsの保護応答が不正です。");
            var result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        finally
        {
            if (output.Data != 0)
            {
                if (!protect && output.Size is > 0 and <= MaxBytes)
                    Marshal.Copy(new byte[output.Size], 0, output.Data, output.Size);
                _ = Native.LocalFree(output.Data);
            }
            inputPin.Free(); entropyPin.Free();
            CryptographicOperations.ZeroMemory(input);
        }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct Blob { public int Size; public nint Data; }
        [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CryptProtectData(in Blob input, string? description, in Blob entropy,
            nint reserved, nint prompt, uint flags, out Blob output);
        [DllImport("crypt32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CryptUnprotectData(in Blob input, nint description, in Blob entropy,
            nint reserved, nint prompt, uint flags, out Blob output);
        [DllImport("kernel32.dll")]
        internal static extern nint LocalFree(nint memory);
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record WindowsDeviceRegistration(int Version, string DeviceId, string ScopeHash,
    string SigningKeyId, string DataKeyId, string Destination, VolumeBinding Volume, long? RootFileId = null);

/// <summary>PC-only DPAPI record. Contains no bearer token, Cookie or exported private key.</summary>
public sealed class WindowsDeviceRegistrationFile
{
    private readonly string path;
    public WindowsDeviceRegistrationFile(string path) { this.path = Path.GetFullPath(path); }
    public static WindowsDeviceRegistrationFile ForCurrentUser() => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TCloud", "Windows", "device.dat"));
    public bool Exists => File.Exists(path);

    public void Save(WindowsDeviceRegistration value)
    {
        Validate(value);
        CheckPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        CheckPath();
        var plain = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            var ciphertext = WindowsAccountProtection.ProtectDeviceRecord(plain, Binding());
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                { stream.Write(ciphertext); stream.Flush(flushToDisk: true); }
                CheckPath();
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path, overwrite: false);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    public WindowsDeviceRegistration Load()
    {
        CheckPath();
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is <= 0 or > 16384) throw new InvalidDataException("端末登録情報の形式が不正です。");
        var ciphertext = new byte[stream.Length]; stream.ReadExactly(ciphertext);
        var plain = WindowsAccountProtection.UnprotectDeviceRecord(ciphertext, Binding());
        try
        {
            var value = JsonSerializer.Deserialize<WindowsDeviceRegistration>(plain)
                ?? throw new InvalidDataException("端末登録情報を読み取れません。");
            Validate(value); return value;
        }
        finally { CryptographicOperations.ZeroMemory(plain); }
    }

    private byte[] Binding() => SHA256.HashData(Encoding.UTF8.GetBytes("TCloud.Windows.DeviceRecord.v1|" + path.ToUpperInvariant()));
    private static void Validate(WindowsDeviceRegistration value)
    {
        static bool Hex(string text, int length) => text.Length == length && text.All(char.IsAsciiHexDigit);
        if (value.Version != 1 || !Guid.TryParseExact(value.DeviceId, "N", out _) || !Hex(value.ScopeHash,64)
            || !Hex(value.SigningKeyId,64) || !Hex(value.DataKeyId,64) || value.SigningKeyId == value.DataKeyId
            || value.RootFileId==0 || !Path.IsPathFullyQualified(value.Destination) || string.IsNullOrWhiteSpace(value.Volume.GuidPath)
            || Path.IsPathRooted(value.Volume.RelativeRoot) || value.Volume.RelativeRoot.Split('\\','/').Any(part => part is "" or "." or ".."))
            throw new InvalidDataException("端末登録情報の形式が不正です。");
    }
    private void CheckPath()
    {
        if (new FileInfo(path).LinkTarget is not null) throw new IOException("リンク経由の登録情報は使用できません。");
        for (var directory = Directory.GetParent(path); directory is not null; directory = directory.Parent)
            if (directory.Exists && directory.LinkTarget is not null) throw new IOException("リンク経由の登録情報は使用できません。");
    }
}

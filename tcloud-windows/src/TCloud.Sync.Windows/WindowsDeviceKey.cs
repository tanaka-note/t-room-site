using System.Globalization;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public sealed record WindowsDeviceChallenge(string DeviceId, string ChallengeId, string Nonce, string ScopeHash, long ExpiresAt);

/// <summary>Dedicated user-scoped signing key. Never signs with the T-Cloud data decryption key.</summary>
public static class WindowsDeviceKey
{
    private const string Prefix = "TCloud.Windows.Device.";

    public static void Create(string keyId)
    {
        var name = KeyName(keyId);
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User?.Value ?? throw new CryptographicException("Windowsアカウントを確認できません。");
        var mutexId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid + "|" + name)));
        using var gate = new Mutex(false, "Global\\TCloud.DeviceKey." + mutexId);
        try { if (!gate.WaitOne(TimeSpan.FromSeconds(5))) throw new IOException("端末鍵の準備を待っています。"); }
        catch (AbandonedMutexException) { }
        try
        {
            if (CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent))
                throw new CryptographicException("登録済みの端末鍵を上書きしません。");
            using var key = CngKey.Create(CngAlgorithm.ECDsaP256, name, new CngKeyCreationParameters
            {
                Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
                ExportPolicy = CngExportPolicies.None, KeyUsage = CngKeyUsages.Signing,
                KeyCreationOptions = CngKeyCreationOptions.None
            });
            try { Validate(key); }
            catch { key.Delete(); throw; }
        }
        finally { gate.ReleaseMutex(); }
    }

    public static ECDsaCng Open(string keyId)
    {
        using var key = CngKey.Open(KeyName(keyId), CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent);
        Validate(key);
        return new ECDsaCng(key);
    }

    public static JsonElement PublicKey(string keyId)
    {
        using var key = Open(keyId);
        var parameters = key.ExportParameters(false);
        return JsonSerializer.SerializeToElement(new { kty = "EC", crv = "P-256", x = Encode(parameters.Q.X!), y = Encode(parameters.Q.Y!) });
    }

    public static byte[] SignChallenge(string keyId, WindowsDeviceChallenge challenge, DateTimeOffset now)
    {
        var message = ChallengeMessage(challenge, now);
        using var key = Open(keyId);
        return key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    public static byte[] ChallengeMessage(WindowsDeviceChallenge challenge, DateTimeOffset now)
    {
        if (!Guid.TryParseExact(challenge.DeviceId, "N", out _) || !Guid.TryParseExact(challenge.ChallengeId, "N", out _)
            || challenge.ScopeHash.Length != 64 || challenge.ScopeHash.Any(ch => !char.IsAsciiHexDigit(ch))
            || challenge.ExpiresAt <= now.ToUnixTimeSeconds() || challenge.ExpiresAt > now.ToUnixTimeSeconds() + 300)
            throw new CryptographicException("端末認可の確認情報が不正、または期限切れです。");
        _ = WindowsPasskey.Decode(challenge.Nonce, 32, 32);
        return Encoding.UTF8.GetBytes("T-ROOM Cloud Storage Windows device authorization v1\n"
            + WindowsPasskey.Origin + "/cloud/\n" + challenge.DeviceId + "\n" + challenge.ChallengeId + "\n"
            + challenge.Nonce + "\n" + challenge.ScopeHash + "\n" + challenge.ExpiresAt.ToString(CultureInfo.InvariantCulture));
    }

    public static void Delete(string keyId)
    {
        var name = KeyName(keyId);
        if (!CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent)) return;
        using var key = CngKey.Open(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.Silent);
        Validate(key);
        key.Delete();
    }

    private static string KeyName(string keyId)
    {
        if (keyId.Length != 64 || keyId.Any(ch => !char.IsAsciiHexDigit(ch))) throw new ArgumentException("端末鍵の識別情報が不正です。");
        return Prefix + keyId.ToLowerInvariant();
    }

    private static void Validate(CngKey key)
    {
        if (key.IsEphemeral || key.IsMachineKey || key.Algorithm != CngAlgorithm.ECDsaP256
            || key.ExportPolicy != CngExportPolicies.None || key.KeyUsage != CngKeyUsages.Signing)
            throw new CryptographicException("端末鍵の保護設定が一致しません。");
    }
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

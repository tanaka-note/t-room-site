using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public static class PasskeyEnvelope
{
    /// <summary>The caller uses its isolated, redirect-disabled client for the verified Cloud session.</summary>
    public static async Task<JsonElement> LoadAdministratorPublicKeyAsync(HttpClient client, CancellationToken cancellationToken = default)
    {
        if (!client.DefaultRequestHeaders.TryGetValues("X-TCloud-Session", out var contexts)
            || contexts.Count() != 1 || string.IsNullOrWhiteSpace(contexts.Single()))
            throw new CryptographicException("T-Cloudのセッションを確認してから管理者公開鍵を取得してください。");
        using var response = await client.GetAsync(new Uri(WindowsPasskey.Origin + "/cloud/api/crypto-config"), cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException("管理者公開鍵を取得できませんでした。", null, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        var config = document.RootElement;
        if (config.ValueKind != JsonValueKind.Object
            || !config.TryGetProperty("initialized", out var initialized) || initialized.ValueKind != JsonValueKind.True
            || !config.TryGetProperty("cryptoVersion", out var version) || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var number) || number != 1
            || !config.TryGetProperty("publicKeyJwk", out var publicKey))
            throw new CryptographicException("T-Cloudの暗号化設定を確認できません。");
        ValidatePublicKey(publicKey);
        return publicKey.Clone();
    }

    /// <summary>Decrypt an existing PRF envelope entirely on this device. Does not generate or replace a service key.</summary>
    public static void Import(string keyId, ReadOnlySpan<byte> verifiedPrf, JsonElement envelope, bool administrator,
        JsonElement? administratorPublicKey = null)
    {
        if (verifiedPrf.Length != 32) throw new CryptographicException("パスキーの復号結果が不正です。");
        var context = administrator ? "T-ROOM Cloud Storage passkey admin private key v1"
            : "T-ROOM Cloud Storage passkey client private key v1";
        var ciphertext = WindowsPasskey.Decode(envelope.GetProperty("encryptedPayload").GetString() ?? "", 17, 16384);
        var iv = WindowsPasskey.Decode(envelope.GetProperty("payloadIv").GetString() ?? "", 12, 12);
        // The current admin envelope intentionally has no public key. Its authority is Cloud crypto-config.
        // Member envelopes retain their credential-specific public key; do not substitute the admin key there.
        var publicKey = administrator
            ? administratorPublicKey ?? throw new CryptographicException("管理者公開鍵を取得できていません。")
            : envelope.GetProperty("publicKeyJwk");
        if (!administrator && administratorPublicKey.HasValue)
            throw new CryptographicException("管理者公開鍵を通常利用の鍵へ流用できません。");
        ValidatePublicKey(publicKey);
        var modulus = WindowsPasskey.Decode(publicKey.GetProperty("n").GetString() ?? "", 256, 1024);
        var exponent = WindowsPasskey.Decode(publicKey.GetProperty("e").GetString() ?? "", 1, 8);
        var info = Encoding.UTF8.GetBytes(context);
        var salt = SHA256.HashData(Encoding.UTF8.GetBytes(context + "|salt"));
        var wrappingKey = new byte[32];
        var plaintext = new byte[ciphertext.Length - 16];
        var imported = false;
        try
        {
            HKDF.DeriveKey(HashAlgorithmName.SHA256, verifiedPrf, wrappingKey, salt, info);
            using (var aes = new AesGcm(wrappingKey, 16))
                aes.Decrypt(iv, ciphertext.AsSpan(0, plaintext.Length), ciphertext.AsSpan(plaintext.Length), plaintext, info);
            WindowsPrivateKey.Import(keyId, plaintext);
            imported = true;
            using var key = WindowsPrivateKey.Open(keyId);
            var actual = key.ExportParameters(false);
            if (actual.Modulus is null || actual.Exponent is null || !actual.Modulus.AsSpan().SequenceEqual(modulus)
                || !actual.Exponent.AsSpan().SequenceEqual(exponent))
                throw new CryptographicException("復号した秘密鍵と公開鍵が一致しません。");
        }
        catch
        {
            if (imported) WindowsPrivateKey.Delete(keyId);
            throw;
        }
        finally { CryptographicOperations.ZeroMemory(wrappingKey); CryptographicOperations.ZeroMemory(plaintext); }
    }

    private static void ValidatePublicKey(JsonElement publicKey)
    {
        if (publicKey.ValueKind != JsonValueKind.Object
            || !publicKey.TryGetProperty("kty", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "RSA"
            || !publicKey.TryGetProperty("n", out var modulus) || modulus.ValueKind != JsonValueKind.String
            || !publicKey.TryGetProperty("e", out var exponent) || exponent.ValueKind != JsonValueKind.String)
            throw new CryptographicException("公開鍵の形式が不正です。");
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TCloud.Sync.Core;

public sealed record CloudFileMetadata(string Name, string MimeType, string MediaKind, long LastModified)
{
    // Preserve existing duration/container and future metadata during a rename.
    [JsonExtensionData] public Dictionary<string,JsonElement>? Extra {get;init;}
}
public sealed record CloudCipherEnvelope(string Ciphertext, string Iv);

/// <summary>The existing Web vault format. Unwrapped byte-array keys belong to the caller and must be cleared.</summary>
public static class CloudFileCrypto
{
    private const string FileKeyContext = "T-ROOM Cloud Storage file key v1";
    private const string FileMetadataContext = "T-ROOM Cloud Storage file metadata v1";
    private const string ChildKeyContext = "T-ROOM Cloud Storage child folder key v1";
    private const string FolderNameContext = "T-ROOM Cloud Storage folder name v1";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static byte[] UnlockFolder(RSA privateKey, string adminWrappedKey)
    {
        var raw = privateKey.Decrypt(Decode(adminWrappedKey, 128, 2048), RSAEncryptionPadding.OaepSHA256);
        if (raw.Length == 32) return raw;
        CryptographicOperations.ZeroMemory(raw);
        throw new CryptographicException("フォルダ鍵の形式が不正です。");
    }

    public static byte[] UnlockChildFolder(ReadOnlySpan<byte> parentKey, CloudCipherEnvelope envelope)
        => Decrypt(parentKey, envelope, ChildKeyContext, 32, 32);

    public static byte[] UnlockFile(ReadOnlySpan<byte> folderKey, CloudCipherEnvelope envelope)
        => Decrypt(folderKey, envelope, FileKeyContext, 32, 32);

    public static CloudCipherEnvelope WrapFile(ReadOnlySpan<byte> folderKey, ReadOnlySpan<byte> fileKey)
    {
        ValidateKey(fileKey);
        return Encrypt(folderKey, fileKey, FileKeyContext);
    }
    public static CloudCipherEnvelope WrapChildFolder(ReadOnlySpan<byte> parentKey,ReadOnlySpan<byte> childKey)
    {ValidateKey(childKey);return Encrypt(parentKey,childKey,ChildKeyContext);}
    public static CloudCipherEnvelope EncryptFolderName(ReadOnlySpan<byte> folderKey,string name)
    {ValidateName(name);return Encrypt(folderKey,StrictUtf8.GetBytes(name),FolderNameContext);}

    public static string DecryptFolderName(ReadOnlySpan<byte> folderKey, CloudCipherEnvelope envelope)
    {
        var bytes = Decrypt(folderKey, envelope, FolderNameContext, 1, 4096);
        try
        {
            var name = StrictUtf8.GetString(bytes);
            ValidateName(name);
            return name;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    public static CloudFileMetadata DecryptMetadata(ReadOnlySpan<byte> fileKey, CloudCipherEnvelope envelope)
    {
        var bytes = Decrypt(fileKey, envelope, FileMetadataContext, 2, 16384);
        try
        {
            var metadata = JsonSerializer.Deserialize<CloudFileMetadata>(bytes, JsonOptions)
                ?? throw new CryptographicException("ファイル情報の形式が不正です。");
            metadata = metadata with
            {
                MimeType = string.IsNullOrWhiteSpace(metadata.MimeType) ? "application/octet-stream" : metadata.MimeType,
                MediaKind = string.IsNullOrWhiteSpace(metadata.MediaKind) ? "other" : metadata.MediaKind
            };
            ValidateMetadata(metadata);
            return metadata;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    public static CloudCipherEnvelope EncryptMetadata(ReadOnlySpan<byte> fileKey, CloudFileMetadata metadata)
    {
        ValidateMetadata(metadata);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(metadata, JsonOptions);
        try { return Encrypt(fileKey, bytes, FileMetadataContext); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static CloudCipherEnvelope Encrypt(ReadOnlySpan<byte> key, ReadOnlySpan<byte> plaintext, string context)
    {
        ValidateKey(key);
        var iv = RandomNumberGenerator.GetBytes(12);
        var ciphertext = new byte[checked(plaintext.Length + 16)];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(iv, plaintext, ciphertext.AsSpan(0, plaintext.Length), ciphertext.AsSpan(plaintext.Length), Encoding.UTF8.GetBytes(context));
        return new(Encode(ciphertext), Encode(iv));
    }

    private static byte[] Decrypt(ReadOnlySpan<byte> key, CloudCipherEnvelope envelope, string context, int minimum, int maximum)
    {
        ValidateKey(key);
        var ciphertext = Decode(envelope.Ciphertext, minimum + 16, maximum + 16);
        var iv = Decode(envelope.Iv, 12, 12);
        var plaintext = new byte[ciphertext.Length - 16];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(iv, ciphertext.AsSpan(0, plaintext.Length), ciphertext.AsSpan(plaintext.Length), plaintext, Encoding.UTF8.GetBytes(context));
            return plaintext;
        }
        catch { CryptographicOperations.ZeroMemory(plaintext); throw; }
    }

    private static void ValidateKey(ReadOnlySpan<byte> key)
    {
        if (key.Length != 32) throw new CryptographicException("鍵は256ビットである必要があります。");
    }

    private static void ValidateName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 240 || name.Contains('\0'))
            throw new CryptographicException("名前の形式が不正です。");
    }

    private static void ValidateMetadata(CloudFileMetadata metadata)
    {
        ValidateName(metadata.Name);
        if (string.IsNullOrWhiteSpace(metadata.MimeType) || metadata.MimeType.Length > 200
            || metadata.MediaKind is not ("image" or "video" or "audio" or "document" or "other")
            || metadata.LastModified is < 0 or > 9007199254740991)
            throw new CryptographicException("ファイル情報の形式が不正です。");
    }

    private static string Encode(ReadOnlySpan<byte> bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value, int minimum, int maximum)
    {
        if (value.Length > (maximum + 2) / 3 * 4 || value.Length % 4 == 1
            || value.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')))
            throw new CryptographicException("暗号化データの形式が不正です。");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4)); }
        catch (FormatException) { throw new CryptographicException("暗号化データの形式が不正です。"); }
        if (bytes.Length < minimum || bytes.Length > maximum || Encode(bytes) != value)
            throw new CryptographicException("暗号化データの形式が不正です。");
        return bytes;
    }
}

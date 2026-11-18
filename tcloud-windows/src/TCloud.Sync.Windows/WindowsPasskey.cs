using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TCloud.Sync.Windows;

/// <summary>Existing T-lain credentials only. Never registers a credential or serializes a PRF result.</summary>
public static class WindowsPasskey
{
    public const string RelyingParty = "tanaka-note.com";
    public const string Origin = "https://tanaka-note.com";

    public static uint ApiVersion => Native.WebAuthNGetApiVersionNumber();

    public static PasskeyRequest Prepare(JsonElement options)
    {
        if (options.GetProperty("rpId").GetString() != RelyingParty
            || options.GetProperty("userVerification").GetString() != "required")
            throw new CryptographicException("認証先または本人確認の条件が一致しません。");
        var challenge = options.GetProperty("challenge").GetString() ?? "";
        _ = Decode(challenge, 16, 256);
        var credentials = options.GetProperty("allowCredentials").EnumerateArray().ToArray();
        if (credentials.Length is 0 or > 256) throw new CryptographicException("認証候補を確認できません。");
        var salts = options.GetProperty("extensions").GetProperty("prf").GetProperty("evalByCredential");
        var values = new Dictionary<string, (byte[] Credential, byte[] Salt)>(StringComparer.Ordinal);
        foreach (var credential in credentials)
        {
            var id = credential.GetProperty("id").GetString() ?? "";
            if (credential.GetProperty("type").GetString() != "public-key" || !salts.TryGetProperty(id, out var salt)
                || salt.TryGetProperty("second", out _))
                throw new CryptographicException("パスキーの復号条件を確認できません。");
            if (!values.TryAdd(id, (Decode(id, 1, 4096), Decode(salt.GetProperty("first").GetString() ?? "", 32, 32))))
                throw new CryptographicException("認証候補が重複しています。");
        }
        var clientData = JsonSerializer.SerializeToUtf8Bytes(new { type = "webauthn.get", challenge, origin = Origin, crossOrigin = false });
        return new PasskeyRequest(clientData, values);
    }

    public static PasskeyAssertion Authenticate(nint ownerWindow, PasskeyRequest request, CancellationToken cancellationToken = default)
    {
        if (ownerWindow == 0) throw new ArgumentException("認証画面の親ウィンドウが必要です。", nameof(ownerWindow));
        if (ApiVersion < 4) throw new PlatformNotSupportedException("このWindowsは必要なパスキー復号APIに対応していません。");
        cancellationToken.ThrowIfCancellationRequested();
        using var memory = new NativeMemory();
        var type = memory.Text("public-key");
        var credentials = new List<Native.Credential>();
        var salts = new List<Native.CredentialSalt>();
        foreach (var value in request.Values.Values)
        {
            var id = memory.Pin(value.Credential);
            credentials.Add(new() { Version = 1, Length = (uint)value.Credential.Length, Id = id, Type = type });
            var salt = memory.Struct(new Native.Salt { FirstLength = (uint)value.Salt.Length, First = memory.Pin(value.Salt) });
            salts.Add(new() { Length = (uint)value.Credential.Length, Id = id, Salt = salt });
        }
        Check(Native.WebAuthNGetCancellationId(out var cancellationId));
        var options = new Native.Options
        {
            Version = 6, Timeout = 60000,
            Credentials = new() { Count = (uint)credentials.Count, Items = memory.Array(credentials) },
            UserVerification = 1, // WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED
            CancellationId = memory.Struct(cancellationId),
            SaltValues = memory.Struct(new Native.SaltValues { Count = (uint)salts.Count, Items = memory.Array(salts) })
            // No HMAC_SECRET_VALUES flag: Windows applies the WebAuthn PRF input hashing.
        };
        var clientData = new Native.ClientData { Version = 1, Length = (uint)request.ClientData.Length,
            Json = memory.Pin(request.ClientData), HashAlgorithm = memory.Text("SHA-256") };
        using var cancellation = cancellationToken.Register(() => { _ = Native.WebAuthNCancelCurrentOperation(cancellationId); });
        nint result = 0;
        Native.Salt secret = default;
        byte[]? prf = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            Check(Native.WebAuthNAuthenticatorGetAssertion(ownerWindow, RelyingParty, clientData, options, out result));
            if (result == 0 || Marshal.ReadInt32(result) < 3) throw new CryptographicException("パスキーの復号結果がありません。");
            var assertion = Marshal.PtrToStructure<Native.Assertion>(result);
            if (assertion.Secret == 0) throw new CryptographicException("このパスキーは端末内での復号に対応していません。");
            secret = Marshal.PtrToStructure<Native.Salt>(assertion.Secret);
            prf = Copy(secret.First, secret.FirstLength, 32, 32);
            var id = Encode(Copy(assertion.Credential.Id, assertion.Credential.Length, 1, 4096));
            if (!request.Values.ContainsKey(id)) throw new CryptographicException("選択したパスキーが認証候補と一致しません。");
            var authenticatorData = Copy(assertion.AuthenticatorData, assertion.AuthenticatorDataLength, 37, 65536);
            var rpHash = SHA256.HashData(Encoding.UTF8.GetBytes(RelyingParty));
            if (!CryptographicOperations.FixedTimeEquals(authenticatorData.AsSpan(0, 32), rpHash) || (authenticatorData[32] & 5) != 5)
                throw new CryptographicException("認証先または本人確認の結果が一致しません。");
            var signature = Copy(assertion.Signature, assertion.SignatureLength, 8, 8192);
            var userHandle = assertion.UserLength == 0 ? null : Encode(Copy(assertion.User, assertion.UserLength, 1, 64));
            var response = JsonSerializer.SerializeToElement(new { id, rawId = id, type = "public-key",
                clientExtensionResults = new { prf = new { enabled = true } },
                response = new { clientDataJSON = Encode(request.ClientData), authenticatorData = Encode(authenticatorData),
                    signature = Encode(signature), userHandle } });
            var output = new PasskeyAssertion(response, prf);
            prf = null;
            return output;
        }
        finally
        {
            if (prf is not null) CryptographicOperations.ZeroMemory(prf);
            Clear(secret.First, secret.FirstLength);
            Clear(secret.Second, secret.SecondLength);
            if (result != 0) Native.WebAuthNFreeAssertion(result);
        }
    }

    private static void Clear(nint pointer, uint length)
    {
        if (pointer != 0 && length is > 0 and <= 4096) Marshal.Copy(new byte[length], 0, pointer, (int)length);
    }
    private static byte[] Copy(nint pointer, uint length, int minimum, int maximum)
    {
        if (pointer == 0 || length < minimum || length > maximum) throw new CryptographicException("Windowsの認証応答が不正です。");
        var bytes = new byte[length];
        Marshal.Copy(pointer, bytes, 0, bytes.Length);
        return bytes;
    }
    internal static byte[] Decode(string value, int minimum, int maximum)
    {
        if (value.Length > maximum * 2 || value.Length % 4 == 1 || value.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')))
            throw new CryptographicException("認証情報の形式が不正です。");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/').PadRight((value.Length + 3) / 4 * 4, '=')); }
        catch (FormatException) { throw new CryptographicException("認証情報の形式が不正です。"); }
        if (bytes.Length < minimum || bytes.Length > maximum || Encode(bytes) != value)
            throw new CryptographicException("認証情報の形式が不正です。");
        return bytes;
    }
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static void Check(int result) { if (result != 0) throw new CryptographicException(result); }

    private sealed class NativeMemory : IDisposable
    {
        private readonly List<GCHandle> pins = [];
        private readonly List<nint> allocations = [];
        public nint Pin(byte[] bytes) { var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned); pins.Add(pin); return pin.AddrOfPinnedObject(); }
        public nint Text(string text) { var value = Marshal.StringToHGlobalUni(text); allocations.Add(value); return value; }
        public nint Struct<T>(T value) where T : struct => Array(new[] { value });
        public nint Array<T>(IReadOnlyList<T> values) where T : struct
        {
            var size = Marshal.SizeOf<T>();
            var memory = Marshal.AllocHGlobal(checked(size * values.Count));
            allocations.Add(memory);
            for (var i = 0; i < values.Count; i++) Marshal.StructureToPtr(values[i], memory + i * size, false);
            return memory;
        }
        public void Dispose() { foreach (var pin in pins) pin.Free(); foreach (var allocation in allocations) Marshal.FreeHGlobal(allocation); }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct Credential { public uint Version, Length; public nint Id, Type; }
        [StructLayout(LayoutKind.Sequential)] internal struct List { public uint Count; public nint Items; }
        [StructLayout(LayoutKind.Sequential)] internal struct Salt { public uint FirstLength; public nint First; public uint SecondLength; public nint Second; }
        [StructLayout(LayoutKind.Sequential)] internal struct CredentialSalt { public uint Length; public nint Id, Salt; }
        [StructLayout(LayoutKind.Sequential)] internal struct SaltValues { public nint Global; public uint Count; public nint Items; }
        [StructLayout(LayoutKind.Sequential)] internal struct ClientData { public uint Version, Length; public nint Json, HashAlgorithm; }
        // Version 6 input, stable prefix of the current Windows WebAuthn structure.
        [StructLayout(LayoutKind.Sequential)] internal struct Options
        {
            public uint Version, Timeout; public List Credentials, Extensions; public uint Attachment, UserVerification, Flags;
            public nint AppId, UsedAppId, CancellationId, AllowCredentials; public uint LargeBlobOperation, LargeBlobLength;
            public nint LargeBlob, SaltValues; public int PrivateMode;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Assertion
        {
            public uint Version, AuthenticatorDataLength; public nint AuthenticatorData; public uint SignatureLength; public nint Signature;
            public Credential Credential; public uint UserLength; public nint User; public List Extensions;
            public uint LargeBlobLength; public nint LargeBlob; public uint LargeBlobStatus; public nint Secret;
        }
        [DllImport("webauthn.dll")] internal static extern uint WebAuthNGetApiVersionNumber();
        [DllImport("webauthn.dll", CharSet = CharSet.Unicode)] internal static extern int WebAuthNAuthenticatorGetAssertion(nint owner, string relyingParty,
            in ClientData clientData, in Options options, out nint assertion);
        [DllImport("webauthn.dll")] internal static extern void WebAuthNFreeAssertion(nint assertion);
        [DllImport("webauthn.dll")] internal static extern int WebAuthNGetCancellationId(out Guid cancellationId);
        [DllImport("webauthn.dll")] internal static extern int WebAuthNCancelCurrentOperation(in Guid cancellationId);
    }
}

public sealed class PasskeyRequest
{
    internal byte[] ClientData { get; }
    internal IReadOnlyDictionary<string, (byte[] Credential, byte[] Salt)> Values { get; }
    internal PasskeyRequest(byte[] clientData, IReadOnlyDictionary<string, (byte[] Credential, byte[] Salt)> values)
    { ClientData = clientData; Values = values; }
}

public sealed class PasskeyAssertion : IDisposable
{
    private byte[]? prf;
    public JsonElement ServerResponse { get; }
    internal PasskeyAssertion(JsonElement response, byte[] secret) { ServerResponse = response; prf = secret; }
    // Call only after the existing server has verified the assertion and selected credential.
    public ReadOnlySpan<byte> GetPrfOutput() => prf ?? throw new ObjectDisposedException(nameof(PasskeyAssertion));
    public void Dispose() { var secret = Interlocked.Exchange(ref prf, null); if (secret is not null) CryptographicOperations.ZeroMemory(secret); }
}

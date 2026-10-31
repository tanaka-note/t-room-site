using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

/// <summary>
/// Isolated local proof of the CFAPI transport. No Cloudflare credentials, login,
/// production network, user-selected HDD or existing folder can be used here.
/// </summary>
public sealed class CloudFilesFixture : IDisposable
{
    private readonly string root;
    private readonly VolumeBinding volume;
    private readonly CloudFilesNative.Callback fetch;
    private readonly ConcurrentDictionary<string, byte[]> data = new(StringComparer.Ordinal);
    private long connection;
    private bool registered;
    private int disposed;
    private int fetchCount;
    public string Root => root;
    public int FetchCount => Volatile.Read(ref fetchCount);
    public ConcurrentQueue<Exception> Errors { get; } = new();

    private CloudFilesFixture(string root)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
            throw new PlatformNotSupportedException("Windows 64ビット環境が必要です。");
        this.root = root;
        volume = VolumeInspector.ValidateDestination(root, []);
        fetch = Fetch;
        try
        {
            var registration = new CloudFilesNative.Registration
            {
                StructSize = (uint)Marshal.SizeOf<CloudFilesNative.Registration>(),
                ProviderName = "T-Cloud local fixture", ProviderVersion = "0.1.0",
                ProviderId = new("2ccdc664-7821-4e41-a2ec-61017fa15c02")
            };
            var policies = new CloudFilesNative.Policies
            {
                StructSize = (uint)Marshal.SizeOf<CloudFilesNative.Policies>(),
                Hydration = new() { Primary = 1 }, // PROGRESSIVE, never auto-dehydrate
                Population = new() { Primary = 3 } // ALWAYS_FULL namespace
            };
            CloudFilesNative.Check(CloudFilesNative.CfRegisterSyncRoot(root, registration, policies, 0));
            registered = true;
            CloudFilesNative.CallbackRegistration[] callbacks =
            [new() { Type = 0, Function = Marshal.GetFunctionPointerForDelegate(fetch) }, new() { Type = -1 }];
            CloudFilesNative.Check(CloudFilesNative.CfConnectSyncRoot(root, callbacks, 0, 2, out connection));
        }
        catch { Dispose(); throw; }
    }

    public static CloudFilesFixture Create()
    {
        // No path argument is exposed: a fixture can never adopt a real sync root.
        var root = Path.Combine(Path.GetTempPath(), "tcloud-cfapi-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try { return new(root); }
        catch { if (Directory.Exists(root)) Directory.Delete(root); throw; }
    }

    public void Add(string name, ReadOnlySpan<byte> plaintext)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        if (!VolumeInspector.IsExpectedVolumePresent(root, volume)) throw new IOException("保存先が接続されていません。");
        var safeName = LocalPaths.EncodeName(name);
        var identity = Guid.NewGuid().ToString("N");
        data[identity] = plaintext.ToArray();
        var identityBytes = Encoding.UTF8.GetBytes(identity);
        var identityMemory = Marshal.AllocHGlobal(identityBytes.Length);
        try
        {
            Marshal.Copy(identityBytes, 0, identityMemory, identityBytes.Length);
            var timestamp = DateTime.UtcNow.ToFileTimeUtc();
            CloudFilesNative.Placeholder[] placeholders = [new()
            {
                RelativeFileName = safeName, FileIdentity = identityMemory, FileIdentityLength = (uint)identityBytes.Length,
                Flags = 2, // MARK_IN_SYNC, not ALWAYS_FULL
                FsMetadata = new()
                {
                    Basic = new() { CreationTime = timestamp, LastAccessTime = timestamp, LastWriteTime = timestamp,
                        ChangeTime = timestamp, Attributes = (uint)FileAttributes.Normal }, FileSize = plaintext.Length
                }
            }];
            CloudFilesNative.Check(CloudFilesNative.CfCreatePlaceholders(root, placeholders, 1, 1, out var processed));
            if (processed != 1) throw new IOException("プレースホルダーを作成できませんでした。");
            CloudFilesNative.Check(placeholders[0].Result);
        }
        catch { if (data.TryRemove(identity, out var bytes)) CryptographicOperations.ZeroMemory(bytes); throw; }
        finally { Marshal.FreeHGlobal(identityMemory); }
    }

    private void Fetch(in CloudFilesNative.CallbackInfo info, in CloudFilesNative.CallbackParameters parameters)
    {
        var operation = new CloudFilesNative.OperationInfo
        {
            StructSize = (uint)Marshal.SizeOf<CloudFilesNative.OperationInfo>(), Type = 0,
            ConnectionKey = info.ConnectionKey, TransferKey = info.TransferKey, RequestKey = info.RequestKey
        };
        var transfer = new CloudFilesNative.TransferParameters
        {
            ParamSize = (uint)Marshal.SizeOf<CloudFilesNative.TransferParameters>(),
            Offset = parameters.RequiredOffset, Length = parameters.RequiredLength
        };
        try
        {
            if (Volatile.Read(ref disposed) != 0 || !VolumeInspector.IsExpectedVolumePresent(root, volume))
                throw new IOException("保存先が接続されていません。");
            if (info.FileIdentityLength is 0 or > 4096) throw new InvalidDataException("識別情報が不正です。");
            var identity = Marshal.PtrToStringUTF8(info.FileIdentity, (int)info.FileIdentityLength)!;
            if (!data.TryGetValue(identity, out var bytes)) throw new FileNotFoundException();
            var offset = parameters.RequiredOffset;
            if (offset < 0 || offset >= bytes.Length) throw new InvalidDataException("取得範囲が不正です。");
            var length = (int)Math.Min(parameters.RequiredLength, bytes.Length - offset);
            if (length <= 0) throw new InvalidDataException("取得範囲が不正です。");
            var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                transfer.Buffer = pinned.AddrOfPinnedObject() + checked((int)offset);
                transfer.Length = length;
                CloudFilesNative.Check(CloudFilesNative.CfExecute(operation, transfer));
                Interlocked.Increment(ref fetchCount);
            }
            finally { pinned.Free(); }
        }
        catch (Exception error)
        {
            Errors.Enqueue(error);
            transfer.Buffer = 0;
            transfer.CompletionStatus = unchecked((int)0xC000CF01); // STATUS_CLOUD_FILE_UNSUCCESSFUL
            _ = CloudFilesNative.CfExecute(operation, transfer);
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        if (connection != 0) { CloudFilesNative.Check(CloudFilesNative.CfDisconnectSyncRoot(connection)); connection = 0; }
        if (registered) { CloudFilesNative.Check(CloudFilesNative.CfUnregisterSyncRoot(root)); registered = false; }
        foreach (var bytes in data.Values) CryptographicOperations.ZeroMemory(bytes);
        data.Clear();
        // This is an owned random temp directory, never a selected HDD folder.
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(root).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(root).StartsWith("tcloud-cfapi-", StringComparison.Ordinal)
            || new DirectoryInfo(root).LinkTarget is not null)
            throw new IOException("検証用フォルダの範囲を確認できません。");
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        GC.KeepAlive(fetch);
    }
}

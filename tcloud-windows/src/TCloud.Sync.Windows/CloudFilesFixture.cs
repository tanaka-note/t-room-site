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
    private readonly CloudFilesNative.Callback cancelFetch;
    private readonly CloudFilesNative.Callback openCompleted;
    private readonly CloudFilesNative.Callback rejectDelete;
    private readonly ConcurrentDictionary<string, byte[]> data = new(StringComparer.Ordinal);
    private readonly object transferGate = new();
    private readonly ManualResetEventSlim transfersDone = new(true);
    private int activeTransfers;
    private long connection;
    private bool registered;
    private int disposed;
    private int fetchCount;
    private int rejectedDeleteCount;
    public string Root => root;
    public int FetchCount => Volatile.Read(ref fetchCount);
    public int RejectedDeleteCount => Volatile.Read(ref rejectedDeleteCount);
    public ConcurrentQueue<Exception> Errors { get; } = new();
    public ConcurrentQueue<string> FetchDiagnostics { get; } = new();

    private CloudFilesFixture(string root, bool denyDeletes, bool requireFullHydration)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
            throw new PlatformNotSupportedException("Windows 64ビット環境が必要です。");
        this.root = root;
        volume = VolumeInspector.ValidateDestination(root, []);
        fetch = Fetch;
        cancelFetch = CancelFetch;
        openCompleted = OpenCompleted;
        rejectDelete = RejectDelete;
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
                Hydration = new() { Primary = (ushort)(requireFullHydration ? 2 : 1) }, // FULL / PROGRESSIVE
                Population = new() { Primary = 3 } // ALWAYS_FULL namespace
            };
            CloudFilesNative.Check(CloudFilesNative.CfRegisterSyncRoot(root, registration, policies, 0));
            registered = true;
            var callbacks = new List<CloudFilesNative.CallbackRegistration>
            {
                new() { Type = 0, Function = Marshal.GetFunctionPointerForDelegate(fetch) },
                new() { Type = 2, Function = Marshal.GetFunctionPointerForDelegate(cancelFetch) },
                new() { Type = 5, Function = Marshal.GetFunctionPointerForDelegate(openCompleted) }
            };
            if (denyDeletes)
                callbacks.Add(new() { Type = 9, Function = Marshal.GetFunctionPointerForDelegate(rejectDelete) });
            callbacks.Add(new() { Type = -1 });
            CloudFilesNative.Check(CloudFilesNative.CfConnectSyncRoot(root, callbacks.ToArray(), 0, 2, out connection));
        }
        catch { Dispose(); throw; }
    }

    public static CloudFilesFixture Create(bool denyDeletes = false, bool requireFullHydration = true)
    {
        // No path argument is exposed: a fixture can never adopt a real sync root.
        var root = Path.Combine(Path.GetTempPath(), "tcloud-cfapi-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try { return new(root, denyDeletes, requireFullHydration); }
        catch { if (Directory.Exists(root)) Directory.Delete(root); throw; }
    }

    public void Add(string name, ReadOnlySpan<byte> plaintext, string relativeDirectory = "")
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        if (!VolumeInspector.IsExpectedVolumePresent(root, volume)) throw new IOException("保存先が接続されていません。");
        var destination = relativeDirectory.Length == 0 ? root : LocalPaths.ResolveUnderRoot(root, relativeDirectory);
        Directory.CreateDirectory(destination);
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
            CloudFilesNative.Check(CloudFilesNative.CfCreatePlaceholders(destination, placeholders, 1, 1, out var processed));
            if (processed != 1) throw new IOException("プレースホルダーを作成できませんでした。");
            CloudFilesNative.Check(placeholders[0].Result);
        }
        catch { if (data.TryRemove(identity, out var bytes)) CryptographicOperations.ZeroMemory(bytes); throw; }
        finally { Marshal.FreeHGlobal(identityMemory); }
    }

    public void ConvertExisting(string relativePath)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        if (!VolumeInspector.IsExpectedVolumePresent(root, volume)) throw new IOException("保存先が接続されていません。");
        var path = LocalPaths.ResolveUnderRoot(root, relativePath);
        if (new FileInfo(path).LinkTarget is not null) throw new IOException("リンクは検証対象にできません。");
        var identity = Guid.NewGuid().ToString("N");
        var bytes = File.ReadAllBytes(path);
        data[identity] = bytes;
        try
        {
            using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
            var identityBytes = Encoding.UTF8.GetBytes(identity);
            // Preserve the complete local body; never mark a new edit uploaded or dehydrate it.
            CloudFilesNative.Check(CloudFilesNative.CfConvertToPlaceholder(handle, identityBytes, (uint)identityBytes.Length,
                8 /* ALWAYS_FULL */, out _, 0));
        }
        catch { data.TryRemove(identity, out _); CryptographicOperations.ZeroMemory(bytes); throw; }
    }

    private void Fetch(in CloudFilesNative.CallbackInfo info, in CloudFilesNative.CallbackParameters parameters)
    {
        FetchDiagnostics.Enqueue($"request {parameters.RequiredOffset}+{parameters.RequiredLength}; optional {parameters.OptionalOffset}+{parameters.OptionalLength}; flags {parameters.Flags}; size {info.FileSize}; ABI {info.StructSize}/{parameters.ParamSize}");
        var operation = new CloudFilesNative.OperationInfo
        {
            StructSize = (uint)Marshal.SizeOf<CloudFilesNative.OperationInfo>(), Type = 0,
            ConnectionKey = info.ConnectionKey, TransferKey = info.TransferKey, RequestKey = info.RequestKey
        };
        try
        {
            if (info.FileIdentityLength is 0 or > 4096) throw new InvalidDataException("識別情報が不正です。");
            // Native callback pointers expire on return. Copy identity and scalar keys
            // before queuing any I/O, and let the native dispatcher return promptly.
            var identity = Marshal.PtrToStringUTF8(info.FileIdentity, (int)info.FileIdentityLength)!;
            var request = parameters;
            lock (transferGate)
            {
                if (Volatile.Read(ref disposed) != 0) return;
                activeTransfers++;
                transfersDone.Reset();
                _ = Task.Run(() =>
                {
                    try { Transfer(operation, request, identity); }
                    finally
                    {
                        lock (transferGate) { if (--activeTransfers == 0) transfersDone.Set(); }
                    }
                });
            }
        }
        catch (Exception error)
        {
            Errors.Enqueue(error);
            var failure = new CloudFilesNative.TransferParameters
            {
                ParamSize = (uint)Marshal.SizeOf<CloudFilesNative.TransferParameters>(),
                Offset = parameters.RequiredOffset, Length = parameters.RequiredLength,
                CompletionStatus = CloudFilesNative.StatusUnsuccessful
            };
            _ = CloudFilesNative.CfExecute(operation, failure);
        }
    }

    private void Transfer(CloudFilesNative.OperationInfo operation, CloudFilesNative.CallbackParameters parameters, string identity)
    {
        var transfer = new CloudFilesNative.TransferParameters
        {
            ParamSize = (uint)Marshal.SizeOf<CloudFilesNative.TransferParameters>(),
            Offset = parameters.RequiredOffset, Length = parameters.RequiredLength
        };
        try
        {
            if (Volatile.Read(ref disposed) != 0) throw new OperationCanceledException();
            if (!VolumeInspector.IsExpectedVolumePresent(root, volume))
                throw new IOException("保存先が接続されていません。");
            if (!data.TryGetValue(identity, out var bytes)) throw new FileNotFoundException();
            // Web originals authenticate whole 8 MiB (or larger) plaintext chunks.
            // Retain the complete verified chunks instead of discarding already fetched bytes.
            var range = CloudFilesRange.ForVerifiedChunks(bytes.LongLength, 8 * 1024 * 1024,
                parameters.RequiredOffset, parameters.RequiredLength);
            var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                var end = range.Offset + range.Length;
                for (var position = range.Offset; position < end;)
                {
                    transfer.Offset = position;
                    transfer.Length = Math.Min(8 * 1024 * 1024, end - position);
                    transfer.Buffer = pinned.AddrOfPinnedObject() + checked((int)position);
                    CloudFilesNative.Check(CloudFilesNative.CfExecute(operation, transfer));
                    FetchDiagnostics.Enqueue($"transferred {transfer.Offset}+{transfer.Length}");
                    Interlocked.Increment(ref fetchCount);
                    position += transfer.Length;
                }
            }
            finally { pinned.Free(); }
        }
        catch (Exception error) when (error is OperationCanceledException || error.HResult == unchecked((int)0x8007018E))
        {
            // A progressive/background request may be cancelled by a seek or close.
            // It no longer has an I/O to complete; do not publish a failed transfer.
            FetchDiagnostics.Enqueue("transfer-cancelled");
        }
        catch (Exception error)
        {
            Errors.Enqueue(error);
            transfer.Buffer = 0;
            transfer.CompletionStatus = CloudFilesNative.StatusUnsuccessful;
            _ = CloudFilesNative.CfExecute(operation, transfer);
        }
    }

    private void CancelFetch(in CloudFilesNative.CallbackInfo info, in CloudFilesNative.CallbackParameters parameters)
    {
        // Notification only: our in-memory transfer has no pending network work.
        FetchDiagnostics.Enqueue($"cancel {parameters.RequiredOffset}+{parameters.RequiredLength}; flags {parameters.Flags}");
    }

    private void OpenCompleted(in CloudFilesNative.CallbackInfo info, in CloudFilesNative.CallbackParameters parameters)
        => FetchDiagnostics.Enqueue($"open flags {parameters.Flags}");

    private void RejectDelete(in CloudFilesNative.CallbackInfo info, in CloudFilesNative.CallbackParameters parameters)
    {
        var operation = new CloudFilesNative.OperationInfo
        {
            StructSize = (uint)Marshal.SizeOf<CloudFilesNative.OperationInfo>(), Type = 6, // ACK_DELETE
            ConnectionKey = info.ConnectionKey, TransferKey = info.TransferKey, RequestKey = info.RequestKey
        };
        var acknowledgement = new CloudFilesNative.TransferParameters
        {
            ParamSize = 16, // Header and ACK_DELETE flags/status, without the transfer-data fields.
            CompletionStatus = CloudFilesNative.StatusAccessDenied
        };
        try
        {
            CloudFilesNative.Check(CloudFilesNative.CfExecute(operation, acknowledgement));
            Interlocked.Increment(ref rejectedDeleteCount);
        }
        catch (Exception error) { Errors.Enqueue(error); }
    }

    public void StopProvider()
    {
        if (connection != 0) { CloudFilesNative.Check(CloudFilesNative.CfDisconnectSyncRoot(connection)); connection = 0; }
        if (!transfersDone.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException("検証用の取得処理の終了を確認できません。");
    }

    public void UnregisterProvider()
    {
        StopProvider();
        if (registered) { CloudFilesNative.Check(CloudFilesNative.CfUnregisterSyncRoot(root)); registered = false; }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        UnregisterProvider();
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
        GC.KeepAlive(cancelFetch);
        GC.KeepAlive(openCompleted);
        GC.KeepAlive(rejectDelete);
        transfersDone.Dispose();
    }
}

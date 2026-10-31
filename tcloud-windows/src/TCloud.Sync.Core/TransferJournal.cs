using System.Text.Json;

namespace TCloud.Sync.Core;

public enum TransferKind { UploadNew, UploadRevision, Download, TrashRemote, RecycleLocal }
// Deliberately no Cookie, PRF output or keys in the journal's data contract.
public sealed record PendingTransfer(string OperationId, string FileId, TransferKind Kind, long BaseRevision,
    string RelativePath, DateTimeOffset CreatedAt);
public sealed record JournalSnapshot(int Version, string AccountScope, VolumeBinding Volume, string? RemoteCursor,
    IReadOnlyList<PendingTransfer> Pending);

public sealed class TransferJournal(string path)
{
    private readonly string path = Path.GetFullPath(path);
    private readonly SemaphoreSlim gate = new(1, 1);
    private const int MaxBytes = 8 * 1024 * 1024;

    public async Task SaveAsync(JournalSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        Validate(snapshot);
        await gate.WaitAsync(cancellationToken);
        var staging = path + "." + Guid.NewGuid().ToString("N") + ".pending";
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(snapshot);
            if (bytes.Length > MaxBytes) throw new InvalidDataException("同期記録が大きすぎます。");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await using (var stream = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.WriteThrough | FileOptions.Asynchronous))
            {
                await stream.WriteAsync(bytes, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            File.Move(staging, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(staging)) File.Delete(staging);
            gate.Release();
        }
    }

    public async Task<JournalSnapshot?> LoadAsync(string expectedScope, VolumeBinding expectedVolume,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(path)) return null;
            if (new FileInfo(path).Length > MaxBytes) throw new InvalidDataException("同期記録が大きすぎます。");
            await using var stream = File.OpenRead(path);
            var snapshot = await JsonSerializer.DeserializeAsync<JournalSnapshot>(stream, cancellationToken: cancellationToken)
                ?? throw new InvalidDataException("同期記録を読み取れません。");
            Validate(snapshot);
            if (snapshot.AccountScope != expectedScope || snapshot.Volume != expectedVolume)
                throw new InvalidDataException("同期記録のアカウントまたは保存先が一致しません。");
            return snapshot;
        }
        finally { gate.Release(); }
    }

    private static void Validate(JournalSnapshot snapshot)
    {
        if (snapshot.Version != 1 || string.IsNullOrWhiteSpace(snapshot.AccountScope) || snapshot.Volume is null
            || string.IsNullOrWhiteSpace(snapshot.Volume.GuidPath) || snapshot.Pending is null || snapshot.Pending.Count > 10000
            || snapshot.Pending.Select(item => item.OperationId).Distinct(StringComparer.Ordinal).Count() != snapshot.Pending.Count)
            throw new InvalidDataException("同期記録の形式が不正です。");
        foreach (var item in snapshot.Pending)
        {
            if (string.IsNullOrWhiteSpace(item.OperationId) || string.IsNullOrWhiteSpace(item.FileId)
                || !Enum.IsDefined(item.Kind) || item.BaseRevision < 0) throw new InvalidDataException("転送記録が不正です。");
            _ = LocalPaths.ResolveUnderRoot(Path.GetTempPath(), item.RelativePath);
        }
    }
}

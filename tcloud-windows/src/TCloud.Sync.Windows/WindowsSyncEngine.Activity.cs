using System.Security.Cryptography;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed partial class WindowsSyncEngine
{
    private readonly WindowsSyncActivity? activity;
    private volatile bool catalogOnline;
    private int checkRequested;
    internal Func<long>? TestAvailableSpace { get; set; }
    private long AvailableSpace() => TestAvailableSpace?.Invoke() ?? VolumeInspector.Inspect(root.Root).AvailableBytes;

    public void RequestCheck()
    {
        Interlocked.Exchange(ref checkRequested, 1);
        activity?.Invalidate("オンラインの一覧とHDDを照合しています。");
    }

    public void SetCatalogUnavailable(string notice)
    {
        catalogOnline = false;
        activity?.Invalidate(notice);
    }

    private static WindowsActivityItem LocalItem(string path, WindowsFileState? stamp, WindowsActivityOperation operation,
        WindowsActivityState state, string? reason = null) => new("local:" + WindowsSyncActivity.Key(path.ToUpperInvariant()), path,
            operation, state, DateTimeOffset.UtcNow, stamp?.Size, Reason: reason, LocalId: stamp?.Id ?? 0, LocalUsn: stamp?.Usn ?? 0);

    private void ObserveLocal(LocalSyncSnapshot snapshot, Tree tree, bool offline)
    {
        if (activity is null) return;
        var originals = snapshot.Originals.Where(row => !row.Deleted).ToArray();
        var byPath = originals.ToDictionary(row => row.RelativePath, StringComparer.OrdinalIgnoreCase);
        var byId = originals.Where(row => row.LocalFileId != 0).ToLookup(row => row.LocalFileId);
        var knownFolders = snapshot.Folders ?? [];
        var folders = knownFolders.Select(row => row.RelativePath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var folderIds = knownFolders.Select(row => row.FileId).ToHashSet();
        var mapped = !offline && (snapshot.Folders is not null || !snapshot.Remote.Any(row => row.Kind == "folder" && row.State == "present"));
        var rows = tree.Excluded.Where(item => !byPath.ContainsKey(item.RelativePath)).ToList();
        foreach (var (path, stamp) in tree.Folders)
        {
            if (folders.Contains(path) || folderIds.Contains(stamp.Id)) continue;
            var top = path.Split(Path.DirectorySeparatorChar, 2)[0];
            if (Path.GetDirectoryName(path) is not { Length: > 0 } || mapped && !folders.Contains(top))
                rows.Add(LocalItem(path, null, WindowsActivityOperation.CreatedFolder, WindowsActivityState.Attention,
                    "最上位フォルダはT-CloudのWeb画面で作成できます。HDDで作成する場合は既存のT-Cloudフォルダの配下を選択してください。"));
        }
        foreach (var (path, stamp) in tree.Files)
        {
            var full = LocalPaths.ResolveUnderRoot(root.Root, path);
            var old = byId[stamp.Id].FirstOrDefault() ?? byPath.GetValueOrDefault(path);
            var samePath = old?.RelativePath.Equals(path, StringComparison.Ordinal) == true;
            var baseline = old?.LocalState;
            var verified = verifiedLocal.TryGetValue(stamp.Id, out var proof) && proof.State == stamp && proof.Path == full
                && proof.Change == localChanges.GetValueOrDefault(full) && proof.Sha256 == old?.Sha256;
            if (samePath && (verified || stamp.SameSavedBytes(baseline))) continue;
            if ((CloudFilesLocalStorage.PlaceholderState(full) & 0x30) != 0) continue;
            // Older catalogs may lack a stamp. The actual bytes are checked by the normal reconciliation pass.
            if (samePath && old is { Sha256: not null } && baseline is null && old.LocalFileId == stamp.Id)
            {
                if (offline) rows.Add(LocalItem(path, stamp, WindowsActivityOperation.Updated, WindowsActivityState.Unverified,
                    "通信の復帰後に、HDDの内容と同期記録を照合します。"));
                continue;
            }
            var operation = old is null ? WindowsActivityOperation.Added : samePath ? WindowsActivityOperation.Updated : WindowsActivityOperation.Renamed;
            var parent = Path.GetDirectoryName(path) ?? "";
            var top = path.Split(Path.DirectorySeparatorChar, 2)[0];
            var row = parent.Length == 0 || mapped && !folders.Contains(top)
                ? LocalItem(path, stamp, operation, WindowsActivityState.Attention, "HDD内にある既存のT-Cloudフォルダへ移動すると自動送信されます。")
                : stamp.Size == 0
                    ? LocalItem(path, stamp, operation, WindowsActivityState.Waiting, "ファイルが0バイトです。内容が保存されると送信します。")
                    : !folders.Contains(parent)
                        ? LocalItem(path, stamp, operation, WindowsActivityState.Waiting, "保存先フォルダのオンライン反映を待っています。")
                        : LocalItem(path, stamp, operation, offline ? WindowsActivityState.Retry : WindowsActivityState.Waiting,
                            offline ? "通信の復帰後に自動で再試行します。" : "保存内容が確定したら送信します。");
            rows.Add(row);
        }
        activity.Observe(rows);
    }

    private async Task ObserveOfflineAsync(LocalSyncSnapshot snapshot, CancellationToken token)
    {
        ObserveLocal(snapshot, ScanTree(), offline: true);
        var originals = snapshot.Originals.Where(item => !item.Deleted).ToDictionary(item => item.Id);
        activity!.SetDownloads(snapshot.Remote.Where(item => item.Kind == "file" && item.State == "present" && originals.ContainsKey(item.Id))
            .Select(item => DownloadItem(item, originals[item.Id].RelativePath, WindowsActivityState.Unverified,
                reason: "通信の復帰後にオンラインの原本を照合します。")), keepSameVersion: true);
        foreach (var record in await uploads.LoadAsync(token))
            activity.Track(UploadItem(record, record.Result is null ? WindowsActivityState.Retry : WindowsActivityState.Checking,
                "通信の復帰後に送信結果を確認します。"));
    }

    private bool HasUploadSpace(string path, WindowsFileState stamp, WindowsActivityOperation operation, List<WindowsActivityItem> postponed)
    {
        if (stamp.Size <= 64L * 1024 * 1024 * 10000 && AvailableSpace() >= stamp.Size + 16L * 1024 * 1024)
            return true;
        var reason = stamp.Size > 64L * 1024 * 1024 * 10000 ? "ファイルが送信できるサイズを超えています。"
            : "送信用の一時保存領域が不足しています。HDDの空き容量を確認してください。";
        postponed.Add(LocalItem(path, stamp, operation, WindowsActivityState.Attention, reason));
        return false;
    }

    private async Task<PreparedWindowsUpload?> PrepareObservedAsync(CloudOriginalResolver resolver, WindowsCatalogEntry? entry, long folder,
        string path, WindowsFileState stamp, string epoch, CloudFileMetadata metadata, List<WindowsActivityItem> postponed, CancellationToken token)
    {
        var operation = entry is null ? WindowsActivityOperation.Added : WindowsActivityOperation.Updated;
        var row = LocalItem(path, stamp, operation, WindowsActivityState.Queued, "送信する保存内容を確認しています。");
        activity?.BlockObserved(row);
        try { return await uploader.PrepareAsync(resolver, entry, folder, path, epoch, metadata, token, activity?.FirstSeen(row.Key)); }
        catch (Exception error) when (error is IOException
            || error is System.ComponentModel.Win32Exception { NativeErrorCode: 5 or 32 or 33 })
        {
            root.VerifyPresent();
            postponed.Add(row with { State = WindowsActivityState.Retry, Reason = "保存の完了を確認してから自動で再試行します。" });
            return null;
        }
    }

    private static WindowsActivityItem UploadItem(PendingWindowsUpload upload, WindowsActivityState state, string? reason = null, long bytes = 0)
        => new("upload:" + upload.OperationId, upload.RelativePath,
            upload.Request.GetProperty("fileId").ValueKind == System.Text.Json.JsonValueKind.Null ? WindowsActivityOperation.Added : WindowsActivityOperation.Updated,
            state, upload.DetectedAt ?? DateTimeOffset.UtcNow, upload.SizeBytes, bytes, reason,
            LocalId: upload.SourceFileId, LocalUsn: upload.SourceUsn);

    private async Task TransferAndFinishAsync(PendingWindowsUpload upload, CloudOriginalResolver resolver, Stream? body, CancellationToken token)
    {
        if (upload.Result is null)
        {
            activity?.Track(UploadItem(upload, WindowsActivityState.Sending));
            try
            {
                var progress = activity is null ? null : new ByteProgress(bytes => activity.Track(UploadItem(upload,
                    bytes == upload.SizeBytes ? WindowsActivityState.Checking : WindowsActivityState.Sending, bytes: bytes)));
                upload = await uploader.TransferAsync(upload, resolver, body, progress, token);
            }
            catch (Exception error) when (error is IOException or HttpRequestException or System.ComponentModel.Win32Exception)
            {
                if (error is not WindowsUploadConflictException)
                    activity?.Track(UploadItem(upload, WindowsActivityState.Retry, "送信を中断しました。接続・保存状況を確認して自動で再試行します。"));
                throw;
            }
        }
        activity?.Track(UploadItem(upload, WindowsActivityState.Checking, "オンライン側の版を確認しています。", upload.SizeBytes));
        await FinishUploadAsync(upload, token);
    }

    private async Task RecordUploadAsync(PendingWindowsUpload upload, LocalSyncSnapshot snapshot, WindowsCatalogEntry remote, CancellationToken token)
    {
        if (activity is null) return;
        var result = upload.Result!;
        var same = false;
        if (remote.State == "present" && remote.Value is {} value && Version(remote) == result.ContentVersion
            && snapshot.RemotePosition?.Epoch == upload.Request.GetProperty("epoch").GetString()
            && value.GetProperty("folderId").ValueKind == System.Text.Json.JsonValueKind.Number
            && value.GetProperty("folderId").GetInt64() == upload.Request.GetProperty("folderId").GetInt64())
        {
            using var resolver = new CloudOriginalResolver(key, snapshot.Remote, keys);
            using var resolved = resolver.Resolve(remote);
            var metadata = resolved.Metadata;
            same = resolved.SizeBytes == upload.SizeBytes && (upload.MetadataName is null || metadata?.Name == upload.MetadataName)
                && metadata?.Extra?.TryGetValue("sha256", out var hash) == true && hash.ValueKind == System.Text.Json.JsonValueKind.String
                && string.Equals(hash.GetString(), upload.Sha256, StringComparison.OrdinalIgnoreCase);
        }
        await activity.RecordAsync(UploadItem(upload, same ? WindowsActivityState.Confirmed : WindowsActivityState.Unverified,
            same ? null : "送信は確定しましたが、一覧で同じ保存内容を確認できませんでした。オンラインの更新・移動先を確認してください。") with
        {
            ConfirmedAt = same ? DateTimeOffset.UtcNow : null, FileId = result.FileId, ContentVersion = result.ContentVersion, Sha256 = upload.Sha256
        }, token);
    }

    private static WindowsActivityItem MetadataItem(WindowsMetadataIntent intent, WindowsActivityState state, string? reason = null)
        => new("metadata:" + WindowsSyncActivity.Key(intent.Request.GetRawText()), intent.RelativePath,
            intent.Kind == "create-folder" ? WindowsActivityOperation.CreatedFolder : WindowsActivityOperation.Renamed, state,
            intent.DetectedAt ?? DateTimeOffset.UtcNow, Reason: reason, LocalId: intent.LocalFileId);

    private Task RecordMetadataAsync(WindowsMetadataIntent intent, WindowsActivityState state, CancellationToken token, string? reason = null)
        => activity?.RecordAsync(MetadataItem(intent, state, reason) with {
            ConfirmedAt = state == WindowsActivityState.Confirmed ? DateTimeOffset.UtcNow : null }, token) ?? Task.CompletedTask;

    private Task RecordRecoveryAsync(string path, string saved, string reason, CancellationToken token)
        => activity?.RecordAsync(LocalItem(path, null, WindowsActivityOperation.Updated, WindowsActivityState.Preserved, reason) with
            { Key = "recovery:" + WindowsSyncActivity.Key(Path.GetFileName(saved)) }, token) ?? Task.CompletedTask;

    private static WindowsActivityItem DownloadItem(WindowsCatalogEntry entry, string path, WindowsActivityState state, long bytes = 0, string? reason = null)
        => new($"download:{entry.Id}:{Version(entry) ?? entry.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture)}", path,
            WindowsActivityOperation.Downloaded, state, DateTimeOffset.UtcNow, entry.Value!.Value.GetProperty("sizeBytes").GetInt64(), bytes, reason,
            state == WindowsActivityState.Retained ? DateTimeOffset.UtcNow : null, FileId: entry.Id, ContentVersion: Version(entry));

    public async Task VerifyReadbackAsync(string receiptKey, IProgress<long>? progress, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime.Token);
        var ct = linked.Token;
        var row = activity?.Receipt(receiptKey);
        if (row is not { State: WindowsActivityState.Confirmed, FileId: { } id, ContentVersion: { } version, Sha256: { } expected })
            throw new IOException("照合できるオンラインの原本を確認してから再試行してください。");
        try { await VerifyContentAsync(row, id, version, expected, progress, ct); }
        catch (Exception error) when (error is IOException or InvalidDataException or HttpRequestException or CryptographicException or UnauthorizedAccessException)
        {
            var reason = error is IOException or InvalidDataException ? error.Message : "原本を読み戻せませんでした。接続と原本の状態を確認してください。";
            await activity!.RecordReadbackAsync(row, reason, ct);
            throw;
        }
        await activity!.RecordReadbackAsync(row, null, ct);
    }

    private async Task VerifyContentAsync(WindowsActivityItem row, long id, string version, string expected, IProgress<long>? progress, CancellationToken ct)
    {
        if (!catalogOnline) throw new IOException("オンラインの接続が復帰してから再試行してください。");
        root.VerifyPresent();
        var snapshot = await catalog.LoadAsync(ct);
        var entry = snapshot.Remote.SingleOrDefault(item => item.Kind == "file" && item.Id == id && item.State == "present" && Version(item) == version)
            ?? throw new IOException("この履歴の原本は現在のオンライン一覧で取得できません。");
        using var readerKey = WindowsPrivateKey.Open(registration.DataKeyId);
        using var resolver = new CloudOriginalResolver(readerKey, snapshot.Remote, keys);
        using var original = resolver.Resolve(entry);
        if (original.Layout is not {} layout || original.SizeBytes != row.Size) throw new InvalidDataException("読み戻した原本の版を確認できません。");
        var source = new CloudContentSource(device, id, original.StoredBytes, entry.Revision);
        await using var reader = new EncryptedFileReader(layout, original.FileKey!, source, prefetch: true);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[(int)Math.Min(layout.SizeBytes, 1024 * 1024)];
        try
        {
            for (long offset = 0; offset < layout.SizeBytes;)
            {
                ct.ThrowIfCancellationRequested();
                var count = (int)Math.Min(buffer.Length, layout.SizeBytes - offset);
                if (await reader.ReadAsync(offset, buffer.AsMemory(0, count), ct) != count) throw new EndOfStreamException("原本の読み戻しが途中で終了しました。");
                hash.AppendData(buffer, 0, count);
                offset += count;
                progress?.Report(offset);
            }
            if (!Convert.ToHexString(hash.GetHashAndReset()).Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("読み戻した原本の内容が、送信時の内容と一致しません。");
        }
        finally { CryptographicOperations.ZeroMemory(buffer); }
    }

    private sealed class ByteProgress(Action<long> report) : IProgress<long>
    { public void Report(long value) => report(value); }
}

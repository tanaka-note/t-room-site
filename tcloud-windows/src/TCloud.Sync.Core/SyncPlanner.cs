namespace TCloud.Sync.Core;

public enum SyncAction { None, Pause, UpdatePlaceholder, Download, UploadNew, UploadRevision, Move, ConflictCopy, RejectLocalDelete, RecycleLocal, PreserveDeletedEdit }
public enum RemoteState { Present, Trashed, Unknown }

public sealed record VolumeBinding(string GuidPath, uint SerialNumber, string RelativeRoot);
public sealed record SessionState(bool Verified, DateTimeOffset ExpiresAt)
{
    public bool IsActive(DateTimeOffset now) => Verified && ExpiresAt > now;
}
public sealed record LocalState(bool Exists, bool Dirty, bool UserDeleteConfirmed, bool Opened, bool Pinned,
    string? ContentHash, string? RelativePath, bool HasContent = false);
public sealed record RemoteEntry(string Id, long Revision, RemoteState State, string RelativePath, string ContentVersion);
public sealed record SyncBaseline(string Id, long Revision, string RelativePath, string? ContentHash, string ContentVersion);
public sealed record SyncDecision(SyncAction Action, string Reason);

/// <summary>Pure decisions; filesystem absence and an incomplete listing never establish deletion.</summary>
public static class SyncPlanner
{
    public static SyncDecision Decide(SyncBaseline? baseline, LocalState local, RemoteEntry? remote,
        bool expectedVolumePresent, bool remoteSnapshotComplete, SessionState session, DateTimeOffset now)
    {
        if (!expectedVolumePresent) return new(SyncAction.Pause, "保存先の接続を待っています。");
        if (!session.IsActive(now)) return new(SyncAction.Pause, "ログインの確認を待っています。");
        if (remote is null || remote.State == RemoteState.Unknown || !remoteSnapshotComplete)
            return new(SyncAction.Pause, "オンラインの状態を確認できません。");
        if (baseline is not null && !StringComparer.Ordinal.Equals(baseline.Id, remote.Id))
            return new(SyncAction.Pause, "ファイルの識別情報が一致しません。");
        if (baseline is not null && remote.Revision < baseline.Revision)
            return new(SyncAction.Pause, "オンラインの版を再確認します。");
        if (remote.State == RemoteState.Trashed)
            return new(local.Exists ? (local.Dirty ? SyncAction.PreserveDeletedEdit : SyncAction.RecycleLocal) : SyncAction.None,
                "オンラインのゴミ箱への移動を反映します。再アップロードしません。");
        var remoteChanged = baseline is not null && remote.Revision != baseline.Revision;
        // Legacy callers may still report a confirmed delete. It must never delete the online original.
        if (local.UserDeleteConfirmed && local.Exists)
            return new(SyncAction.RejectLocalDelete, "削除はT-CloudのWeb画面から行ってください。");
        if (!local.Exists)
            return new(local.Dirty ? SyncAction.Pause : SyncAction.Download,
                local.Dirty ? "未送信の編集の所在を確認します。" : "オンラインの原本を取得します。オンラインは削除しません。");
        if (baseline is null) return new(SyncAction.ConflictCopy, "同じ場所のオンラインファイルと追加ファイルを保全します。");
        var pathChanged = !StringComparer.Ordinal.Equals(local.RelativePath, baseline.RelativePath);
        if ((local.Dirty || pathChanged) && remoteChanged)
            return new(SyncAction.ConflictCopy, "両端末の変更を保全します。");
        if (local.Dirty) return new(SyncAction.UploadRevision, "内容の新しい版を送信します。");
        if (pathChanged) return new(SyncAction.Move, "名前または移動先を反映します。");
        if (!local.HasContent) return new(SyncAction.Download, "オフライン保存用の原本を取得します。");
        if (remoteChanged)
        {
            var contentChanged = !StringComparer.Ordinal.Equals(remote.ContentVersion, baseline.ContentVersion);
            return new(contentChanged
                ? SyncAction.Download : SyncAction.UpdatePlaceholder, "オンラインの新しい版を反映します。");
        }
        return new(SyncAction.None, "同期済みです。");
    }

    public static SyncDecision NewLocalFile(bool expectedVolumePresent, bool stableWriteCompleted,
        SessionState session, DateTimeOffset now) => !expectedVolumePresent || !session.IsActive(now) || !stableWriteCompleted
        ? new(SyncAction.Pause, "接続・認証・保存完了を待っています。")
        : new(SyncAction.UploadNew, "新しいファイルを送信します。");
}

using System.Security.Cryptography;
using System.Text;

namespace TCloud.Sync.Windows;

public enum WindowsActivityOperation { Added, Updated, Renamed, CreatedFolder, Downloaded, Existing }
public enum WindowsActivityState { Waiting, Queued, Sending, Checking, Confirmed, Retry, Attention, Preserved, Listed, Receiving, Retained, Unverified }

public sealed record WindowsActivityItem(string Key, string RelativePath, WindowsActivityOperation Operation,
    WindowsActivityState State, DateTimeOffset DetectedAt, long? Size = null, long Bytes = 0, string? Reason = null,
    DateTimeOffset? ConfirmedAt = null, long? FileId = null, string? ContentVersion = null, string? Sha256 = null,
    DateTimeOffset? ReadbackAt = null, long LocalId = 0, long LocalUsn = 0, string? PreservedPath = null,
    DateTimeOffset? ReadbackFailedAt = null, string? ReadbackFailure = null);

public sealed record WindowsActivitySnapshot(long Version, WindowsActivityItem[] Uploads, WindowsActivityItem[] Downloads,
    DateTimeOffset? LastCheckedAt, bool Current, string? Notice);

/// <summary>Separates current observations from durable receipts for specific saved versions.</summary>
public sealed class WindowsSyncActivity
{
    private readonly string directory;
    private readonly object gate = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly Dictionary<string, WindowsActivityItem> receipts = new(StringComparer.Ordinal);
    private readonly HashSet<(long?, string?)> unverifiedUploads = [];
    private readonly Dictionary<string, WindowsActivityItem> operations = new(StringComparer.Ordinal);
    private Dictionary<string, WindowsActivityItem> observed = new(StringComparer.Ordinal);
    private Dictionary<string, WindowsActivityItem> downloads = new(StringComparer.Ordinal);
    private DateTimeOffset? lastChecked;
    private bool current;
    private long version;
    private string? notice;

    public WindowsSyncActivity(string pcDirectory, WindowsDeviceRegistration registration)
    {
        var volume = registration.Volume;
        var binding = Key($"{registration.DeviceId}\n{registration.ScopeHash}\n{volume.GuidPath}\n{volume.SerialNumber}\n{volume.RelativeRoot}\n{registration.RootFileId}");
        directory = Path.Combine(Path.GetFullPath(pcDirectory), "activity", binding);
    }

    public async Task LoadAsync(CancellationToken token)
    {
        WindowsAtomicState.Check(Path.Combine(directory, "last-check.json"));
        if (!Directory.Exists(directory)) return;
        var history = new List<WindowsActivityItem>();
        foreach (var path in Directory.EnumerateFiles(directory, "receipt-*.json"))
        {
            var row = await WindowsAtomicState.LoadAsync<WindowsActivityItem>(path, token);
            if (row is null) continue;
            if (Path.GetFileName(path) != Path.GetFileName(ReceiptPath(row.Key)) || string.IsNullOrWhiteSpace(row.RelativePath)
                || row.State is not (WindowsActivityState.Confirmed or WindowsActivityState.Preserved or WindowsActivityState.Unverified))
                throw new InvalidDataException("同期履歴を読み取れません。");
            history.Add(row);
        }
        var check = await WindowsAtomicState.LoadAsync<DateTimeOffset?>(Path.Combine(directory, "last-check.json"), token);
        lock (gate)
        {
            foreach (var row in history) AddReceipt(row);
            lastChecked = check;
            version++;
        }
    }

    public WindowsActivitySnapshot? Snapshot(long afterVersion = -1)
    {
        lock (gate)
        {
            if (afterVersion == version) return null;
            var activePaths = operations.Values.ToLookup(r => r.RelativePath, StringComparer.OrdinalIgnoreCase);
            var queue = observed.Values.Where(row => !activePaths[row.RelativePath].Any(active =>
                row.LocalId == active.LocalId && (row.LocalUsn == 0 || active.LocalUsn == 0 || row.LocalUsn == active.LocalUsn)));
            var sent = receipts.Values.Where(row => row.FileId is not null).Select(row => (row.FileId, row.ContentVersion)).ToHashSet();
            var existing = downloads.Values.Where(row => row.State == WindowsActivityState.Retained && !sent.Contains((row.FileId, row.ContentVersion)))
                .Select(row => row with { Key = "existing:" + row.Key, Operation = WindowsActivityOperation.Existing, State = WindowsActivityState.Confirmed,
                    Reason = "HDDとオンラインの現在の内容版を照合しました。送信日時を示す履歴はありません。" });
            return new(version, [.. queue, .. operations.Values, .. receipts.Values, .. existing], [.. downloads.Values], lastChecked, current, notice);
        }
    }

    public void Invalidate(string? message = null)
    {
        lock (gate)
        {
            if (!current && (message is null || message == notice)) return;
            current = false;
            if (message is not null) notice = message;
            version++;
        }
    }

    internal async Task CheckedAsync(Func<bool> stillCurrent, string? message, CancellationToken token)
    {
        if (!stillCurrent()) return;
        var now = DateTimeOffset.UtcNow;
        await WindowsAtomicState.SaveAsync(Path.Combine(directory, "last-check.json"), now, token);
        lock (gate)
        {
            lastChecked = now;
            current = stillCurrent();
            notice = message;
            version++;
        }
    }

    internal void Observe(IEnumerable<WindowsActivityItem> rows)
    {
        lock (gate)
        {
            observed = rows.ToDictionary(row => row.Key, row => observed.TryGetValue(row.Key, out var previous)
                ? row with { DetectedAt = previous.DetectedAt } : row, StringComparer.Ordinal);
            version++;
        }
    }

    internal void SetDownloads(IEnumerable<WindowsActivityItem> rows, bool keepSameVersion = false)
    {
        lock (gate)
        {
            downloads = rows.ToDictionary(row => row.Key, row => downloads.TryGetValue(row.Key, out var old)
                ? keepSameVersion ? old with { RelativePath = row.RelativePath }
                    : row with { DetectedAt = old.DetectedAt, ConfirmedAt = row.ConfirmedAt is null ? null : old.ConfirmedAt ?? row.ConfirmedAt } : row,
                StringComparer.Ordinal);
            version++;
        }
    }

    internal void DownloadProgress(WindowsActivityItem row)
    {
        lock (gate)
        {
            if (!downloads.TryGetValue(row.Key, out var old)) return;
            row = row with { DetectedAt = old.DetectedAt };
            downloads[row.Key] = row;
            version++;
        }
    }

    internal void Track(WindowsActivityItem row)
    {
        lock (gate)
        {
            if (receipts.ContainsKey(row.Key)) return;
            var detected = operations.GetValueOrDefault(row.Key)?.DetectedAt ?? observed.Values.FirstOrDefault(item =>
                item.LocalId != 0 && item.LocalId == row.LocalId && item.RelativePath.Equals(row.RelativePath, StringComparison.OrdinalIgnoreCase))?.DetectedAt;
            operations[row.Key] = row with { DetectedAt = detected ?? row.DetectedAt };
            version++;
        }
    }

    internal void BlockObserved(WindowsActivityItem item)
    {
        lock (gate)
        {
            var detected = observed.GetValueOrDefault(item.Key)?.DetectedAt ?? item.DetectedAt;
            observed[item.Key] = item with { DetectedAt = detected };
            version++;
        }
    }

    internal async Task RecordAsync(WindowsActivityItem row, CancellationToken token)
    {
        await writes.WaitAsync(token);
        try
        {
            lock (gate)
            {
                if (receipts.ContainsKey(row.Key)) return;
                var detected = operations.GetValueOrDefault(row.Key)?.DetectedAt;
                if (detected is not null) row = row with { DetectedAt = detected.Value };
            }
            await WindowsAtomicState.SaveAsync(ReceiptPath(row.Key), row, token);
            lock (gate)
            {
                AddReceipt(row);
                operations.Remove(row.Key);
                foreach (var key in observed.Where(pair => pair.Value.RelativePath.Equals(row.RelativePath, StringComparison.OrdinalIgnoreCase)
                    && pair.Value.LocalId == row.LocalId && (pair.Value.LocalUsn == 0 || pair.Value.LocalUsn == row.LocalUsn)).Select(pair => pair.Key).ToArray())
                    observed.Remove(key);
                version++;
            }
        }
        finally { writes.Release(); }
    }

    internal async Task RecordReadbackAsync(WindowsActivityItem row, string? failure, CancellationToken token)
    {
        await writes.WaitAsync(token);
        try
        {
            lock (gate) row = receipts[row.Key];
            var now = DateTimeOffset.UtcNow;
            row = failure is null ? row with { ReadbackAt = now, ReadbackFailedAt = null, ReadbackFailure = null }
                : row with { ReadbackFailedAt = now, ReadbackFailure = failure };
            await WindowsAtomicState.SaveAsync(ReceiptPath(row.Key), row, token);
            lock (gate) { receipts[row.Key] = row; version++; }
        }
        finally { writes.Release(); }
    }

    internal WindowsActivityItem? Receipt(string key)
    { lock (gate) return receipts.GetValueOrDefault(key); }

    internal DateTimeOffset? FirstSeen(string key)
    { lock (gate) return observed.GetValueOrDefault(key)?.DetectedAt; }

    internal bool UploadUnverified(long id, string? version)
    { lock (gate) return unverifiedUploads.Contains((id, version)); }

    private void AddReceipt(WindowsActivityItem row)
    {
        receipts[row.Key] = row;
        if (row is { State: WindowsActivityState.Unverified, FileId: not null }) unverifiedUploads.Add((row.FileId, row.ContentVersion));
    }

    private string ReceiptPath(string key) => Path.Combine(directory, "receipt-" + Key(key) + ".json");
    internal static string Key(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

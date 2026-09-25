using System.Text.Json;

namespace Tlain.Downloader2.Core;

public sealed class HistoryStore(string? directory = null)
{
    private readonly string file = Path.Combine(directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tlain", "Downloader2"), "history.json");
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public async Task<IReadOnlyList<HistoryItem>> ListAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { return await ReadUnsafeAsync(cancellationToken).ConfigureAwait(false); }
        finally { gate.Release(); }
    }

    public async Task AddAsync(HistoryItem item, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var items = (await ReadUnsafeAsync(cancellationToken).ConfigureAwait(false)).Prepend(item).Take(100).ToArray();
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temporary = file + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(items, Json), cancellationToken).ConfigureAwait(false);
            File.Move(temporary, file, true);
        }
        finally { gate.Release(); }
    }

    private async Task<IReadOnlyList<HistoryItem>> ReadUnsafeAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(file)) return [];
        try { return JsonSerializer.Deserialize<HistoryItem[]>(await File.ReadAllTextAsync(file, cancellationToken).ConfigureAwait(false), Json) ?? []; }
        catch (JsonException) { return []; }
    }
}

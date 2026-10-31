using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

var tests = new List<(string Name, Func<Task> Run)>
{
    ("browser encryption interoperates in both directions", BrowserCrypto),
    ("ciphertext integrity and chunk identity are authenticated", Integrity),
    ("random reads cross encrypted chunks and stop at EOF", Ranges),
    ("disk absence and missing listings never delete online files", MissingIsNotDeletion),
    ("explicit deletion uses trash; racing edits preserve both", DeletionAndConflicts),
    ("remote deletion cannot resurrect an offline edit", RemoteDeletion),
    ("authentication expiry and incomplete writes pause transfers", Authentication),
    ("transfer journal survives restart and isolates account and disk", Journal),
    ("paths cannot escape sync root or address alternate streams", Paths),
    ("destination inspection is read-only and rejects overlapping roots", Destination)
};
if (args.Contains("--native")) tests.Add(("real Windows placeholders hydrate on demand with random seeks", NativeHydration));
var failed = 0;
foreach (var (name, run) in tests)
{
    try { await run(); Console.WriteLine("PASS " + name); }
    catch (Exception error) { failed++; Console.Error.WriteLine($"FAIL {name}: {error.GetType().Name}: {error.Message}"); }
}
return failed == 0 ? 0 : 1;

static async Task BrowserCrypto()
{
    var key = RandomNumberGenerator.GetBytes(32);
    var plain = RandomNumberGenerator.GetBytes(32791);
    try
    {
        var envelope = EncryptedChunks.Encrypt(key, plain, 37);
        var psi = new ProcessStartInfo("node") { RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        psi.ArgumentList.Add(Path.Combine(RepositoryRoot(), "tcloud-windows", "tests", "webcrypto-interop.mjs"));
        using var process = Process.Start(psi) ?? throw new Exception("Could not start interop fixture");
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(new { key = Convert.ToBase64String(key),
            plain = Convert.ToBase64String(plain), envelope = Convert.ToBase64String(envelope), index = 37 }));
        process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch { process.Kill(entireProcessTree: true); throw; }
        // The child must never echo its input or key, even on failure.
        if (process.ExitCode != 0) throw new Exception("Browser crypto fixture failed: " + (await errorTask).Split('\n')[0]);
        using var response = JsonDocument.Parse(await outputTask);
        Check(plain.AsSpan().SequenceEqual(Convert.FromBase64String(response.RootElement.GetProperty("plain").GetString()!)), "C# to browser");
        var browserEnvelope = Convert.FromBase64String(response.RootElement.GetProperty("envelope").GetString()!);
        Check(plain.AsSpan().SequenceEqual(EncryptedChunks.Decrypt(key, browserEnvelope, 37)), "browser to C#");
    }
    finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(plain); }
}

static Task Integrity()
{
    var key = RandomNumberGenerator.GetBytes(32);
    try
    {
        var envelope = EncryptedChunks.Encrypt(key, "fixture"u8, 0);
        Throws<CryptographicException>(() => EncryptedChunks.Decrypt(key, envelope, 1));
        envelope[^1] ^= 1;
        Throws<CryptographicException>(() => EncryptedChunks.Decrypt(key, envelope, 0));
        Throws<ArgumentOutOfRangeException>(() => EncryptedChunks.Encrypt(key, [], 10000));
        Throws<CryptographicException>(() => EncryptedChunks.Decrypt(key, new byte[20], 0));
        Check(EncryptedChunks.Decrypt(key, EncryptedChunks.Encrypt(key, [], 0), 0).Length == 0, "empty chunk");
    }
    finally { CryptographicOperations.ZeroMemory(key); }
    return Task.CompletedTask;
}

static Task Ranges()
{
    var slices = ChunkRanges.ForRead(20000, 8192, 8100, 10000);
    Check(slices.Count == 3 && slices.Sum(s => s.PlainLength) == 10000, "cross-chunk request");
    Check(slices[0].PlainOffset == 8100 && slices[0].PlainLength == 92, "first boundary");
    Check(slices[1].EncryptedOffset == 8224 && slices[1].EncryptedLength == 8224, "envelope offsets");
    Check(slices[2].EncryptedOffset == 16448 && slices[2].EncryptedLength == 3648, "last envelope");
    Check(ChunkRanges.ForRead(20000, 8192, 19900, 200).Single().PlainLength == 100, "EOF clamp");
    Check(ChunkRanges.ForRead(0, 8192, 0, 5).Count == 0, "empty file");
    Throws<ArgumentOutOfRangeException>(() => ChunkRanges.ForRead(1, 8192, -1, 1));
    return Task.CompletedTask;
}

static DateTimeOffset Now() => DateTimeOffset.UtcNow;
static SessionState Session() => new(true, Now().AddHours(1));
static SyncBaseline Baseline() => new("file-1", 5, "folder/video.mp4", "hash", "content-1");
static LocalState Local() => new(true, false, false, false, false, "hash", "folder/video.mp4", HasContent: true);
static RemoteEntry Remote() => new("file-1", 5, RemoteState.Present, "folder/video.mp4", "content-1");
static SyncAction Plan(LocalState local, RemoteEntry? remote, bool volume = true, bool complete = true,
    SessionState? session = null) => SyncPlanner.Decide(Baseline(), local, remote, volume, complete, session ?? Session(), Now()).Action;

static Task MissingIsNotDeletion()
{
    Check(Plan(Local() with { Exists = false }, Remote()) == SyncAction.UpdatePlaceholder, "unhydrated is not deletion");
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, Remote(), volume: false) == SyncAction.Pause, "unplug never trashes");
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, null) == SyncAction.Pause, "missing remote not trash");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote(), complete: false) == SyncAction.Pause, "incomplete listing");
    Check(Plan(Local() with { Exists = false, Pinned = true }, Remote()) == SyncAction.Download, "offline request");
    Check(Plan(Local() with { HasContent = false }, Remote() with { Revision = 6, ContentVersion = "content-2" })
        == SyncAction.UpdatePlaceholder, "unopened remote content update must not download the body");
    Check(Plan(Local(), Remote() with { Revision = 6, RelativePath = "renamed.mp4" })
        == SyncAction.UpdatePlaceholder, "metadata-only rename must not redownload cached content");
    Check(Plan(Local(), Remote() with { Revision = 6, ContentVersion = "content-2" })
        == SyncAction.Download, "cached content update");
    return Task.CompletedTask;
}

static Task DeletionAndConflicts()
{
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, Remote()) == SyncAction.TrashRemote, "explicit delete is soft trash");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote() with { Revision = 6 }) == SyncAction.ConflictCopy, "delete/update race");
    Check(Plan(Local() with { Dirty = true }, Remote() with { Revision = 6 }) == SyncAction.ConflictCopy, "edit/edit race");
    Check(Plan(Local() with { RelativePath = "folder/renamed.mp4" }, Remote() with { Revision = 6 }) == SyncAction.ConflictCopy, "rename/edit race");
    Check(Plan(Local() with { Dirty = true }, Remote()) == SyncAction.UploadRevision, "edit");
    Check(Plan(Local() with { RelativePath = "folder/renamed.mp4" }, Remote()) == SyncAction.Move, "rename");
    Check(Plan(Local(), Remote() with { Id = "other-file" }) == SyncAction.Pause, "identity mismatch");
    Check(Plan(Local(), Remote() with { Revision = 4 }) == SyncAction.Pause, "stale revision");
    return Task.CompletedTask;
}

static Task RemoteDeletion()
{
    var deleted = Remote() with { State = RemoteState.Trashed, Revision = 6 };
    Check(Plan(Local(), deleted) == SyncAction.RecycleLocal, "remote trash");
    Check(Plan(Local() with { Dirty = true }, deleted) == SyncAction.PreserveDeletedEdit, "retain unsent change separately");
    Check(Plan(Local() with { Exists = false }, deleted) == SyncAction.None, "never resurrect");
    return Task.CompletedTask;
}

static Task Authentication()
{
    Check(Plan(Local() with { Dirty = true }, Remote(), session: new(false, Now().AddHours(1))) == SyncAction.Pause, "unverified session");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote(), session: new(true, Now().AddSeconds(-1))) == SyncAction.Pause, "expired deletion");
    Check(SyncPlanner.NewLocalFile(true, false, Session(), Now()).Action == SyncAction.Pause, "unfinished file");
    Check(SyncPlanner.NewLocalFile(true, true, Session(), Now()).Action == SyncAction.UploadNew, "new stable file");
    return Task.CompletedTask;
}

static async Task Journal()
{
    var folder = NewTemp();
    try
    {
        var path = Path.Combine(folder, "state.json");
        var binding = new VolumeBinding("fixture-volume", 42, "T-Cloud");
        var entry = new PendingTransfer("operation-1", "file-1", TransferKind.TrashRemote, 5, "folder/video.mp4", Now());
        var snapshot = new JournalSnapshot(1, "account-scope", binding, "cursor-10", [entry]);
        await new TransferJournal(path).SaveAsync(snapshot);
        var loaded = await new TransferJournal(path).LoadAsync("account-scope", binding);
        Check(loaded?.Pending.Single() == entry && loaded.RemoteCursor == "cursor-10", "restart");
        await ThrowsAsync<InvalidDataException>(() => new TransferJournal(path).LoadAsync("another-account", binding));
        await ThrowsAsync<InvalidDataException>(() => new TransferJournal(path).LoadAsync("account-scope", binding with { SerialNumber = 43 }));
        await ThrowsAsync<InvalidDataException>(() => new TransferJournal(path).SaveAsync(snapshot with { Pending = [entry, entry] }));
        var before = await File.ReadAllTextAsync(path);
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        await ThrowsAsync<OperationCanceledException>(() => new TransferJournal(path).SaveAsync(snapshot with { RemoteCursor = "bad" }, cancel.Token));
        Check(await File.ReadAllTextAsync(path) == before, "cancel preserves durable snapshot");
        var contract = typeof(JournalSnapshot).GetProperties().Select(p => p.Name).Concat(typeof(PendingTransfer).GetProperties().Select(p => p.Name));
        Check(!contract.Any(name => new[] { "Key", "Cookie", "Password", "Token", "Prf" }.Any(secret => name.Contains(secret, StringComparison.OrdinalIgnoreCase))), "secret-free journal contract");
    }
    finally { Directory.Delete(folder, true); }
}

static Task Paths()
{
    var root = NewTemp();
    try
    {
        foreach (var path in new[] { "../outside", "folder/../../outside", "C:\\outside", "folder/file:stream", "folder//file", "\\\\server\\share" })
            Throws<ArgumentException>(() => LocalPaths.ResolveUnderRoot(root, path));
        Check(LocalPaths.ResolveUnderRoot(root, "folder/file.txt").StartsWith(root, StringComparison.Ordinal), "normal child");
        Check(LocalPaths.EncodeName("CON.txt") == "~0043ON.txt", "reserved device");
        Check(LocalPaths.EncodeName("bad:name?.txt") == "bad~003Aname~003F.txt", "invalid characters");
        Check(LocalPaths.EncodeName("~003A") == "~007E003A", "escape marker cannot collide");
    }
    finally { Directory.Delete(root); }
    return Task.CompletedTask;
}

static Task Destination()
{
    var root = Path.Combine(Path.GetTempPath(), "tcloud-inspection-" + Guid.NewGuid().ToString("N"));
    var volume = VolumeInspector.Inspect(Path.GetTempPath());
    Check(volume.Supported, "NTFS test volume");
    var binding = VolumeInspector.ValidateDestination(root, []);
    Check(!Directory.Exists(root), "inspection created no destination");
    Check(VolumeInspector.IsExpectedVolumePresent(root, binding), "correct volume");
    Check(!VolumeInspector.IsExpectedVolumePresent(root, binding with { SerialNumber = binding.SerialNumber ^ 1 }), "different disk");
    Throws<IOException>(() => VolumeInspector.ValidateDestination(volume.MountPoint, []));
    Throws<IOException>(() => VolumeInspector.ValidateDestination(root, [Path.GetTempPath()]));
    Throws<IOException>(() => VolumeInspector.ValidateDestination(Path.GetTempPath(), [root]));
    return Task.CompletedTask;
}

static async Task NativeHydration()
{
    using var fixture = CloudFilesFixture.Create();
    var plain = RandomNumberGenerator.GetBytes(3 * 1024 * 1024 + 107);
    try
    {
        fixture.Add("fixture.bin", plain);
        var path = Path.Combine(fixture.Root, "fixture.bin");
        Check(new FileInfo(path).Length == plain.Length, "logical size before hydration");
        await using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096, FileOptions.Asynchronous | FileOptions.RandomAccess))
        {
            foreach (var offset in new long[] { plain.Length - 1107, 8191, 1024 * 1024 + 3, 0 })
            {
                stream.Position = offset;
                var buffer = new byte[1000];
                await stream.ReadExactlyAsync(buffer);
                Check(buffer.AsSpan().SequenceEqual(plain.AsSpan((int)offset, buffer.Length)), "random seek content");
            }
        }
        Check((await File.ReadAllBytesAsync(path)).AsSpan().SequenceEqual(plain), "complete hydration");
        Check(fixture.FetchCount > 0, "native fetch callback actually ran");
        Check(fixture.Errors.IsEmpty, "provider callback errors");
    }
    finally { CryptographicOperations.ZeroMemory(plain); }
}

static string RepositoryRoot()
{
    for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        if (File.Exists(Path.Combine(directory.FullName, "cloud-worker", "public", "crypto-vault.js"))) return directory.FullName;
    throw new DirectoryNotFoundException("Repository root not found");
}
static string NewTemp() { var path = Path.Combine(Path.GetTempPath(), "tcloud-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); return path; }
static void Check(bool value, string label) { if (!value) throw new Exception(label); }
static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception { try { await action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }

using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

if (args.Length == 2 && args[0] == "--hydrate-fixture")
{
    await HydrationProbe.RunClientAsync(args[1]);
    return 0;
}

if (args.Contains("--key-probe"))
{
    await NativePrivateKey();
    await NativeAccountProtection();
    await AdministratorPublicKey();
    await NativePasskeyEnvelope();
    Console.WriteLine("PASS Windows key and cookie protection");
    return 0;
}

if (args.Length == 2 && args[0] == "--inspect-shell-path")
{
    ShellFolderProbe.InspectPath(args[1]);
    return 0;
}

if (args.Contains("--folder-view-probe"))
{
    ShellFolderProbe.Run(args.Contains("--class-suffix"), args.Contains("--office"), args.Contains("--hold-for-ui"), args.Contains("--host-view"));
    return 0;
}

if (args.Contains("--compatibility-probe"))
{
    CompatibilityProbe.Run(args.Contains("--office"));
    return 0;
}

var tests = new List<(string Name, Func<Task> Run)>
{
    ("browser encryption interoperates in both directions", BrowserCrypto),
    ("ciphertext integrity and chunk identity are authenticated", Integrity),
    ("random reads cross encrypted chunks and stop at EOF", Ranges),
    ("Cloud Files transfer ranges satisfy native alignment and EOF requirements", NativeTransferRanges),
    ("disk absence and missing listings never delete online files", MissingIsNotDeletion),
    ("local deletion never deletes online; racing edits preserve both", DeletionAndConflicts),
    ("remote deletion cannot resurrect an offline edit", RemoteDeletion),
    ("authentication expiry and incomplete writes pause transfers", Authentication),
    ("transfer journal survives restart and isolates account and disk", Journal),
    ("paths cannot escape sync root or address alternate streams", Paths),
    ("destination inspection is read-only and rejects overlapping roots", Destination),
    ("native passkey requests preserve RP, required verification and credential PRF inputs", PasskeyRequests),
    ("administrator public keys use the current authenticated Cloud config endpoint", AdministratorPublicKey)
};
if (args.Contains("--native"))
{
    tests.Add(("real Windows placeholders hydrate on demand with random seeks", NativeHydration));
    tests.Add(("real Windows deletion requests can be rejected without losing the file", NativeDeleteVeto));
    tests.Add(("application file replacement retains its saved body after Cloud Files conversion", NativeReplacementConversion));
    tests.Add(("persisted Windows RSA keys decrypt but cannot export private material or sign", NativePrivateKey));
    tests.Add(("DPAPI session protection rejects modified cookies and another session binding", NativeAccountProtection));
    tests.Add(("browser PRF envelopes unlock existing member and administrator keys in Windows", NativePasskeyEnvelope));
}
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

static Task NativeTransferRanges()
{
    Check(CloudFilesRange.ForRequest(20000, 8100, 100) == new CloudFilesRange(4096, 8192), "unaligned request spans native pages");
    Check(CloudFilesRange.ForRequest(20000, 8192, 4096) == new CloudFilesRange(8192, 4096), "aligned request");
    Check(CloudFilesRange.ForRequest(20000, 19990, 100) == new CloudFilesRange(16384, 3616), "EOF clips overshoot");
    Check(CloudFilesRange.ForRequest(20000, 8193, -1) == new CloudFilesRange(8192, 11808), "CF_EOF sentinel");
    var large = CloudFilesRange.ForRequest(long.MaxValue, long.MaxValue - 10, 100);
    Check(large.Offset % 4096 == 0 && large.Offset + large.Length == long.MaxValue, "no overflow near maximum size");
    Throws<ArgumentOutOfRangeException>(() => CloudFilesRange.ForRequest(0, 0, 1));
    Throws<ArgumentOutOfRangeException>(() => CloudFilesRange.ForRequest(10, 10, 1));
    Throws<ArgumentOutOfRangeException>(() => CloudFilesRange.ForRequest(10, 0, 0));
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
    Check(Plan(Local() with { Exists = false }, Remote()) == SyncAction.Download, "missing original downloads without online deletion");
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, Remote(), volume: false) == SyncAction.Pause, "unplug never trashes");
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, null) == SyncAction.Pause, "missing remote not trash");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote(), complete: false) == SyncAction.Pause, "incomplete listing");
    Check(Plan(Local() with { Exists = false, Pinned = true }, Remote()) == SyncAction.Download, "offline request");
    Check(Plan(Local() with { HasContent = false }, Remote() with { Revision = 6, ContentVersion = "content-2" })
        == SyncAction.Download, "unopened originals are also downloaded");
    Check(Plan(Local() with { HasContent = false }, Remote()) == SyncAction.Download, "unchanged placeholder still downloads");
    Check(Plan(Local() with { Exists = false, Dirty = true }, Remote()) == SyncAction.Pause, "missing unsent edit is investigated");
    Check(Plan(Local(), Remote() with { Revision = 6, RelativePath = "renamed.mp4" })
        == SyncAction.UpdatePlaceholder, "metadata-only rename must not redownload cached content");
    Check(Plan(Local(), Remote() with { Revision = 6, ContentVersion = "content-2" })
        == SyncAction.Download, "cached content update");
    return Task.CompletedTask;
}

static Task DeletionAndConflicts()
{
    Check(Plan(Local() with { Exists = false, UserDeleteConfirmed = true }, Remote()) == SyncAction.Download, "legacy explicit delete restores online original");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote()) == SyncAction.RejectLocalDelete, "delete is rejected");
    Check(Plan(Local() with { UserDeleteConfirmed = true }, Remote() with { Revision = 6 }) == SyncAction.RejectLocalDelete, "delete remains rejected during remote update");
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
    Check(Plan(Local(), deleted with { Revision = 4 }) == SyncAction.Pause, "stale tombstone cannot remove a newer original");
    Check(Plan(Local() with { Dirty = true }, deleted with { Revision = 4 }) == SyncAction.Pause, "stale tombstone cannot displace an edit");
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
        var entry = new PendingTransfer("operation-1", "file-1", TransferKind.UploadRevision, 5, "folder/video.mp4", Now());
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
        var legacy = snapshot with { Pending = [entry with { Kind = TransferKind.LegacyTrashRemote }] };
        await ThrowsAsync<InvalidDataException>(() => new TransferJournal(path).SaveAsync(legacy));
        Check(await File.ReadAllTextAsync(path) == before, "legacy deletion cannot replace a valid journal");
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(legacy));
        await ThrowsAsync<InvalidDataException>(() => new TransferJournal(path).LoadAsync("account-scope", binding));
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
    // Hydration overlaps the filter's background fetches; repeat on fresh placeholders
    // to expose failures that depend on which request finishes first.
    for (var iteration = 0; iteration < 3; iteration++) await NativeHydrationOnce();
}

static async Task NativeHydrationOnce()
{
    using var fixture = CloudFilesFixture.Create();
    var plain = RandomNumberGenerator.GetBytes(3 * 1024 * 1024 + 107);
    try
    {
        fixture.Add("fixture.bin", plain);
        var path = Path.Combine(fixture.Root, "fixture.bin");
        Check(new FileInfo(path).Length == plain.Length, "logical size before hydration");
        var result = await HydrationProbe.ReadAsync(path, plain);
        Check(result.Succeeded, $"consumer {result.Stage} failed with 0x{result.HResult:X8}; provider errors: "
            + string.Join(",", fixture.Errors.Select(error => $"0x{error.HResult:X8}"))
            + "; fetch trace: " + string.Join(" | ", fixture.FetchDiagnostics));
        Check(fixture.FetchCount > 0, "native fetch callback actually ran");
        Check(NativeReadProbe.ReadHead(path).AsSpan().SequenceEqual(plain.AsSpan(0, 1000)), "event-based overlapped read matches");
        Check(fixture.Errors.IsEmpty, "provider callback errors");
    }
    finally { CryptographicOperations.ZeroMemory(plain); }
}

static async Task NativeDeleteVeto()
{
    using var fixture = CloudFilesFixture.Create(denyDeletes: true);
    fixture.Add("protected.txt", "fixture"u8);
    var path = Path.Combine(fixture.Root, "protected.txt");
    _ = await File.ReadAllBytesAsync(path);
    var result = FixtureClient.Run($"[System.IO.File]::Delete({FixtureClient.PathArgument(path)})");
    Check(!result.Succeeded, "separate-process delete was rejected");
    Check(result.Error == "0x8007018B", "delete reports Cloud Files access denied, not a stopped provider");
    Check(File.Exists(path), "rejected delete preserved the file");
    Check(fixture.RejectedDeleteCount > 0, "delete rejection callback ran");
    Check(fixture.Errors.IsEmpty, "provider callback errors");
}

static async Task NativeReplacementConversion()
{
    using var fixture = CloudFilesFixture.Create(denyDeletes: true);
    fixture.Add("document.txt", "original"u8);
    var path = Path.Combine(fixture.Root, "document.txt");
    _ = await File.ReadAllBytesAsync(path);
    var replacement = Path.Combine(fixture.Root, "temporary-save.txt");
    await File.WriteAllTextAsync(replacement, "saved revision");
    var backup = Path.Combine(fixture.Root, "temporary-backup.txt");
    var replace = FixtureClient.Run($"[System.IO.File]::Replace({FixtureClient.PathArgument(replacement)}, {FixtureClient.PathArgument(path)}, {FixtureClient.PathArgument(backup)})");
    Check(replace.Succeeded && await File.ReadAllTextAsync(path) == "saved revision", "replacement completed");
    fixture.ConvertExisting("document.txt");
    Check(await File.ReadAllTextAsync(path) == "saved revision", "conversion retained complete saved body");
    var deletion = FixtureClient.Run($"[System.IO.File]::Delete({FixtureClient.PathArgument(path)})");
    Check(!deletion.Succeeded && await File.ReadAllTextAsync(path) == "saved revision", "converted saved file rejects deletion");
    Check(fixture.Errors.IsEmpty, "provider callback errors");
}

static Task NativePrivateKey()
{
    var keyId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    using var original = RSA.Create(2048);
    var privateBlob = original.ExportPkcs8PrivateKey();
    var imported = false;
    try
    {
        WindowsPrivateKey.Import(keyId, privateBlob);
        imported = true;
        CryptographicOperations.ZeroMemory(privateBlob);
        using (var key = WindowsPrivateKey.Open(keyId))
        {
            var encrypted = original.Encrypt("synthetic folder key"u8.ToArray(), RSAEncryptionPadding.OaepSHA256);
            Check(key.Decrypt(encrypted, RSAEncryptionPadding.OaepSHA256).AsSpan().SequenceEqual("synthetic folder key"u8), "persistent RSA OAEP decrypt");
            Throws<CryptographicException>(() => key.ExportPkcs8PrivateKey(), "PKCS8 private export");
            Throws<CryptographicException>(() => key.SignData("fixture"u8.ToArray(), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1), "signing");
            using var otherKey = RSA.Create(2048);
            var otherBlob = otherKey.ExportPkcs8PrivateKey();
            try { Throws<CryptographicException>(() => WindowsPrivateKey.Import(keyId, otherBlob), "duplicate import"); }
            finally { CryptographicOperations.ZeroMemory(otherBlob); }
            Check(key.Decrypt(original.Encrypt("same original"u8.ToArray(), RSAEncryptionPadding.OaepSHA256), RSAEncryptionPadding.OaepSHA256)
                .AsSpan().SequenceEqual("same original"u8), "duplicate import preserved original key");
        }
        using (var reopened = WindowsPrivateKey.Open(keyId))
            Throws<CryptographicException>(() => reopened.ExportParameters(true), "raw private export after reopening");
        WindowsPrivateKey.Delete(keyId);
        imported = false;
        Throws<CryptographicException>(() => WindowsPrivateKey.Open(keyId), "reopening deleted key");
    }
    finally
    {
        CryptographicOperations.ZeroMemory(privateBlob);
        if (imported) WindowsPrivateKey.Delete(keyId);
    }
    return Task.CompletedTask;
}

static Task NativeAccountProtection()
{
    var cookie = RandomNumberGenerator.GetBytes(128);
    var binding = RandomNumberGenerator.GetBytes(32);
    byte[]? opened = null;
    try
    {
        var encrypted = WindowsAccountProtection.Protect(cookie, binding);
        Check(!encrypted.AsSpan().SequenceEqual(cookie), "cookie is protected");
        opened = WindowsAccountProtection.Unprotect(encrypted, binding);
        Check(opened.AsSpan().SequenceEqual(cookie), "current-user cookie roundtrip");
        Throws<CryptographicException>(() => WindowsAccountProtection.Unprotect(encrypted, RandomNumberGenerator.GetBytes(32)));
        encrypted[encrypted.Length / 2] ^= 1;
        Throws<CryptographicException>(() => WindowsAccountProtection.Unprotect(encrypted, binding));
    }
    finally
    {
        CryptographicOperations.ZeroMemory(cookie);
        if (opened is not null) CryptographicOperations.ZeroMemory(opened);
    }
    return Task.CompletedTask;
}

static Task PasskeyRequests()
{
    static string Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var challenge = Url(RandomNumberGenerator.GetBytes(32));
    var salt = Url(RandomNumberGenerator.GetBytes(32));
    JsonElement Options(string rp = WindowsPasskey.RelyingParty, string verification = "required", string id = "Aw", string? challengeValue = null) =>
        JsonSerializer.SerializeToElement(new { rpId = rp, userVerification = verification, challenge = challengeValue ?? challenge,
            allowCredentials = new[] { new { id, type = "public-key" } },
            extensions = new { prf = new { evalByCredential = new Dictionary<string, object> { [id] = new { first = salt } } } } });
    var request = WindowsPasskey.Prepare(Options());
    Throws<ArgumentException>(() => WindowsPasskey.Authenticate(0, request), "no owner window cannot start authentication");
    Throws<CryptographicException>(() => WindowsPasskey.Prepare(Options(rp: "other.invalid")));
    Throws<CryptographicException>(() => WindowsPasskey.Prepare(Options(verification: "preferred")));
    Throws<CryptographicException>(() => WindowsPasskey.Prepare(Options(id: "Az")), "noncanonical credential ID");
    Throws<CryptographicException>(() => WindowsPasskey.Prepare(Options(challengeValue: challenge + "=")));
    Check(typeof(PasskeyAssertion).GetProperties().All(property => property.Name == "ServerResponse"), "PRF is absent from serializable properties");
    return Task.CompletedTask;
}

static async Task NativePasskeyEnvelope()
{
    var prf = RandomNumberGenerator.GetBytes(32);
    try
    {
        var start = new ProcessStartInfo("node") { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(RepositoryRoot(), "tcloud-windows", "tests", "webcrypto-interop.mjs"));
        using var child = Process.Start(start) ?? throw new Exception("Could not start browser envelope fixture.");
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        await child.StandardInput.WriteAsync(JsonSerializer.Serialize(new { mode = "passkey-envelope", prf = Convert.ToBase64String(prf) }));
        child.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await child.WaitForExitAsync(timeout.Token); }
        catch { child.Kill(entireProcessTree: true); throw; }
        _ = await error;
        Check(child.ExitCode == 0, "browser envelope generation");
        using var document = JsonDocument.Parse(await output);
        foreach (var (field, administrator) in new[] { ("member", false), ("administrator", true) })
        {
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var imported = false;
            try
            {
                var envelope = document.RootElement.GetProperty(field);
                JsonElement? administratorPublicKey = null;
                if (administrator)
                {
                    Check(envelope.GetProperty("publicKeyJwk").ValueKind == JsonValueKind.Null, "real admin envelope has no embedded public key");
                    Throws<CryptographicException>(() => PasskeyEnvelope.Import(id, prf, envelope, true), "admin config key is required");
                    using var handler = new CryptoConfigHandler(document.RootElement.GetProperty("cryptoConfig"));
                    using var client = new HttpClient(handler);
                    client.DefaultRequestHeaders.Add("X-TCloud-Session", "fixture-session");
                    administratorPublicKey = await PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client);
                    Check(handler.Calls == 1, "admin public key came from protected Cloud config");
                    var wrongPublicKey = document.RootElement.GetProperty("member").GetProperty("publicKeyJwk");
                    Throws<CryptographicException>(() => PasskeyEnvelope.Import(id, prf, envelope, true, wrongPublicKey), "mismatched admin public key");
                    Throws<CryptographicException>(() => WindowsPrivateKey.Open(id), "mismatched key is removed");
                }
                var expectedPublicKey = administratorPublicKey ?? envelope.GetProperty("publicKeyJwk");
                var wrongPurposeEnvelope = JsonSerializer.SerializeToElement(new {
                    encryptedPayload = envelope.GetProperty("encryptedPayload"), payloadIv = envelope.GetProperty("payloadIv"),
                    publicKeyJwk = expectedPublicKey });
                Throws<CryptographicException>(() => PasskeyEnvelope.Import(id, prf, wrongPurposeEnvelope, !administrator,
                    administrator ? null : expectedPublicKey), "admin/member purpose separation");
                PasskeyEnvelope.Import(id, prf, envelope, administrator, administratorPublicKey);
                imported = true;
                using var key = WindowsPrivateKey.Open(id);
                using var publicKey = RSA.Create();
                publicKey.ImportParameters(key.ExportParameters(false));
                var sample = RandomNumberGenerator.GetBytes(32);
                var decrypted = key.Decrypt(publicKey.Encrypt(sample, RSAEncryptionPadding.OaepSHA256), RSAEncryptionPadding.OaepSHA256);
                try { Check(decrypted.AsSpan().SequenceEqual(sample), "existing browser key decrypts in Windows"); }
                finally { CryptographicOperations.ZeroMemory(sample); CryptographicOperations.ZeroMemory(decrypted); }
                Throws<CryptographicException>(() => key.ExportParameters(true), "browser private key remains nonexportable");
            }
            finally { if (imported) WindowsPrivateKey.Delete(id); }
        }
    }
    finally { CryptographicOperations.ZeroMemory(prf); }
}

static async Task AdministratorPublicKey()
{
    using var rsa = RSA.Create(2048);
    var parameters = rsa.ExportParameters(false);
    static string Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    var publicKey = JsonSerializer.SerializeToElement(new { kty = "RSA", n = Url(parameters.Modulus!), e = Url(parameters.Exponent!) });
    var config = JsonSerializer.SerializeToElement(new { initialized = true, cryptoVersion = 1, publicKeyJwk = publicKey });
    using (var handler = new CryptoConfigHandler(config))
    using (var client = new HttpClient(handler))
    {
        await ThrowsAsync<CryptographicException>(() => PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client));
        Check(handler.Calls == 0, "unverified session cannot fetch the key");
        client.DefaultRequestHeaders.Add("X-TCloud-Session", "fixture-session");
        var actual = await PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client);
        Check(actual.GetProperty("n").GetString() == publicKey.GetProperty("n").GetString(), "Cloud key is authoritative");
        Check(handler.Calls == 1, "single protected config request");
    }
    foreach (var invalid in new[] {
        JsonSerializer.SerializeToElement(new { initialized = false, cryptoVersion = 1, publicKeyJwk = publicKey }),
        JsonSerializer.SerializeToElement(new { initialized = true, cryptoVersion = 2, publicKeyJwk = publicKey }),
        JsonSerializer.SerializeToElement(new { initialized = true, cryptoVersion = 1, publicKeyJwk = (object?)null }) })
    {
        using var handler = new CryptoConfigHandler(invalid);
        using var client = new HttpClient(handler);
        client.DefaultRequestHeaders.Add("X-TCloud-Session", "fixture-session");
        await ThrowsAsync<CryptographicException>(() => PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client));
    }
    using (var handler = new CryptoConfigHandler(config, System.Net.HttpStatusCode.Unauthorized))
    using (var client = new HttpClient(handler))
    {
        client.DefaultRequestHeaders.Add("X-TCloud-Session", "fixture-session");
        await ThrowsAsync<HttpRequestException>(() => PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client));
        Check(handler.Calls == 1, "authorization failure has no alternate key fallback");
    }
}

static string RepositoryRoot()
{
    for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        if (File.Exists(Path.Combine(directory.FullName, "cloud-worker", "public", "crypto-vault.js"))) return directory.FullName;
    throw new DirectoryNotFoundException("Repository root not found");
}
static string NewTemp() { var path = Path.Combine(Path.GetTempPath(), "tcloud-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); return path; }
static void Check(bool value, string label) { if (!value) throw new Exception(label); }
static void Throws<T>(Action action, string? label = null) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name + (label is null ? "" : ": " + label)); }
static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception { try { await action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }

internal sealed class CryptoConfigHandler(JsonElement config, System.Net.HttpStatusCode status = System.Net.HttpStatusCode.OK) : HttpMessageHandler
{
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Calls++;
        if (request.Method != HttpMethod.Get || request.RequestUri?.AbsoluteUri != WindowsPasskey.Origin + "/cloud/api/crypto-config"
            || request.Headers.GetValues("X-TCloud-Session").Single() != "fixture-session" || request.Content is not null)
            throw new InvalidOperationException("Unexpected config request; only the selected session and public config GET are allowed.");
        return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(config.GetRawText(), System.Text.Encoding.UTF8, "application/json") });
    }
}

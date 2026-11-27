using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

internal sealed record PendingRemoteFolder(string ScopeHash, long RootFileId, string Epoch, LocalFolderRecord Folder,
    string? StagedName, LocalFolderRecord? Previous = null);

/// <summary>Identifies a downloaded directory before it becomes visible to the local upload scan.</summary>
internal sealed class WindowsRemoteFolderPlacement(CloudFilesRootRegistration root, LocalSyncCatalog catalog,
    WindowsDeviceRegistration registration, string staging, string intentPath, Action<string>? protectFolder)
{
    public async Task<LocalFolderRecord?> CreateAsync(ResolvedFolder folder, string relativePath, string epoch, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        root.VerifyPresent();
        CheckAvailable();
        var name = Guid.NewGuid().ToString("N") + ".folder";
        var stage = StagedPath(name);
        Directory.CreateDirectory(stage);
        var entry = new LocalFolderRecord(folder.Id, relativePath, WindowsFileState.Read(stage).Id, folder.Revision);
        var intent = new PendingRemoteFolder(registration.ScopeHash, registration.RootFileId!.Value, epoch, entry, name);
        try { await WindowsAtomicState.SaveAsync(intentPath, intent, token); }
        catch
        {
            if (!File.Exists(intentPath) && FileId(stage) == entry.FileId) Directory.Delete(stage);
            throw;
        }
        return await CompleteAsync(intent, locate: null, token);
    }

    public async Task MoveAsync(LocalFolderRecord source, string relativePath, string epoch, CancellationToken token)
    {
        root.VerifyPresent();
        CheckAvailable();
        var intent = new PendingRemoteFolder(registration.ScopeHash, registration.RootFileId!.Value, epoch,
            source with { RelativePath = relativePath }, StagedName: null, Previous: source);
        await WindowsAtomicState.SaveAsync(intentPath, intent, token);
        await CompleteAsync(intent, locate: null, token);
    }

    public async Task<bool> ResumeAsync(Func<long, string?> locate, CancellationToken token)
    {
        var intent = await WindowsAtomicState.LoadAsync<PendingRemoteFolder>(intentPath, token);
        if (intent is null) return false;
        await CompleteAsync(intent, locate, token);
        return true;
    }

    private async Task<LocalFolderRecord?> CompleteAsync(PendingRemoteFolder intent, Func<long, string?>? locate, CancellationToken token)
    {
        root.VerifyPresent();
        var folder = intent.Folder;
        var previous = intent.Previous;
        if (intent.ScopeHash != registration.ScopeHash || intent.RootFileId != registration.RootFileId
            || intent.Epoch is not { Length: 32 } || !intent.Epoch.All(char.IsAsciiHexDigit)
            || folder is null || folder.FileId == 0 || folder.Id < 1 || folder.Revision < 1
            || (previous is null) == (intent.StagedName is null)
            || (previous is not null && (previous.Id != folder.Id || previous.FileId != folder.FileId || previous.Revision != folder.Revision)))
            throw new InvalidDataException("フォルダの再開記録が一致しません。");
        var source = previous is null ? StagedPath(intent.StagedName!) : LocalPaths.ResolveUnderRoot(root.Root, previous.RelativePath);
        var target = LocalPaths.ResolveUnderRoot(root.Root, folder.RelativePath);
        var snapshot = await catalog.LoadAsync(token);
        var online = snapshot.Remote.SingleOrDefault(item => item.Kind == "folder" && item.Id == folder.Id);
        var sameEpoch = snapshot.RemotePosition?.Epoch == intent.Epoch;
        if (FileId(target) != folder.FileId && FileId(source) == folder.FileId)
        {
            if (!sameEpoch || online is not { State: "present" } || online.Revision != folder.Revision || Occupied(target)
                || (previous is not null && IsMappedSubtree(snapshot, folder.RelativePath)))
            {
                DiscardIntent(previous is null ? source : null, folder.FileId);
                return null;
            }
            root.VerifyPresent();
            try { Directory.Move(source, target); }
            catch (IOException) when (FileId(source) == folder.FileId && Occupied(target))
            {
                DiscardIntent(previous is null ? source : null, folder.FileId);
                return null;
            }
        }

        var actual = FileId(target) == folder.FileId ? target : locate?.Invoke(folder.FileId);
        if (!sameEpoch || online is null || actual is null || FileId(actual) != folder.FileId)
            throw new InvalidDataException("同期したフォルダの対応を確認できません。HDDの内容を保持して同期を停止しました。");
        root.VerifyPresent();
        protectFolder?.Invoke(actual);
        if (FileId(actual) != folder.FileId) throw new IOException("フォルダの保存先が変わりました。再確認します。");
        await catalog.UpdateAsync(value =>
        {
            if (value.RemotePosition?.Epoch != intent.Epoch || !value.Remote.Any(item => item.Kind == "folder" && item.Id == folder.Id))
                throw new IOException("オンラインのフォルダ一覧が変わりました。再確認します。");
            var folders = value.Folders ?? [];
            var old = folders.SingleOrDefault(item => item.Id == folder.Id);
            if (old == folder) return value;
            if (old != previous || folders.Any(item => item.Id != folder.Id && item.RelativePath.Equals(folder.RelativePath, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("別のフォルダが同じ同期先を使用しています。");
            if (previous is null) return value with { Folders = [.. folders, folder] };
            var retired = DeletedFileIds(value);
            if (IsMappedSubtree(value, folder.RelativePath, retired))
                throw new IOException("フォルダの移動先の同期記録が変わりました。再確認します。");
            string Rebase(string path) => InFolder(path, previous.RelativePath) ? folder.RelativePath + path[previous.RelativePath.Length..] : path;
            return value with {
                Folders = folders.Select(item => item.Id == folder.Id ? folder : item with { RelativePath = Rebase(item.RelativePath) }).ToArray(),
                Originals = value.Originals.Where(item => !InFolder(item.RelativePath, folder.RelativePath) || !item.Deleted || !retired.Contains(item.Id))
                    .Select(item => item with { RelativePath = Rebase(item.RelativePath) }).ToArray()
            };
        }, token);
        WindowsAtomicState.Check(intentPath);
        File.Delete(intentPath);
        return folder;
    }

    private string StagedPath(string name)
    {
        if (name is not { Length: 39 } || !name.EndsWith(".folder", StringComparison.Ordinal) || !Guid.TryParseExact(Path.GetFileNameWithoutExtension(name), "N", out _)
            || !string.Equals(name, Path.GetFileName(name), StringComparison.Ordinal))
            throw new InvalidDataException("作成途中のフォルダ名が不正です。");
        return LocalPaths.ResolveUnderRoot(staging, name);
    }

    private static bool Occupied(string path)
    {
        WindowsAtomicState.Check(path);
        return Directory.Exists(path) || File.Exists(path);
    }

    private static long? FileId(string path)
    {
        WindowsAtomicState.Check(path);
        return Directory.Exists(path) ? WindowsFileState.Read(path).Id : null;
    }

    private void CheckAvailable()
    {
        WindowsAtomicState.Check(intentPath);
        if (File.Exists(intentPath)) throw new IOException("フォルダの同期を再開します。");
    }

    internal static bool InFolder(string item, string folder) => item.Equals(folder, StringComparison.OrdinalIgnoreCase)
        || item.StartsWith(folder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    internal static bool IsMappedSubtree(LocalSyncSnapshot snapshot, string folder)
        => IsMappedSubtree(snapshot, folder, DeletedFileIds(snapshot));

    private static bool IsMappedSubtree(LocalSyncSnapshot snapshot, string folder, HashSet<long> retired)
        => (snapshot.Folders ?? []).Any(item => InFolder(item.RelativePath, folder))
            || snapshot.Originals.Any(item => InFolder(item.RelativePath, folder) && (!item.Deleted || !retired.Contains(item.Id)));

    private static HashSet<long> DeletedFileIds(LocalSyncSnapshot snapshot) => snapshot.Remote
        .Where(item => item.Kind == "file" && item.State != "present").Select(item => item.Id).ToHashSet();

    private void DiscardIntent(string? stage, long id)
    {
        root.VerifyPresent();
        if (stage is not null && FileId(stage) != id) throw new InvalidDataException("作成途中のフォルダが変わりました。");
        WindowsAtomicState.Check(intentPath);
        File.Delete(intentPath);
        if (stage is not null && !Directory.EnumerateFileSystemEntries(stage).Any() && FileId(stage) == id) Directory.Delete(stage);
    }
}

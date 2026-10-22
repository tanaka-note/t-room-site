using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using XDownloader.Core;

namespace XDownloader.Auth;

public enum LoginState { Anonymous, Ready, Expired, Unreadable }

public sealed class WindowsLoginStore : ICookieSource
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("XVideoDownloader/session/v1");
    private readonly string root;
    private readonly string sessionFile;
    private readonly string temporaryRoot;
    private readonly Func<DateTimeOffset> clock;
    private int activeLeases;
    private readonly object gate = new();

    public WindowsLoginStore(string directory, Func<DateTimeOffset>? utcNow = null)
    {
        root = System.IO.Path.GetFullPath(directory);
        sessionFile = System.IO.Path.Combine(root,"session.dpapi");
        temporaryRoot = System.IO.Path.Combine(root,"cookie-leases");
        clock = utcNow ?? (() => DateTimeOffset.UtcNow);
        PrivateFiles.EnsureDirectory(root);
    }

    // Call only after the app's per-Windows-user single-instance lock has been acquired.
    public void CleanInterruptedOperations() { lock (gate) PrivateFiles.CleanOwnedDirectories(temporaryRoot); }

    public LoginState State
    {
        get
        {
            lock (gate)
            {
                try { return Read() is { } snapshot ? IsExpired(snapshot) ? LoginState.Expired : LoginState.Ready : LoginState.Anonymous; }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException or JsonException or InvalidOperationException)
                { return LoginState.Unreadable; }
            }
        }
    }

    public IReadOnlyList<XCookie> GetForLoginWindow()
    {
        lock (gate)
        {
            if (State != LoginState.Ready) return [];
            return Read()!.Cookies;
        }
    }

    public void Save(IEnumerable<XCookie> cookies)
    { lock (gate) SaveLocked(cookies); }
    private void SaveLocked(IEnumerable<XCookie> cookies)
    {
        if (activeLeases != 0) throw new InvalidOperationException("処理中はXのログインを変更できません。");
        var now = clock();
        var selected = XCookie.Filter(cookies,now);
        var authExpiry = selected.Where(c => c.Name == "auth_token" && c.Domain == ".x.com" && c.Expires > 0)
            .Select(c => DateTimeOffset.FromUnixTimeSeconds((long)c.Expires)).DefaultIfEmpty(now.AddDays(30)).Min();
        var snapshot = new Snapshot(1,now.AddDays(30) < authExpiry ? now.AddDays(30) : authExpiry,selected.ToArray());
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(snapshot);
        byte[]? encrypted = null;
        var temporary = System.IO.Path.Combine(root,Guid.NewGuid().ToString("N")+".encrypted.tmp");
        try
        {
            encrypted = ProtectedData.Protect(plaintext,Entropy,DataProtectionScope.CurrentUser);
            using (var stream = new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None))
            { stream.Write(encrypted); stream.Flush(flushToDisk:true); }
            File.Move(temporary,sessionFile,overwrite:true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            if (encrypted is not null) CryptographicOperations.ZeroMemory(encrypted);
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public ICookieLease? Acquire()
    { lock (gate) return AcquireLocked(); }
    private ICookieLease? AcquireLocked()
    {
        Snapshot? snapshot;
        try { snapshot = Read(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException or JsonException or InvalidOperationException)
        { throw new InvalidOperationException("保存したXログイン情報を読み込めません。「ログアウト」してからXへ再ログインしてください。"); }
        if (snapshot is null) return null;
        if (IsExpired(snapshot)) throw new InvalidOperationException("Xのログイン保持期限が切れています。Xへ再ログインしてください。");
        var selected = XCookie.Filter(snapshot.Cookies,clock());
        var path = PrivateFiles.CreateOwnedDirectory(temporaryRoot);
        var file = System.IO.Path.Combine(path,"cookies.txt");
        try
        {
            File.WriteAllText(file,"# Netscape HTTP Cookie File\n"+string.Join('\n',selected.Select(c => c.ToNetscapeLine()))+"\n",new UTF8Encoding(false));
            activeLeases++;
            return new Lease(file,() =>
            {
                lock (gate)
                {
                    try { PrivateFiles.DeleteOwnedDirectory(temporaryRoot,path); }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                    { throw new InvalidOperationException("ログイン情報の一時ファイルを削除できませんでした。アプリを終了してから再起動してください。"); }
                    finally { activeLeases--; }
                }
            });
        }
        catch { PrivateFiles.DeleteOwnedDirectory(temporaryRoot,path); throw; }
    }

    public void Logout()
    {
        lock (gate)
        {
            if (activeLeases != 0) throw new InvalidOperationException("取得処理を完了またはキャンセルしてからログアウトしてください。");
            File.Delete(sessionFile);
            CleanInterruptedOperations();
        }
    }

    private Snapshot? Read()
    {
        if (!File.Exists(sessionFile)) return null;
        if ((File.GetAttributes(sessionFile) & FileAttributes.ReparsePoint) != 0 || new FileInfo(sessionFile).Length > 256 * 1024)
            throw new InvalidOperationException("Invalid protected session");
        var encrypted = File.ReadAllBytes(sessionFile);
        byte[]? plaintext = null;
        try
        {
            plaintext = ProtectedData.Unprotect(encrypted,Entropy,DataProtectionScope.CurrentUser);
            var snapshot = JsonSerializer.Deserialize<Snapshot>(plaintext);
            if (snapshot is null || snapshot.Version != 1 || snapshot.Cookies is null || snapshot.Cookies.Length > 20 || snapshot.Cookies.Any(c=>c is null))
                throw new InvalidOperationException("Invalid protected session");
            return snapshot;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encrypted);
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private bool IsExpired(Snapshot snapshot) => snapshot.NotAfter <= clock()
        || !snapshot.Cookies.Any(c => c.Domain == ".x.com" && c.Name == "auth_token" && c.IsAllowed(clock()))
        || !snapshot.Cookies.Any(c => c.Domain == ".x.com" && c.Name == "ct0" && c.IsAllowed(clock()));

    private sealed record Snapshot(int Version,DateTimeOffset NotAfter,XCookie[] Cookies);
    private sealed class Lease(string path,Action cleanup) : ICookieLease
    {
        private int disposed;
        public string FilePath => path;
        public void Dispose() { if (Interlocked.Exchange(ref disposed,1) == 0) cleanup(); }
    }
}

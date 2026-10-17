using System.IO;
using System.Windows;
using XDownloader.Auth;
using XDownloader.Core;

namespace XDownloader.App;

public interface IXLoginService
{
    LoginState State { get; }
    Task<bool> LoginAsync(Window owner,CancellationToken token);
    void Logout();
}

public sealed class XLoginService(WindowsLoginStore store,string browserRoot) : IXLoginService
{
    public LoginState State => store.State;
    public async Task<bool> LoginAsync(Window owner,CancellationToken token)
    {
        var window = new XLoginWindow(store,browserRoot) { Owner=owner };
        using var cancel = token.Register(() => owner.Dispatcher.BeginInvoke(() => { if (window.IsVisible) window.Close(); }));
        try { return window.ShowDialog() == true; }
        finally { await window.CleanupAsync(); }
    }
    public void Logout()
    {
        try { store.Logout(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { throw new InvalidOperationException("Xのログイン情報を完全に消去できませんでした。アプリを再起動して、もう一度ログアウトしてください。"); }
    }
}

internal sealed class AppServices
{
    internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"XVideoDownloader","auth-v1");
    internal static readonly string BrowserRoot = Path.Combine(Root,"browser-sessions");
    public Downloader Downloader { get; }
    public IXLoginService Login { get; }
    public AppServices()
    {
        var store = new WindowsLoginStore(Root);
        store.CleanInterruptedOperations();
        PrivateFiles.CleanOwnedDirectories(BrowserRoot);
        Downloader=new Downloader(Path.Combine(AppContext.BaseDirectory,"tools"),cookies:store);
        Login=new XLoginService(store,BrowserRoot);
    }
}

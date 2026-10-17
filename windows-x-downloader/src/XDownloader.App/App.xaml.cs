using System.Windows;
using System.Security.Principal;
using System.IO;
using XDownloader.Auth;

namespace XDownloader.App;

public partial class App : Application
{
    private Mutex? singleInstance;
    private Mutex? installerLock;
    private bool ownsLock;
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (e.Args.SequenceEqual(new[]{"--verify-package"}))
        {
            ShutdownMode=ShutdownMode.OnExplicitShutdown;
            _=VerifyPackageAsync(); return;
        }
        singleInstance=new Mutex(false,"Local\\XVideoDownloader.Auth.v1."+WindowsIdentity.GetCurrent().User!.Value);
        try { ownsLock=singleInstance.WaitOne(0); }
        catch (AbandonedMutexException) { ownsLock=true; }
        if (!ownsLock)
        {
            MessageBox.Show("X動画ダウンローダーは既に起動しています。開いている画面を使用してください。","X動画ダウンローダー");
            Shutdown(); return;
        }
        // Inno Setup checks this object before installing/uninstalling. It never force-closes a download.
        installerLock=new Mutex(false,"Local\\XVideoDownloader.Installer.v1");
        try { MainWindow=new MainWindow(); MainWindow.Show(); }
        catch (Exception)
        {
            MessageBox.Show("ログイン情報の保存領域を準備できませんでした。アプリを再起動して保存先の権限を確認してください。","X動画ダウンローダー");
            Shutdown(1);
        }
    }
    protected override void OnExit(ExitEventArgs e)
    {
        if (ownsLock) singleInstance?.ReleaseMutex();
        singleInstance?.Dispose();
        installerLock?.Dispose();
        base.OnExit(e);
    }

    private async Task VerifyPackageAsync()
    {
        var root=Path.Combine(Path.GetTempPath(),"x-downloader-package-"+Guid.NewGuid().ToString("N"));
        XLoginWindow? window=null;
        var result=1;
        try
        {
            Directory.CreateDirectory(root);
            var store=new WindowsLoginStore(Path.Combine(root,"auth"));
            var profiles=Path.Combine(root,"profiles");
            window=new XLoginWindow(store,profiles,offlineFixture:true) { ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
            window.Show(); await window.WaitForBrowserAsync().WaitAsync(TimeSpan.FromSeconds(30));
            var core=window.BrowserForOfflineTest!;
            if (!core.Profile.IsInPrivateModeEnabled) throw new InvalidOperationException();
            foreach (var name in new[]{"auth_token","ct0"})
            {
                var cookie=core.CookieManager.CreateCookie(name,Guid.NewGuid().ToString("N"),".x.com","/");
                cookie.IsSecure=true; cookie.IsHttpOnly=name=="auth_token";
                core.CookieManager.AddOrUpdateCookie(cookie);
            }
            await window.CaptureSessionAsync();
            using (var lease=store.Acquire())
                if (lease is null || !File.Exists(lease.FilePath)) throw new InvalidOperationException();
            window.Close(); await window.CleanupAsync(); window=null;
            store.Logout();
            if (store.State!=LoginState.Anonymous || Directory.EnumerateDirectories(profiles).Any()) throw new InvalidOperationException();
            Console.WriteLine("PACKAGE_OK"); result=0;
        }
        catch (Exception error) { Console.WriteLine("PACKAGE_FAIL "+error.GetType().Name); }
        finally
        {
            if (window is not null)
            {
                try { window.Close(); await window.CleanupAsync(); } catch (Exception) { result=1; }
            }
            try { if (Directory.Exists(root)) Directory.Delete(root,true); } catch (IOException) { result=1; }
            Shutdown(result);
        }
    }
}

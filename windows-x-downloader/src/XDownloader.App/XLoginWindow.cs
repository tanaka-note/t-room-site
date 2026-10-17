using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using XDownloader.Auth;

namespace XDownloader.App;

public sealed class XLoginWindow : Window
{
    private readonly WindowsLoginStore store;
    private readonly string browserRoot;
    private readonly bool fixtureMode;
    private readonly WebView2 browser = new();
    private readonly TextBlock status = new() { TextWrapping=TextWrapping.Wrap,Margin=new Thickness(12),MinHeight=42 };
    private readonly Button done = new() { Content="ログイン完了",Padding=new Thickness(18,8,18,8),IsEnabled=false,Margin=new Thickness(4) };
    private string? profileDirectory;
    private TaskCompletionSource? browserExited;
    private bool closed;
    private Task? initialization;

    internal XLoginWindow(WindowsLoginStore loginStore,string browserDirectory,bool offlineFixture=false)
    {
        store=loginStore; browserRoot=browserDirectory; fixtureMode=offlineFixture;
        Title="Xにログイン — x.com"; Width=650; Height=760; MinWidth=500; MinHeight=500;
        WindowStartupLocation=WindowStartupLocation.CenterOwner;
        FontFamily=new System.Windows.Media.FontFamily("Yu Gothic UI"); FontSize=14;
        var layout=new DockPanel();
        var note=new TextBlock { Text="X公式の画面でログインしてください。パスワードはアプリに保存しません。\nログイン完了後、X用の認証情報をこのPCのWindowsユーザー専用に保護して保存します。",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(12) };
        DockPanel.SetDock(note,Dock.Top); layout.Children.Add(note);
        var buttons=new StackPanel { Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Right,Margin=new Thickness(8) };
        var cancel=new Button { Content="キャンセル",Padding=new Thickness(18,8,18,8),Margin=new Thickness(4),IsCancel=true };
        cancel.Click+=(_,_) => Close(); done.Click+=Save_Click;
        buttons.Children.Add(done); buttons.Children.Add(cancel);
        DockPanel.SetDock(buttons,Dock.Bottom); layout.Children.Add(buttons);
        DockPanel.SetDock(status,Dock.Bottom); layout.Children.Add(status);
        layout.Children.Add(browser); Content=layout;
        PreviewKeyDown+=(_,e) => { if (e.Key == Key.Escape) { e.Handled=true; Close(); } };
        Loaded+=(_,_) => initialization=InitializeAsync();
        Closed+=(_,_) => { closed=true; browser.Dispose(); };
    }

    private async Task InitializeAsync()
    {
        try
        {
            profileDirectory=PrivateFiles.CreateOwnedDirectory(browserRoot);
            browser.CreationProperties=new CoreWebView2CreationProperties
            { UserDataFolder=profileDirectory,ProfileName="XLogin",IsInPrivateModeEnabled=true };
            await browser.EnsureCoreWebView2Async();
            if (closed) return;
            var core=browser.CoreWebView2;
            browserExited=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            core.Environment.BrowserProcessExited+=(_,_) => browserExited.TrySetResult();
            core.Profile.IsPasswordAutosaveEnabled=false;
            core.Profile.IsGeneralAutofillEnabled=false;
            core.Settings.AreDevToolsEnabled=false;
            core.Settings.AreDefaultContextMenusEnabled=false;
            core.Settings.IsWebMessageEnabled=false;
            core.Settings.AreHostObjectsAllowed=false;
            core.PermissionRequested+=(_,e) => e.State=CoreWebView2PermissionState.Deny;
            core.DownloadStarting+=(_,e) => e.Cancel=true;
            core.ServerCertificateErrorDetected+=(_,e) => e.Action=CoreWebView2ServerCertificateErrorAction.Cancel;
            core.NavigationStarting+=(_,e) =>
            {
                if (IsAllowedNavigation(e.Uri) || fixtureMode && e.Uri == "about:blank") return;
                e.Cancel=true;
                status.Text="X以外のページはアプリ内で開けません。Xのユーザー名とパスワードでログインしてください。";
            };
            core.NewWindowRequested+=(_,e) =>
            {
                e.Handled=true;
                if (IsAllowedNavigation(e.Uri)) core.Navigate(e.Uri);
                else status.Text="外部サイトのログインは対象外です。Xのユーザー名とパスワードでログインしてください。";
            };
            foreach (var saved in store.GetForLoginWindow())
            {
                var cookie=core.CookieManager.CreateCookie(saved.Name,saved.Value,saved.Domain,saved.Path);
                cookie.IsSecure=true; cookie.IsHttpOnly=saved.HttpOnly;
                if (saved.Expires > 0) cookie.Expires=DateTimeOffset.FromUnixTimeSeconds((long)saved.Expires).UtcDateTime;
                core.CookieManager.AddOrUpdateCookie(cookie);
            }
            done.IsEnabled=true;
            status.Text="Xの画面でログインと追加認証を完了してから「ログイン完了」を押してください。";
            if (fixtureMode) core.NavigateToString("<!doctype html><meta charset=utf-8><title>Offline login fixture</title><p>Offline WebView2 smoke test</p>");
            else core.Navigate(store.State == LoginState.Ready ? "https://x.com/home" : "https://x.com/i/flow/login");
        }
        catch (Exception) when (!closed)
        {
            status.Text="Xのログイン画面を起動できませんでした。Microsoft Edge WebView2 Runtimeがインストールされているか確認し、アプリを再起動してください。";
        }
        catch (Exception) when (closed) { }
    }

    private async void Save_Click(object sender,RoutedEventArgs e)
    {
        if (closed || browser.CoreWebView2 is null) return;
        done.IsEnabled=false;
        try
        {
            await CaptureSessionAsync();
            if (closed) return;
            DialogResult=true;
        }
        catch (InvalidOperationException) when (!closed)
        { status.Text="Xへのログイン完了を確認できません。ユーザー名・パスワード・追加認証を完了してから、もう一度押してください。"; }
        catch (Exception) when (!closed)
        { status.Text="ログイン情報を安全に保存できませんでした。アプリを再起動して、もう一度ログインしてください。"; }
        catch (Exception) when (closed) { }
        finally { if (!closed) done.IsEnabled=true; }
    }

    public static bool IsAllowedNavigation(string input) => Uri.TryCreate(input,UriKind.Absolute,out var uri)
        && uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0
        && (uri.IdnHost.Equals("x.com",StringComparison.OrdinalIgnoreCase) || uri.IdnHost.EndsWith(".x.com",StringComparison.OrdinalIgnoreCase)
            || uri.IdnHost.Equals("twitter.com",StringComparison.OrdinalIgnoreCase) || uri.IdnHost.EndsWith(".twitter.com",StringComparison.OrdinalIgnoreCase));

    public async Task CleanupAsync()
    {
        if (!closed) { closed=true; browser.Dispose(); }
        if (initialization is not null)
        {
            try { await initialization.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TimeoutException) { throw new InvalidOperationException("Xログイン画面の終了処理が続いています。アプリを再起動してください。"); }
        }
        if (browserExited is not null)
        {
            try { await browserExited.Task.WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TimeoutException) { throw new InvalidOperationException("Xログイン画面の終了処理が続いています。アプリを再起動してください。"); }
        }
        if (profileDirectory is not null)
        {
            for (var attempt=0; ;attempt++)
            {
                try { PrivateFiles.DeleteOwnedDirectory(browserRoot,profileDirectory); break; }
                catch (Exception e) when (attempt < 4 && e is IOException or UnauthorizedAccessException) { await Task.Delay(200); }
            }
        }
    }

    internal async Task CaptureSessionAsync()
    {
        var cookies=await browser.CoreWebView2.CookieManager.GetCookiesAsync("https://x.com/");
        if (closed) throw new OperationCanceledException();
        store.Save(cookies.Select(c => new XCookie(c.Domain,c.Name,c.Value,c.Path,c.IsSecure,c.IsHttpOnly,
            c.IsSession ? 0 : new DateTimeOffset(DateTime.SpecifyKind(c.Expires,DateTimeKind.Utc)).ToUnixTimeSeconds())));
    }

    // Friend-assembly entry points use generated synthetic cookies and never contact X.
    internal async Task WaitForBrowserAsync()
    {
        for (var attempt=0;initialization is null && attempt<500;attempt++) await Task.Delay(10);
        if (initialization is null) throw new TimeoutException();
        await initialization;
        if (browser.CoreWebView2 is null) throw new InvalidOperationException("WebView2 initialization failed");
    }
    internal CoreWebView2? BrowserForOfflineTest => fixtureMode ? browser.CoreWebView2 : throw new InvalidOperationException();
}

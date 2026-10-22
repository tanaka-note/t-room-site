using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using XDownloader.Auth;
using XDownloader.Core;
using System.Windows.Threading;

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
    private readonly Func<string,Task>? savePost;
    private readonly Func<bool> canChangeSession;
    private readonly Action? sessionSaved;
    private readonly Button save = new() { Content="この投稿を保存",Padding=new Thickness(14,7,14,7),IsEnabled=false };
    private readonly TextBlock address = new() { TextWrapping=TextWrapping.Wrap,Margin=new Thickness(12,0,12,6) };
    private readonly DispatcherTimer controlsTimer = new() { Interval=TimeSpan.FromMilliseconds(500) };
    private bool requesting;
    private bool navigating;
    private bool sessionSaving;

    internal XLoginWindow(WindowsLoginStore loginStore,string browserDirectory,bool offlineFixture=false,
        Func<string,Task>? onSavePost=null,Func<bool>? canUpdateSession=null,Action? onSessionSaved=null)
    {
        store=loginStore; browserRoot=browserDirectory; fixtureMode=offlineFixture;
        savePost=onSavePost; canChangeSession=canUpdateSession ?? (() => true); sessionSaved=onSessionSaved;
        Title=savePost is null ? "Xにログイン — x.com" : "Xを閲覧 — 投稿を開いて保存";
        Width=savePost is null ? 650 : 1000; Height=800; MinWidth=620; MinHeight=500;
        MaxHeight=Math.Max(MinHeight,SystemParameters.WorkArea.Height);
        WindowStartupLocation=WindowStartupLocation.CenterOwner;
        FontFamily=new System.Windows.Media.FontFamily("Yu Gothic UI"); FontSize=14;
        var layout=new DockPanel();
        var note=new TextBlock { Text="X公式の画面でログインしてください。パスワードはアプリに保存しません。\nログイン完了後、X用の認証情報をこのPCのWindowsユーザー専用に保護して保存します。",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(12) };
        DockPanel.SetDock(note,Dock.Top); layout.Children.Add(note);
        if (savePost is not null)
        {
            note.Text="投稿の詳細を開いて「この投稿を保存」。タイトル・画質を確認して保存待ちへ追加します。";
            var toolbar=new StackPanel { Orientation=Orientation.Horizontal,Margin=new Thickness(12,0,12,8) };
            var back=new Button { Content="戻る",Padding=new Thickness(12,7,12,7),Margin=new Thickness(0,0,6,0) };
            var home=new Button { Content="タイムライン",Padding=new Thickness(12,7,12,7),Margin=new Thickness(0,0,12,0) };
            back.Click+=(_,_) => { if (browser.CoreWebView2?.CanGoBack == true) browser.CoreWebView2.GoBack(); };
            home.Click+=(_,_) => browser.CoreWebView2?.Navigate("https://x.com/home");
            save.Click+=SavePost_Click;
            toolbar.Children.Add(back); toolbar.Children.Add(home); toolbar.Children.Add(save);
            DockPanel.SetDock(toolbar,Dock.Top); layout.Children.Add(toolbar);
            DockPanel.SetDock(address,Dock.Top); layout.Children.Add(address);
            done.Content="ログイン情報を保存";
        }
        var buttons=new StackPanel { Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Right,Margin=new Thickness(8) };
        var cancel=new Button { Content=savePost is null ? "キャンセル" : "閲覧を閉じる",Padding=new Thickness(18,8,18,8),Margin=new Thickness(4),IsCancel=true };
        cancel.Click+=(_,_) => Close(); done.Click+=Save_Click;
        buttons.Children.Add(done); buttons.Children.Add(cancel);
        DockPanel.SetDock(buttons,Dock.Bottom); layout.Children.Add(buttons);
        DockPanel.SetDock(status,Dock.Bottom); layout.Children.Add(status);
        layout.Children.Add(browser); Content=layout;
        PreviewKeyDown+=(_,e) => { if (e.Key == Key.Escape) { e.Handled=true; Close(); } };
        Loaded+=(_,_) => initialization=InitializeAsync();
        controlsTimer.Tick+=(_,_) => UpdateControls();
        Closing+=(_,e)=> { if (OwnedWindows.OfType<SavePostWindow>().Any(editor=>!editor.ApproveClose())) e.Cancel=true; };
        Closed+=(_,_) => { closed=true; controlsTimer.Stop(); browser.Dispose(); };
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
                if (IsAllowedNavigation(e.Uri) || fixtureMode && e.Uri == "about:blank") { navigating=true; UpdateControls(); return; }
                e.Cancel=true;
                status.Text="X以外のページはアプリ内で開けません。Xのユーザー名とパスワードでログインしてください。";
            };
            core.NavigationCompleted+=(_,_) => { navigating=false; UpdateControls(); };
            core.SourceChanged+=(_,_) => UpdateControls();
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
            controlsTimer.Start();
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
        if (closed || browser.CoreWebView2 is null || requesting || sessionSaving || !canChangeSession()) return;
        sessionSaving=true;
        done.IsEnabled=false;
        try
        {
            await CaptureSessionAsync();
            if (closed) return;
            if (savePost is null) DialogResult=true;
            else { sessionSaved?.Invoke(); status.Text="Xのログイン情報を保存しました。投稿の詳細を開いて保存できます。"; }
        }
        catch (InvalidOperationException) when (!closed)
        { status.Text="Xへのログイン完了を確認できません。ユーザー名・パスワード・追加認証を完了してから、もう一度押してください。"; }
        catch (Exception) when (!closed)
        { status.Text="ログイン情報を安全に保存できませんでした。アプリを再起動して、もう一度ログインしてください。"; }
        catch (Exception) when (closed) { }
        finally { sessionSaving=false; if (!closed) UpdateControls(); }
    }

    private void UpdateControls()
    {
        if (closed || browser.CoreWebView2 is null) return;
        done.IsEnabled=!requesting && !sessionSaving && canChangeSession();
        done.ToolTip=done.IsEnabled ? "このPCのログイン情報を更新します。" : "ログイン情報の更新は、解析・保存待ち・取得を完了または中止してから行えます。";
        save.IsEnabled=!requesting && !sessionSaving && !navigating && TryPost(browser.Source?.AbsoluteUri, out _);
        address.Text=TryPost(browser.Source?.AbsoluteUri, out var post) ? post : "保存するには動画の投稿詳細を開いてください。";
    }

    internal static bool TryPost(string? source,out string post)
    {
        try { post=PostUrl.Normalize(source ?? ""); return true; }
        catch (ArgumentException) { post=""; return false; }
    }

    private async void SavePost_Click(object sender,RoutedEventArgs e)
    {
        if (closed || requesting || sessionSaving || navigating || savePost is null || !TryPost(browser.Source?.AbsoluteUri,out var url)) return;
        requesting=true; UpdateControls();
        try
        {
            var source=browser.Source!.AbsoluteUri;
            var cookies=await ReadCookiesAsync();
            if (closed) return;
            if (navigating || browser.Source?.AbsoluteUri != source) throw new InvalidOperationException("投稿が切り替わりました。もう一度保存を押してください。");
            PrepareSession(cookies);
            status.Text="動画情報を読み込んでいます…";
            await savePost(url);
            if (!closed) status.Text="保存待ち一覧はアプリ本体で確認できます。続けて別の投稿も選べます。";
        }
        catch (OperationCanceledException) { if (!closed) status.Text="保存の追加をキャンセルしました。"; }
        catch (InvalidOperationException error) { if (!closed) status.Text=error.Message; }
        catch (Exception) { if (!closed) status.Text="投稿を追加できませんでした。ログイン状態と投稿を確認してください。"; }
        finally { requesting=false; if (!closed) UpdateControls(); }
    }

    private void PrepareSession(IReadOnlyList<XCookie> cookies)
    {
        // An active queue keeps its existing identity. Never replace credentials under a download.
        var saved=store.GetForLoginWindow();
        var matches=new[]{"auth_token","ct0"}.All(name=>
        {
            var existing=saved.FirstOrDefault(c=>c.Domain==".x.com" && c.Name==name);
            var current=cookies.FirstOrDefault(c=>c.Domain==".x.com" && c.Name==name);
            return existing is not null && current is not null && existing.Value==current.Value;
        });
        if (matches) return;
        if (canChangeSession()) { store.Save(cookies); sessionSaved?.Invoke(); return; }
        throw new InvalidOperationException("ログイン状態が変わりました。保存待ちの処理を完了またはキャンセルしてから「ログイン情報を保存」を押してください。");
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
        var cookies=await ReadCookiesAsync();
        if (!canChangeSession()) throw new InvalidOperationException("保存処理中はログイン情報を変更できません。");
        store.Save(cookies);
    }

    private async Task<IReadOnlyList<XCookie>> ReadCookiesAsync()
    {
        var cookies=await browser.CoreWebView2.CookieManager.GetCookiesAsync("https://x.com/");
        if (closed) throw new OperationCanceledException();
        return XCookie.Filter(cookies.Select(c=>new XCookie(c.Domain,c.Name,c.Value,c.Path,c.IsSecure,c.IsHttpOnly,
            c.IsSession ? 0 : new DateTimeOffset(DateTime.SpecifyKind(c.Expires,DateTimeKind.Utc)).ToUnixTimeSeconds())),DateTimeOffset.UtcNow);
    }

    internal void PrepareSessionForTest(IReadOnlyList<XCookie> cookies) => PrepareSession(cookies);
    internal Button SavePostButtonForTest => fixtureMode ? save : throw new InvalidOperationException();

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

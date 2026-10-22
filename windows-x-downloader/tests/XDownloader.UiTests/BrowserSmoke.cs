using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using XDownloader.App;
using XDownloader.Auth;
using System.Windows.Controls;
using System.Text;

internal static class BrowserSmoke
{
    public static async Task VerifyAsync(string root)
    {
        void Check(bool value,string label) { if (!value) throw new Exception(label); Console.WriteLine("PASS WEBVIEW "+label); }
        foreach (var uri in new[]{"https://x.com/i/flow/login","https://api.x.com/","https://twitter.com/login"})
            Check(XLoginWindow.IsAllowedNavigation(uri),"official X navigation allowed");
        foreach (var uri in new[]{"http://x.com/","https://x.com.evil.test/","https://x.com@evil.test/","file:///C:/","https://x.com:8443/","https://accounts.google.com/"})
            Check(!XLoginWindow.IsAllowedNavigation(uri),"external/insecure navigation rejected");
        var available=CoreWebView2Environment.GetAvailableBrowserVersionString();
        Check(!string.IsNullOrEmpty(available),"installed WebView2 Runtime available");
        var store=new WindowsLoginStore(Path.Combine(root,"browser-auth"));
        var profiles=Path.Combine(root,"browser-auth","profiles");
        var window=new XLoginWindow(store,profiles,offlineFixture:true) { ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
        try
        {
            window.Show();
            await window.WaitForBrowserAsync().WaitAsync(TimeSpan.FromSeconds(30));
            var core=window.BrowserForOfflineTest!;
            Check(core.Profile.IsInPrivateModeEnabled,"browser profile uses InPrivate mode");
            Check(!core.Profile.IsPasswordAutosaveEnabled && !core.Profile.IsGeneralAutofillEnabled,"password saving and autofill disabled");
            Check(!core.Settings.AreDevToolsEnabled && !core.Settings.AreHostObjectsAllowed && !core.Settings.IsWebMessageEnabled,"web content has no host bridge or developer tools");
            var blocked=new TaskCompletionSource<bool>();
            core.NavigationStarting+=(_,e) => { if (e.Uri.StartsWith("https://example.invalid/")) blocked.TrySetResult(e.Cancel); };
            core.Navigate("https://example.invalid/blocked");
            Check(await blocked.Task.WaitAsync(TimeSpan.FromSeconds(5)),"actual external navigation cancelled before network access");
            var manager=core.CookieManager;
            foreach (var name in new[]{"auth_token","ct0"})
            {
                var cookie=manager.CreateCookie(name,Guid.NewGuid().ToString("N"),".x.com","/");
                cookie.IsSecure=true; cookie.IsHttpOnly=name=="auth_token";
                manager.AddOrUpdateCookie(cookie);
            }
            var other=manager.CreateCookie("auth_token",Guid.NewGuid().ToString("N"),".evil.test","/");
            other.IsSecure=true; other.IsHttpOnly=true; manager.AddOrUpdateCookie(other);
            await window.CaptureSessionAsync();
            Check(store.State==LoginState.Ready && store.GetForLoginWindow().Count==2,"WebView2 exports only X cookies into DPAPI store");
        }
        finally { window.Close(); await window.CleanupAsync(); }
        Check(!Directory.EnumerateDirectories(profiles).Any(),"closed login browser profile removed");

        var restored=new XLoginWindow(store,profiles,offlineFixture:true) { ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
        try
        {
            restored.Show(); await restored.WaitForBrowserAsync().WaitAsync(TimeSpan.FromSeconds(30));
            var imported=await restored.BrowserForOfflineTest!.CookieManager.GetCookiesAsync("https://x.com/");
            Check(imported.Any(c=>c.Name=="auth_token") && imported.Any(c=>c.Name=="ct0"),"protected session restored into a fresh private browser");
        }
        finally { restored.Close(); await restored.CleanupAsync(); }
        await VerifyNativeSaveAsync(store,profiles,Check);
        new XLoginService(store,profiles).Logout();
        Check(store.State==LoginState.Anonymous && !Directory.EnumerateDirectories(profiles).Any(),"logout leaves no stored session or browser profile");
    }

    private static async Task VerifyNativeSaveAsync(WindowsLoginStore store,string profiles,Action<bool,string> check)
    {
        foreach (var uri in new[]{"https://x.com/home","https://x.com/search?q=video","https://x.com/i/flow/login","https://evil.test/u/status/123"})
            check(!XLoginWindow.TryPost(uri,out _),"native save rejects timeline, search, login and external pages");
        check(XLoginWindow.TryPost("https://x.com/user/status/123?ref=fixture",out var canonical) && canonical=="https://x.com/user/status/123","native save canonicalizes the displayed post URL");
        var updatesAllowed=false;
        var clicks=0;
        var committed=0;
        var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls=new List<string>();
        var window=new XLoginWindow(store,profiles,offlineFixture:true,onSavePost:async url=> { clicks++; calls.Add(url); await release.Task; },canUpdateSession:()=>updatesAllowed,onSessionSaved:()=>committed++)
            { ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
        try
        {
            window.Show(); await window.WaitForBrowserAsync().WaitAsync(TimeSpan.FromSeconds(30));
            var core=window.BrowserForOfflineTest!;
            // Every request is intercepted locally. No real X page or account is contacted.
            core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
            core.WebResourceRequested+=(_,e)=>e.Response=core.Environment.CreateWebResourceResponse(
                new MemoryStream(Encoding.UTF8.GetBytes("<!doctype html><meta charset=utf-8><title>Offline post</title><p>Local fixture</p>")),200,"OK","Content-Type: text/html; charset=utf-8");
            var save=window.SavePostButtonForTest;
            check(!save.IsEnabled,"native save disabled before opening a post");
            var navigated=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            core.NavigationCompleted+=(_,_)=>navigated.TrySetResult();
            core.Navigate("https://x.com/user/status/123"); await navigated.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (!save.IsEnabled) await Task.Delay(10,timeout.Token);
            var saved=store.GetForLoginWindow();
            window.PrepareSessionForTest(saved);
            using (var lease=store.Acquire())
            {
                window.PrepareSessionForTest(saved);
                check(File.Exists(lease!.FilePath),"same session can submit while downloads hold protected credentials");
                var changed=saved.Select(c=>c.Name=="auth_token" ? c with { Value=Guid.NewGuid().ToString("N") } : c).ToArray();
                var rejected=false;
                try { window.PrepareSessionForTest(changed); } catch (InvalidOperationException) { rejected=true; }
                check(rejected && store.GetForLoginWindow().Single(c=>c.Name=="auth_token").Value==saved.Single(c=>c.Name=="auth_token").Value,"changed browser identity cannot replace the active queue session");
            }
            save.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); save.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            while (clicks==0) await Task.Delay(10,timeout.Token);
            check(clicks==1 && calls[0]=="https://x.com/user/status/123" && !save.IsEnabled,"native save button submits one captured post and prevents duplicate clicks");
            release.TrySetResult();
            while (!save.IsEnabled) await Task.Delay(10,timeout.Token);
            await core.ExecuteScriptAsync("history.pushState({}, '', '/home')");
            while (save.IsEnabled) await Task.Delay(10,timeout.Token);
            check(!save.IsEnabled,"SPA navigation back to the timeline disables saving");
            await core.ExecuteScriptAsync("history.pushState({}, '', '/user/status/456')");
            while (!save.IsEnabled) await Task.Delay(10,timeout.Token);
            save.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            while (clicks<2) await Task.Delay(10,timeout.Token);
            check(calls[^1]=="https://x.com/user/status/456","SPA navigation submits the new post rather than a stale URL");
            check(!core.Settings.AreHostObjectsAllowed && !core.Settings.IsWebMessageEnabled,"browsing mode keeps page-to-app bridges disabled");
            updatesAllowed=true;
            var replacement=saved.Select(c=>c.Name=="auth_token" ? c with { Value=Guid.NewGuid().ToString("N") } : c).ToArray();
            window.PrepareSessionForTest(replacement);
            check(committed==1 && store.GetForLoginWindow().Single(c=>c.Name=="auth_token").Value==replacement.Single(c=>c.Name=="auth_token").Value,"session replacement is permitted only after the queue is idle");
        }
        finally { release.TrySetResult(); window.Close(); await window.CleanupAsync(); }
        check(!Directory.EnumerateDirectories(profiles).Any(),"browsing window also removes its temporary profile");
    }
}

using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using XDownloader.App;
using XDownloader.Auth;

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
        new XLoginService(store,profiles).Logout();
        Check(store.State==LoginState.Anonymous && !Directory.EnumerateDirectories(profiles).Any(),"logout leaves no stored session or browser profile");
    }
}

using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using XDownloader.Auth;
using XDownloader.Core;

Console.OutputEncoding=new UTF8Encoding(false);
var passed=0; var failed=0;
async Task Test(string label,Func<Task> test)
{
    try { await test(); Console.WriteLine("PASS "+label); passed++; }
    catch (Exception e) { Console.WriteLine("FAIL "+label+" ("+e.GetType().Name+")"); failed++; }
}
void Assert(bool condition) { if (!condition) throw new Exception("assertion failed"); }
void Throws<T>(Action action) where T:Exception
{ try { action(); } catch (T) { return; } throw new Exception("expected exception"); }
Task Sync(Action action) { action(); return Task.CompletedTask; }
var root=Path.Combine(Path.GetTempPath(),"xdownloader-auth-"+Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var now=DateTimeOffset.UtcNow;
string Fresh() => Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
var auth=Fresh(); var csrf=Fresh();
var cookies=new[] {new XCookie(".x.com","auth_token",auth,"/",true,true,now.AddDays(60).ToUnixTimeSeconds()),new XCookie(".x.com","ct0",csrf,"/",true,false,now.AddDays(60).ToUnixTimeSeconds())};
try
{
    var store=new WindowsLoginStore(Path.Combine(root,"auth"),()=>now);
    await Test("anonymous store returns no cookie lease",()=>Sync(()=> { Assert(store.State==LoginState.Anonymous); Assert(store.Acquire() is null); }));
    await Test("Windows DPAPI persistence never writes plaintext credentials",()=>Sync(()=>
    {
        store.Save(cookies);
        var bytes=File.ReadAllBytes(Path.Combine(root,"auth","session.dpapi"));
        Assert(!Encoding.UTF8.GetString(bytes).Contains(auth)); Assert(!Encoding.UTF8.GetString(bytes).Contains(csrf));
        var restored=new WindowsLoginStore(Path.Combine(root,"auth"),()=>now);
        Assert(restored.State==LoginState.Ready && restored.GetForLoginWindow().Count==2);
        Assert(!cookies[0].ToString().Contains(auth));
    }));
    await Test("auth directory ACL permits only current Windows user and SYSTEM",()=>Sync(()=>
    {
        var acl=new DirectoryInfo(Path.Combine(root,"auth")).GetAccessControl();
        Assert(acl.AreAccessRulesProtected);
        var allowed=new[]{WindowsIdentity.GetCurrent().User!.Value,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null).Value};
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
            Assert(rule.AccessControlType==AccessControlType.Allow && allowed.Contains(rule.IdentityReference.Value));
    }));
    await Test("cookie filtering excludes unrelated domains and unnecessary cookie names",()=>Sync(()=>
    {
        var extra=new[]{cookies[0] with {Domain=".evil.test"},cookies[0] with {Domain=".x.com.evil.test"},cookies[0] with {Name="unneeded"}};
        store.Save(cookies.Concat(extra));
        using var lease=store.Acquire()!;
        var text=File.ReadAllText(lease.FilePath);
        Assert(text.StartsWith("# Netscape HTTP Cookie File"));
        Assert(!text.Contains("evil.test") && !text.Contains("unneeded"));
        Assert(text.Contains("#HttpOnly_.x.com") && text.Contains("\tct0\t"));
        var acl=FileSystemAclExtensions.GetAccessControl(new FileInfo(lease.FilePath));
        var allowed=new[]{WindowsIdentity.GetCurrent().User!.Value,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null).Value};
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) Assert(allowed.Contains(rule.IdentityReference.Value));
    }));
    await Test("lease plaintext removed after dispose; dispose is idempotent",()=>Sync(()=>
    {
        var lease=store.Acquire()!; var file=lease.FilePath; Assert(File.Exists(file));
        lease.Dispose(); lease.Dispose(); Assert(!File.Exists(file) && !Directory.Exists(Path.GetDirectoryName(file)));
    }));
    await Test("logout and session replacement are blocked while an engine owns credentials",()=>Sync(()=>
    {
        using var lease=store.Acquire();
        Throws<InvalidOperationException>(store.Logout); Throws<InvalidOperationException>(()=>store.Save(cookies));
    }));
    await Test("parallel cookie leases remain isolated and protect session until the last release",async ()=>
    {
        var leases=await Task.WhenAll(Enumerable.Range(0,2).Select(_=>Task.Run(()=>store.Acquire()!)));
        Assert(leases[0].FilePath!=leases[1].FilePath);
        await Task.Run(leases[0].Dispose);
        Throws<InvalidOperationException>(store.Logout); Throws<InvalidOperationException>(()=>store.Save(cookies));
        Assert(File.Exists(leases[1].FilePath));
        await Task.Run(leases[1].Dispose);
        Assert(!File.Exists(leases[0].FilePath) && !File.Exists(leases[1].FilePath));
        store.Save(cookies);
    });
    foreach (var bad in new[]{cookies[0] with {Secure=false},cookies[0] with {HttpOnly=false},cookies[0] with {Value=Fresh()+"\n"},cookies[0] with {Expires=now.AddMinutes(-1).ToUnixTimeSeconds()},cookies[0] with {Domain="x.com"}})
        await Test("invalid/insecure/expired cookie cannot replace valid session",()=>Sync(()=>
        { Throws<InvalidOperationException>(()=>store.Save([bad,cookies[1]])); Assert(store.State==LoginState.Ready); }));
    await Test("stored login has a maximum 30 day lifetime",()=>Sync(()=>
    {
        var later=new WindowsLoginStore(Path.Combine(root,"auth"),()=>now.AddDays(31));
        Assert(later.State==LoginState.Expired); Throws<InvalidOperationException>(()=>later.Acquire());
    }));
    await Test("tampered encrypted state fails closed and logout recovers",()=>Sync(()=>
    {
        var path=Path.Combine(root,"auth","session.dpapi"); var bytes=File.ReadAllBytes(path); bytes[^1]^=1; File.WriteAllBytes(path,bytes);
        Assert(store.State==LoginState.Unreadable); Throws<InvalidOperationException>(()=>store.Acquire());
        store.Logout(); Assert(store.State==LoginState.Anonymous && !File.Exists(path)); store.Save(cookies);
    }));
    await Test("crash recovery removes only app-owned temporary credential directories",()=>Sync(()=>
    {
        var parent=Path.Combine(root,"auth","cookie-leases"); var orphan=PrivateFiles.CreateOwnedDirectory(parent);
        File.WriteAllText(Path.Combine(orphan,"cookies.txt"),Fresh());
        var unowned=Path.Combine(parent,"keep-this"); Directory.CreateDirectory(unowned); File.WriteAllText(Path.Combine(unowned,"keep"),"fixture");
        store.CleanInterruptedOperations(); Assert(!Directory.Exists(orphan)); Assert(File.Exists(Path.Combine(unowned,"keep")));
    }));
    await Test("private cleanup cannot escape its parent",()=>Sync(()=>
    {
        var parent=Path.Combine(root,"auth","cookie-leases");
        var outside=Path.Combine(root,Guid.NewGuid().ToString("N")); Directory.CreateDirectory(outside);
        File.WriteAllText(Path.Combine(outside,".owned"),"x-downloader-private-v1");
        PrivateFiles.DeleteOwnedDirectory(parent,outside); Assert(Directory.Exists(outside));
    }));
    var tools=Path.Combine(root,"tools"); Directory.CreateDirectory(tools);
    foreach (var name in new[]{"yt-dlp.exe","ffmpeg.exe","ffprobe.exe"}) File.WriteAllText(Path.Combine(tools,name),"fixture");
    var engine=new AuthEngine(); var service=new Downloader(tools,engine,store);
    await Test("authenticated analysis uses a private file path and removes the file",async()=>
    {
        await service.AnalyzeAsync("https://x.com/user/status/123",CancellationToken.None);
        Assert(engine.SawCredentials && !File.Exists(engine.LastCookiePath));
        Assert(!engine.Arguments!.Any(a=>a.Contains(auth) || a.Contains(csrf)));
    });
    await Test("authentication failure does not fall back to an anonymous retry",async()=>
    {
        engine.Error="Authentication required"; var calls=engine.Calls;
        try { await service.AnalyzeAsync("https://x.com/user/status/123",CancellationToken.None); throw new Exception(); }
        catch (InvalidOperationException e) { Assert(e.Message.Contains("再ログイン")); }
        Assert(engine.Calls==calls+1 && !File.Exists(engine.LastCookiePath)); engine.Error=null;
    });
    await Test("authenticated process cancellation cleans the credential lease",async()=>
    {
        using var cts=new CancellationTokenSource(); engine.Cancel=cts.Cancel;
        try { await service.AnalyzeAsync("https://x.com/user/status/123",cts.Token); throw new Exception(); }
        catch (OperationCanceledException) { }
        Assert(!File.Exists(engine.LastCookiePath)); engine.Cancel=null;
    });
    var video=(await service.AnalyzeAsync("https://x.com/user/status/123",CancellationToken.None))[0];
    await Test("authenticated download keeps cookies private until engine completion",async()=>
    {
        var output=Path.Combine(root,"downloads");
        var path=await service.DownloadAsync("https://x.com/user/status/123",video,video.Qualities[0],output,null,CancellationToken.None);
        Assert(File.Exists(path) && !File.Exists(engine.LastCookiePath) && engine.SawCredentials);
    });
    await Test("failed authenticated download removes transient credentials and media",async()=>
    {
        engine.Error="Authentication required";
        var output=Path.Combine(root,"failed-download");
        try { await service.DownloadAsync("https://x.com/user/status/123",video,video.Qualities[0],output,null,CancellationToken.None); throw new Exception(); }
        catch (InvalidOperationException e) { Assert(e.Message.Contains("再ログイン")); }
        Assert(!File.Exists(engine.LastCookiePath) && !Directory.EnumerateFileSystemEntries(output).Any()); engine.Error=null;
    });
    await Test("cancelled authenticated download removes transient credentials",async()=>
    {
        using var cts=new CancellationTokenSource(); engine.Cancel=cts.Cancel;
        var output=Path.Combine(root,"cancelled-download");
        try { await service.DownloadAsync("https://x.com/user/status/123",video,video.Qualities[0],output,null,cts.Token); throw new Exception(); }
        catch (OperationCanceledException) { }
        Assert(!File.Exists(engine.LastCookiePath) && !Directory.EnumerateFileSystemEntries(output).Any()); engine.Cancel=null;
    });
    await Test("logout deletes encrypted and transient credentials",()=>Sync(()=>
    { store.Logout(); Assert(store.State==LoginState.Anonymous); Assert(store.Acquire() is null); Assert(!File.Exists(Path.Combine(root,"auth","session.dpapi"))); }));
}
finally { Directory.Delete(root,true); }
Console.WriteLine($"RESULT AUTH {passed} passed; {failed} failed");
return failed==0?0:1;

sealed class AuthEngine : IEngineProcess
{
    public bool SawCredentials {get;private set;}
    public string? LastCookiePath {get;private set;}
    public IReadOnlyList<string>? Arguments {get;private set;}
    public string? Error {get;set;}
    public Action? Cancel {get;set;}
    public int Calls {get;private set;}
    public Task<EngineResult> RunAsync(string executable,IReadOnlyList<string> arguments,string workingDirectory,TimeSpan timeout,Action<string>? output,CancellationToken token)
    {
        if (executable.EndsWith("ffprobe.exe")) return Task.FromResult(new EngineResult(0,"{\"streams\":[{\"codec_type\":\"video\"}]}",""));
        Calls++; Arguments=arguments;
        var position=arguments.ToList().IndexOf("--cookies");
        LastCookiePath=position>=0 ? arguments[position+1] : null;
        SawCredentials=LastCookiePath is not null && File.Exists(LastCookiePath);
        if (!SawCredentials) throw new Exception("missing credentials");
        Cancel?.Invoke(); token.ThrowIfCancellationRequested();
        if (Error is not null) return Task.FromResult(new EngineResult(1,"",Error));
        if (!arguments.Contains("--dump-single-json"))
        {
            var file=Path.Combine(workingDirectory,"1231.mp4"); File.WriteAllText(file,"synthetic fixture");
            output?.Invoke("XD_FILE:"+System.Text.Json.JsonSerializer.Serialize(file));
            return Task.FromResult(new EngineResult(0,"",""));
        }
        return Task.FromResult(new EngineResult(0,"{\"id\":\"1231\",\"title\":\"fixture\",\"formats\":[{\"format_id\":\"mp4\",\"ext\":\"mp4\",\"protocol\":\"https\"}]}",""));
    }
}

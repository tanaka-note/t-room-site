using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TCloud.Sync.Windows;

internal static class EnrollmentTests
{
    public static async Task InitialSessionRequests()
    {
        var handler=new CaptureHandler();using var client=WindowsDeviceEnrollment.CreateInitialTransport(handler);
        foreach(var route in new[]{"/security/api/auth/options","/security/api/auth/verify","/security/api/auth/handoff",
            "/cloud/api/passkey/handoff","/cloud/api/windows-sync/enroll/challenge","/cloud/api/windows-sync/enroll/complete",
            "/cloud/api/logout","/security/api/logout"}) {
            using var response=await client.PostAsJsonAsync(route,new {service="cloud"});response.EnsureSuccessStatusCode();
        }
        var root=new DirectoryInfo(AppContext.BaseDirectory);
        while(root is not null&&!File.Exists(Path.Combine(root.FullName,"web-apps.json")))root=root.Parent;
        if(root is null)throw new InvalidOperationException("Repository fixture unavailable");
        var start=new ProcessStartInfo("node"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        start.ArgumentList.Add(Path.Combine(root.FullName,"tcloud-windows","tests","enrollment-http.mjs"));
        using var process=Process.Start(start)??throw new InvalidOperationException("Protocol fixture failed to start");
        var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(handler.Packets));process.StandardInput.Close();
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(15));await process.WaitForExitAsync(timeout.Token);
        if(process.ExitCode!=0||!string.IsNullOrWhiteSpace(await errors)||!(await output).StartsWith("PASS",StringComparison.Ordinal))
            throw new InvalidOperationException("Initial requests failed the current Security mutation guard: "+await errors);
        var failure=new WindowsEnrollmentHttpException("ログインの準備",new HttpRequestException("synthetic private server response",null,HttpStatusCode.Forbidden));
        if(!failure.Message.Contains("ログインの準備",StringComparison.Ordinal)||!failure.Message.Contains("HTTP 403",StringComparison.Ordinal)
            ||failure.Message.Contains("synthetic private",StringComparison.Ordinal))throw new InvalidOperationException("Enrollment status must identify the step without exposing the server response");
    }
    private sealed class CaptureHandler:HttpMessageHandler
    {
        public List<object> Packets {get;}=[];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            var headers=request.Headers.Concat(request.Content?.Headers.AsEnumerable()??[]).ToDictionary(h=>h.Key,h=>string.Join(",",h.Value),StringComparer.OrdinalIgnoreCase);
            Packets.Add(new{url=request.RequestUri!.AbsoluteUri,method=request.Method.Method,headers});
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=JsonContent.Create(new{ok=true})});
        }
    }
}

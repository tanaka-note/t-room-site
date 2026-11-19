using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public sealed class WindowsEnrollmentHttpException(string step,HttpRequestException inner)
    :HttpRequestException(inner.StatusCode is {} status?$"{step}に失敗しました（HTTP {(int)status}）。":$"{step}で通信を完了できませんでした。",inner,inner.StatusCode);

/// <summary>One initial passkey ceremony. Subsequent runs use only the persisted device proof.</summary>
public static class WindowsDeviceEnrollment
{
    /// <summary>Isolated initial Web session; keep the existing same-origin mutation protection.</summary>
    public static HttpClient CreateInitialTransport(HttpMessageHandler? handler=null)
    {
        var client=new HttpClient(handler??new HttpClientHandler {AllowAutoRedirect=false,UseCookies=true,CookieContainer=new CookieContainer()})
            {BaseAddress=new Uri(WindowsPasskey.Origin),Timeout=TimeSpan.FromSeconds(30),MaxResponseContentBufferSize=1024*1024};
        client.DefaultRequestHeaders.Add("Origin",WindowsPasskey.Origin);
        return client;
    }

    public static async Task<WindowsDeviceRegistration> EnrollAsync(nint owner, bool administrator, string destination,
        WindowsDeviceRegistrationFile file, IProgress<string>? progress=null, CancellationToken token=default,bool preferBestRole=false)
    {
        if(file.Exists)throw new InvalidOperationException("登録済みの端末情報を上書きしません。");
        var roots=new[]{Environment.GetEnvironmentVariable("OneDrive"),Environment.GetEnvironmentVariable("OneDriveConsumer"),
            Environment.GetEnvironmentVariable("OneDriveCommercial")}.OfType<string>();
        var volume=VolumeInspector.ValidateDestination(destination,roots);
        var dataKey=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var signingKey=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var imported=false;var signingCreated=false;var saved=false;
        using var client=CreateInitialTransport();
        var step="ログインの準備";
        try
        {
            progress?.Report("認証情報を確認しています。");
            var options=await Post(client,"/security/api/auth/options",new {service="cloud"},token);
            var request=WindowsPasskey.Prepare(options.GetProperty("options"));
            progress?.Report("Windowsの画面でパスキーの本人確認を行ってください。");
            using var assertion=await Task.Run(()=>WindowsPasskey.Authenticate(owner,request,token),token);
            step="パスキーの確認";
            var verified=await Post(client,"/security/api/auth/verify",new {service="cloud",
                challengeId=options.GetProperty("challengeId").GetString(),response=assertion.ServerResponse},token);
            if(!verified.GetProperty("authenticated").GetBoolean()
                || verified.GetProperty("credentialId").GetString()!=assertion.ServerResponse.GetProperty("id").GetString())
                throw new CryptographicException("本人確認の結果が一致しません。");
            var links=verified.GetProperty("links").EnumerateArray().ToArray();
            if(preferBestRole)administrator=links.Any(value=>value.GetProperty("accountId").GetString()=="admin");
            var link=administrator ? links.FirstOrDefault(value=>value.GetProperty("accountId").GetString()=="admin") : default;
            var linkId=administrator ? link.ValueKind==JsonValueKind.Object ? link.GetProperty("id").GetString() : null
                : links.Any(value=>value.GetProperty("accountId").GetString()=="folder-member") ? "cloud-member" : null;
            if(linkId is null)throw new CryptographicException("選択した利用区分への連携がありません。");
            step="利用権限の確認";
            var handoff=await Post(client,"/security/api/auth/handoff",new {service="cloud",linkId},token);
            step="T-Cloudへの接続";
            var session=await Post(client,"/cloud/api/passkey/handoff",new {handoffToken=handoff.GetProperty("handoffToken").GetString()},token);
            if(!session.GetProperty("authenticated").GetBoolean() || session.GetProperty("authMethod").GetString()!="passkey"
                || session.GetProperty("role").GetString()!=(administrator?"admin":"member")
                || session.GetProperty("credentialId").GetString()!=verified.GetProperty("credentialId").GetString())
                throw new CryptographicException("T-Cloudの認証結果が一致しません。");
            var sessionId=session.GetProperty("sessionCacheId").GetString();
            if(string.IsNullOrWhiteSpace(sessionId))throw new CryptographicException("T-Cloudの認証情報がありません。");
            client.DefaultRequestHeaders.Add("X-TCloud-Session",sessionId);
            step="管理者公開鍵の取得";
            JsonElement? adminPublic=administrator ? await PasskeyEnvelope.LoadAdministratorPublicKeyAsync(client,token) : null;
            progress?.Report("このPCの保護領域に鍵を準備しています。");
            var envelope=handoff.GetProperty("tcloudKey").GetProperty(administrator?"admin_private_prf":"client_private_prf");
            PasskeyEnvelope.Import(dataKey,assertion.GetPrfOutput(),envelope,administrator,adminPublic);imported=true;
            assertion.Dispose();
            WindowsDeviceKey.Create(signingKey);signingCreated=true;
            step="端末登録の準備";
            var challenge=await WindowsDeviceClient.PostJsonAsync(client,"enroll/challenge",new {publicKeyJwk=WindowsDeviceKey.PublicKey(signingKey)},token);
            var value=challenge.Deserialize<WindowsDeviceChallenge>(new JsonSerializerOptions(JsonSerializerDefaults.Web))
                ?? throw new CryptographicException("端末登録の確認情報が不正です。");
            var signature=WindowsDeviceKey.SignChallenge(signingKey,value,DateTimeOffset.UtcNow);
            var registration=new WindowsDeviceRegistration(1,value.DeviceId,value.ScopeHash,signingKey,dataKey,Path.GetFullPath(destination),volume);
            // Save before activation: if its reply is lost, restart can prove the
            // same device and recover, without importing another decryption key.
            file.Save(registration);saved=true;
            step="端末登録の確定";
            var result=await WindowsDeviceClient.PostJsonAsync(client,"enroll/complete",new {deviceId=value.DeviceId,
                challengeId=value.ChallengeId,nonce=value.Nonce,signature=Encode(signature)},token);
            if(result.GetProperty("deviceId").GetString()!=registration.DeviceId || result.GetProperty("scopeHash").GetString()!=registration.ScopeHash)
                throw new CryptographicException("端末の登録結果が一致しません。");
            progress?.Report("端末を登録しました。");return registration;
        }
        catch(HttpRequestException error){throw new WindowsEnrollmentHttpException(step,error);}
        finally
        {
            if(!saved) {if(signingCreated)WindowsDeviceKey.Delete(signingKey);if(imported)WindowsPrivateKey.Delete(dataKey);}
            // These are initial Web sessions only. Ending them does not revoke
            // the separately registered Windows device or erase HDD originals.
            using var cleanup=new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await EndSession(client,"/cloud/api/logout",cleanup.Token);
            await EndSession(client,"/security/api/logout",cleanup.Token);
        }
    }
    private static async Task<JsonElement> Post(HttpClient client,string route,object body,CancellationToken token)
    {
        using var response=await client.PostAsJsonAsync(route,body,token);
        if(!response.IsSuccessStatusCode)throw new HttpRequestException("認証APIで確認を完了できませんでした。",null,response.StatusCode);
        return await WindowsDeviceClient.ReadJsonAsync(response,token);
    }
    private static async Task EndSession(HttpClient client,string route,CancellationToken token)
    {
        try {await Post(client,route,new {},token);}
        catch(Exception error)when(error is HttpRequestException or OperationCanceledException or JsonException) { }
    }
    private static string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
}

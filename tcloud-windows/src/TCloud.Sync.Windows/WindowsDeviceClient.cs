using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public sealed class WindowsDeviceRevokedException() : UnauthorizedAccessException("端末の同期認可が失効しています。保存済みの原本は引き続き利用できます。");
public sealed class WindowsDeviceRegistrationIncompleteException() : InvalidOperationException("端末の初回登録が完了していません。最初の登録を再開してください。保存済み原本は保持されます。");

/// <summary>Windows-only automatic proof renewal; never renews a Web passkey session.</summary>
public sealed class WindowsDeviceClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public const string BaseUrl = WindowsPasskey.Origin + "/cloud/api/windows-sync/";
    private readonly HttpClient client;
    private readonly WindowsDeviceRegistration registration;
    private readonly SemaphoreSlim renewal = new(1,1);
    private readonly CancellationTokenSource lifetime = new();
    private string? accessToken;
    private long expiresAt;
    private bool disposed;

    public WindowsDeviceClient(HttpClient client, WindowsDeviceRegistration registration)
    {
        if (client.DefaultRequestHeaders.Authorization is not null || client.DefaultRequestHeaders.Contains("Cookie")
            || client.DefaultRequestHeaders.Contains("X-TCloud-Session")) throw new ArgumentException("同期には独立した通信設定を使用してください。",nameof(client));
        this.client = client; this.registration = registration;
    }
    public static HttpClient CreateTransport() => new(new HttpClientHandler { AllowAutoRedirect=false, UseCookies=false })
    { Timeout=TimeSpan.FromMinutes(10) };

    public Task<HttpResponseMessage> SendDataAsync(string route, HttpMethod method,
        Func<HttpContent>? content = null, Action<HttpRequestMessage>? configure = null, CancellationToken token = default)
        => SendAsync("data/"+route,method,content,configure,token);

    public async Task<HttpResponseMessage> SendAsync(string route, HttpMethod method,
        Func<HttpContent>? content = null, Action<HttpRequestMessage>? configure = null, CancellationToken token = default)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        using var linked=CancellationTokenSource.CreateLinkedTokenSource(token,lifetime.Token);token=linked.Token;
        for (var attempt=0; attempt<2; attempt++)
        {
            await EnsureAccessAsync(attempt!=0, token);
            using var request = new HttpRequestMessage(method, BaseUrl + route) { Content=content?.Invoke() };
            configure?.Invoke(request);
            ValidateDestination(request.RequestUri, route.Split('/')[0]+(route.Contains('/')?"/":""));
            request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",accessToken);
            var response = await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token);
            if (response.StatusCode!=HttpStatusCode.Unauthorized) return response;
            var error = await ReadJsonAsync(response,token); response.Dispose();
            var code = error.TryGetProperty("code",out var field) ? field.GetString() : null;
            if (code=="device_revoked") throw new WindowsDeviceRevokedException();
            if (code!="access_expired" || attempt!=0) throw new UnauthorizedAccessException("同期の認可を確認できません。");
        }
        throw new UnauthorizedAccessException("同期の認可を確認できません。");
    }

    public async Task<JsonElement> ReadKeysAsync(CancellationToken token=default)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        using var linked=CancellationTokenSource.CreateLinkedTokenSource(token,lifetime.Token);token=linked.Token;
        using var response=await SendAsync("keys",HttpMethod.Get,token:token);
        var value=await ReadJsonAsync(response,token);
        RequireSuccess(response,value);
        if (value.GetProperty("scopeHash").GetString()!=registration.ScopeHash) throw new CryptographicException("同期範囲が登録と一致しません。");
        return value;
    }

    private async Task EnsureAccessAsync(bool force, CancellationToken token)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        await renewal.WaitAsync(token);
        try
        {
            if (!force && accessToken is not null && expiresAt>DateTimeOffset.UtcNow.ToUnixTimeSeconds()+60) return;
            var challenge=await PostJsonAsync(client,"challenge",new {deviceId=registration.DeviceId},token);
            var value=challenge.Deserialize<WindowsDeviceChallenge>(Json) ?? throw new CryptographicException("端末認可の応答が不正です。");
            if (value.DeviceId!=registration.DeviceId || value.ScopeHash!=registration.ScopeHash) throw new CryptographicException("端末認可の対象が一致しません。");
            var signature=WindowsDeviceKey.SignChallenge(registration.SigningKeyId,value,DateTimeOffset.UtcNow);
            var proof=new { deviceId=value.DeviceId,challengeId=value.ChallengeId,nonce=value.Nonce,signature=Encode(signature) };
            var granted=await PostJsonAsync(client,"token",proof,token);
            SetAccess(granted);
        }
        finally { renewal.Release(); }
    }

    private void SetAccess(JsonElement granted)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        if (granted.GetProperty("deviceId").GetString()!=registration.DeviceId || granted.GetProperty("scopeHash").GetString()!=registration.ScopeHash)
            throw new CryptographicException("同期の認可範囲が一致しません。");
        var value=granted.GetProperty("accessToken").GetString() ?? "";
        _=WindowsPasskey.Decode(value,32,32);
        var expires=granted.GetProperty("expiresAt").GetInt64();var current=DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if(expires<=current || expires>current+900)throw new CryptographicException("同期の認可期限が不正です。");
        accessToken=value;expiresAt=expires;
    }

    public static async Task<JsonElement> PostJsonAsync(HttpClient client,string route,object value,CancellationToken token)
    {
        var destination=new Uri(BaseUrl+route); ValidateDestination(destination,"");
        using var request=new HttpRequestMessage(HttpMethod.Post,destination) {Content=JsonContent.Create(value)};
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token);
        var result=await ReadJsonAsync(response,token);RequireSuccess(response,result);return result;
    }
    private static void RequireSuccess(HttpResponseMessage response,JsonElement value)
    {
        if(response.IsSuccessStatusCode)return;
        if(response.StatusCode==HttpStatusCode.Unauthorized && value.TryGetProperty("code",out var code))
        {
            if(code.GetString()=="device_revoked")throw new WindowsDeviceRevokedException();
            if(code.GetString()=="initial_auth_incomplete")throw new WindowsDeviceRegistrationIncompleteException();
        }
        throw new HttpRequestException("同期APIで確認を完了できませんでした。",null,response.StatusCode);
    }
    internal static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response,CancellationToken token,int maxBytes=65536)
    {
        await response.Content.LoadIntoBufferAsync(maxBytes,token);
        using var document=JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));return document.RootElement.Clone();
    }
    private static void ValidateDestination(Uri? destination,string suffix)
    {
        if(destination is null || !destination.IsAbsoluteUri || destination.UserInfo.Length!=0 || destination.Fragment.Length!=0
            || !destination.AbsoluteUri.StartsWith(BaseUrl+suffix,StringComparison.Ordinal))throw new ArgumentException("同期先のURLが不正です。");
    }
    private static string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
    public void Dispose() {if(disposed)return;disposed=true;lifetime.Cancel();accessToken=null;expiresAt=0;}
}

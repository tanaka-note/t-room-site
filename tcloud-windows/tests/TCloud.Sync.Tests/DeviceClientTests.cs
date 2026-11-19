using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class DeviceClientTests
{
    public static async Task PersistentDevice()
    {
        var directory=Path.Combine(Path.GetTempPath(),"tcloud-device-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var key=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        WindowsDeviceKey.Create(key);
        try
        {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(SHA256.HashData("scope"u8)),
                key,Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),Path.Combine(directory,"originals"),new VolumeBinding("fixture-volume",1,"originals"));
            var path=Path.Combine(directory,"registration.dat");
            var file=new WindowsDeviceRegistrationFile(path);file.Save(registration);
            Check(file.Load()==registration,"registration survives reopening without Cookie or exported key");
            var relocated=Path.Combine(directory,"relocated.dat");File.Copy(path,relocated);
            Throws<CryptographicException>(()=>new WindowsDeviceRegistrationFile(relocated).Load());
            var original=File.ReadAllBytes(path);var corrupt=original.ToArray();corrupt[corrupt.Length/2]^=1;File.WriteAllBytes(path,corrupt);
            Throws<CryptographicException>(()=>file.Load());File.WriteAllBytes(path,original);
            using var handler=new DeviceHandler(registration);
            using var transport=new HttpClient(handler);
            using(var client=new WindowsDeviceClient(transport,file.Load()))
            {
                await Task.WhenAll(Enumerable.Range(0,6).Select(async _=>{using var response=await client.SendDataAsync("items",HttpMethod.Get);Check(response.IsSuccessStatusCode,"authorized data access");}));
                Check(handler.Proofs==1,"concurrent first requests share one device proof");
                var source=new CloudContentSource(client,17,128,91);
                var ciphertext=await source.ReadAsync(16,64,"\"fixture-version\"",CancellationToken.None);
                Check(ciphertext.Ciphertext.Length==64 && ciphertext.Ciphertext.All(value=>value==42),"ciphertext ranges use automatic device authorization");
                handler.ExpireNext=true;
                using var retried=await client.SendDataAsync("items",HttpMethod.Get);
                Check(retried.IsSuccessStatusCode && handler.Proofs==2,"server expiry renews once without passkey input");
                var catalog=new WindowsCatalogClient(client);
                var start=await catalog.StartAsync();
                var page=await catalog.PageAsync(start,0,true);
                Check(page.Complete&&page.Items.Single().Id==17,"snapshot requests share the independently renewed device transport");
                handler.BadCursor=true;
                await ThrowsAsync<InvalidDataException>(async()=>{await catalog.PageAsync(start,0,true);});
                handler.BadCursor=false;handler.ResetCatalog=true;
                await ThrowsAsync<WindowsCatalogResetException>(async()=>{await catalog.PageAsync(start,0,true);});
                handler.ResetCatalog=false;
                Check((await client.ReadKeysAsync()).GetProperty("scopeHash").GetString()==registration.ScopeHash,"key envelopes stay bound to the enrolled scope");
                await ThrowsAsync<ArgumentException>(async()=>{using var response=await client.SendDataAsync("https://attacker.test",HttpMethod.Get,
                    configure:request=>request.RequestUri=new Uri("https://attacker.test/"));});
            }
            using(var restarted=new WindowsDeviceClient(transport,file.Load()))
            {
                handler.Unavailable=true;
                await ThrowsAsync<HttpRequestException>(async()=>{using var response=await restarted.SendDataAsync("items",HttpMethod.Get);});
                handler.Unavailable=false;
                using var response=await restarted.SendDataAsync("items",HttpMethod.Get);
                Check(response.IsSuccessStatusCode && handler.Proofs==3,"new client resumes using only PC-protected state");
            }
            using(var changed=new WindowsDeviceClient(transport,file.Load()))
            {
                handler.WrongScope=true;
                await ThrowsAsync<CryptographicException>(async()=>{using var response=await changed.SendDataAsync("items",HttpMethod.Get);});
                handler.WrongScope=false;
            }
            using(var incomplete=new WindowsDeviceClient(transport,file.Load()))
            {
                handler.InitialIncomplete=true;
                await ThrowsAsync<WindowsDeviceRegistrationIncompleteException>(async()=>{using var response=await incomplete.SendDataAsync("items",HttpMethod.Get);});
                handler.InitialIncomplete=false;
                Check(file.Exists,"an incomplete first activation is distinct from revocation and never erases the saved device record");
            }
            using(var revoked=new WindowsDeviceClient(transport,file.Load()))
            {
                handler.Revoked=true;
                await ThrowsAsync<WindowsDeviceRevokedException>(async()=>{using var response=await revoked.SendDataAsync("items",HttpMethod.Get);});
                Check(file.Exists,"revocation never deletes local state or HDD originals in the transport layer");
            }
        }
        finally {WindowsDeviceKey.Delete(key);Directory.Delete(directory,true);}
    }
    internal sealed class DeviceHandler(WindowsDeviceRegistration registration):HttpMessageHandler
    {
        public int Proofs; public bool ExpireNext;public bool Unavailable;public bool Revoked;public bool WrongScope;public bool BadCursor;public bool ResetCatalog;public bool InitialIncomplete;
        private WindowsDeviceChallenge? challenge;
        public Func<HttpRequestMessage,HttpResponseMessage?>? Data;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            Check(request.RequestUri!.AbsoluteUri.StartsWith(WindowsDeviceClient.BaseUrl,StringComparison.Ordinal),"fixed destination");
            Check(!request.Headers.Contains("Cookie")&&!request.Headers.Contains("X-TCloud-Session"),"no Web session is reused");
            var route=request.RequestUri.AbsoluteUri[WindowsDeviceClient.BaseUrl.Length..];
            if(route=="challenge")
            {
                Check(request.Headers.Authorization is null,"proof request has no old access token");
                if(Unavailable)return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable){Content=new StringContent("synthetic edge outage",System.Text.Encoding.UTF8,"text/html")};
                if(Revoked)return Response(HttpStatusCode.Unauthorized,new {code="device_revoked"});
                if(InitialIncomplete)return Response(HttpStatusCode.Unauthorized,new {code="initial_auth_incomplete"});
                challenge=new(registration.DeviceId,Guid.NewGuid().ToString("N"),Encode(RandomNumberGenerator.GetBytes(32)),
                    WrongScope?new string('0',64):registration.ScopeHash,DateTimeOffset.UtcNow.AddMinutes(2).ToUnixTimeSeconds());
                return Response(HttpStatusCode.OK,challenge);
            }
            if(route=="token")
            {
                using var body=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                Check(challenge is not null,"one-use challenge exists");
                var signature=Decode(body.RootElement.GetProperty("signature").GetString()!,64);
                using var verifier=ECDsa.Create();
                var jwk=WindowsDeviceKey.PublicKey(registration.SigningKeyId);
                verifier.ImportParameters(new ECParameters {Curve=ECCurve.NamedCurves.nistP256,
                    Q=new ECPoint {X=Decode(jwk.GetProperty("x").GetString()!,32),Y=Decode(jwk.GetProperty("y").GetString()!,32)}});
                Check(verifier.VerifyData(WindowsDeviceKey.ChallengeMessage(challenge!,DateTimeOffset.UtcNow),signature,
                    HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation),"server independently verifies device signature");
                challenge=null;Interlocked.Increment(ref Proofs);
                return Response(HttpStatusCode.OK,new {deviceId=registration.DeviceId,scopeHash=registration.ScopeHash,
                    accessToken=Encode(RandomNumberGenerator.GetBytes(32)),expiresAt=DateTimeOffset.UtcNow.AddMinutes(15).ToUnixTimeSeconds()});
            }
            Check(request.Headers.Authorization?.Scheme=="Bearer","data request uses Windows access token");
            if(ExpireNext){ExpireNext=false;return Response(HttpStatusCode.Unauthorized,new {code="access_expired"});}
            if(Data?.Invoke(request) is {} data)return data;
            if(route=="content/17")
            {
                Check(request.Headers.GetValues("X-TCloud-Revision").Single()=="91","the first body is pinned to its metadata revision");
                Check(request.Headers.Range?.ToString()=="bytes=16-79" && request.Headers.IfMatch.Single().Tag=="\"fixture-version\"","range and version survive authorization");
                var ranged=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(Enumerable.Repeat((byte)42,64).ToArray())};
                ranged.Content.Headers.ContentRange=new System.Net.Http.Headers.ContentRangeHeaderValue(16,79,128);
                ranged.Headers.ETag=new System.Net.Http.Headers.EntityTagHeaderValue("\"fixture-version\"");return ranged;
            }
            if(route=="catalog/start")return Response(HttpStatusCode.OK,new {epoch=new string('a',32),cursor=91});
            if(route.StartsWith("catalog/snapshot?",StringComparison.Ordinal))
            {
                if(ResetCatalog)return Response(HttpStatusCode.Conflict,new {code="catalog_reset"});
                return Response(HttpStatusCode.OK,new {epoch=new string('a',32),until=91,next=91,complete=!BadCursor,
                    items=new[]{new {kind="file",id=17,revision=91,state="present",value=new {name="fixture"}}}});
            }
            return Response(HttpStatusCode.OK,new {scopeHash=registration.ScopeHash});
        }
        private static HttpResponseMessage Response(HttpStatusCode status,object body)=>new(status){Content=JsonContent.Create(body)};
    }
    private static string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
    private static byte[] Decode(string value,int length)
    {
        var bytes=Convert.FromBase64String(value.Replace('-','+').Replace('_','/').PadRight((value.Length+3)/4*4,'='));
        Check(bytes.Length==length && Encode(bytes)==value,"canonical fixture encoding");return bytes;
    }
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    private static void Throws<T>(Action action)where T:Exception {try{action();}catch(T){return;}throw new InvalidOperationException("Expected "+typeof(T).Name);}
    private static async Task ThrowsAsync<T>(Func<Task> action)where T:Exception {try{await action();}catch(T){return;}throw new InvalidOperationException("Expected "+typeof(T).Name);}
}

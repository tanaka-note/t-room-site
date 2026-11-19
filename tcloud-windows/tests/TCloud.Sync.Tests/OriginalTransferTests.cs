using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class OriginalTransferTests
{
    public static async Task Pipeline()
    {
        var outer=Path.Combine(Path.GetTempPath(),"tcloud-cfapi-"+Guid.NewGuid().ToString("N"));
        var directory=Path.Combine(outer,"mounted");Directory.CreateDirectory(directory);
        var signer=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));WindowsDeviceKey.Create(signer);
        var folderKey=RandomNumberGenerator.GetBytes(32);var fileKey=RandomNumberGenerator.GetBytes(32);var plain=RandomNumberGenerator.GetBytes(3*1024*1024+17);
        CloudFilesRootRegistration? root=null;
        try
        {
            using var rsa=RSA.Create(2048);
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),signer,
                Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),directory,VolumeInspector.ValidateDestination(directory,[]));
            root=CloudFilesRootRegistration.Attach(registration,[],initialize:true);registration=registration with {RootFileId=root.FileId};
            var wrap=CloudFileCrypto.WrapFile(folderKey,fileKey);
            var metadata=CloudFileCrypto.EncryptMetadata(fileKey,new("fixture.bin","application/octet-stream","other",0));
            var ciphertext=EncryptedChunks.Encrypt(fileKey,plain,0);
            var folder=new WindowsCatalogEntry("folder",7,16,"present",JsonSerializer.SerializeToElement(new {id=7,parentId=(long?)null,name="saved",cryptoVersion=0}),null,null);
            var file=new WindowsCatalogEntry("file",17,17,"present",JsonSerializer.SerializeToElement(new {id=17,folderId=7,name="[encrypted]",cryptoVersion=1,
                sizeBytes=plain.Length,chunkSizeBytes=8*1024*1024,chunkCount=1,encryptedSizeBytes=ciphertext.Length,
                encryptedMetadata=metadata.Ciphertext,metadataIv=metadata.Iv,wrappedFileKey=wrap.Ciphertext,fileKeyIv=wrap.Iv}),null,null);
            var keys=JsonSerializer.SerializeToElement(new {scopeHash=registration.ScopeHash,folderKeys=new[]{new {rootFolderId=7,wrappedKey=Encode(rsa.Encrypt(folderKey,RSAEncryptionPadding.OaepSHA256))}}});
            using var handler=new DeviceClientTests.DeviceHandler(registration){Data=request=>
            {
                var route=request.RequestUri!.AbsoluteUri[WindowsDeviceClient.BaseUrl.Length..];
                if(route=="keys")return Json(keys);
                if(route=="catalog/start")return Json(new {epoch=new string('a',32),cursor=17});
                if(route.StartsWith("catalog/snapshot?",StringComparison.Ordinal))return Json(new WindowsCatalogPage(new string('a',32),17,17,true,[folder,file]));
                if(route=="content/17")
                {
                    Check(request.Headers.GetValues("X-TCloud-Revision").Single()=="17","body requests are bound to the catalog revision");
                    var from=request.Headers.Range!.Ranges.Single().From!.Value;var to=request.Headers.Range.Ranges.Single().To!.Value;
                    var result=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(ciphertext.AsSpan((int)from,(int)(to-from+1)).ToArray())};
                    result.Content.Headers.ContentRange=new ContentRangeHeaderValue(from,to,ciphertext.Length);result.Headers.ETag=new("\"fixture-body\"");return result;
                }
                return null;
            }};
            using(var transport=new HttpClient(handler))
            using(var device=new WindowsDeviceClient(transport,registration))
            {
                var api=new WindowsCatalogClient(device);var start=await api.StartAsync();var page=await api.PageAsync(start,0,true);
                using var resolver=new CloudOriginalResolver(rsa,page.Items,await device.ReadKeysAsync());
                var catalog=new LocalSyncCatalog(Path.Combine(outer,"pc-catalog.json"),registration);
                var state=LocalSyncCatalog.ApplyPage(catalog.Empty(),start,page);
                var transfer=new WindowsOriginalTransfer(device,root,resolver,registration,Path.Combine(outer,"staging"),async(descriptor,hash,token)=>
                {
                    state=state with {Originals=[new(descriptor.Id,descriptor.Revision,descriptor.RelativePath,descriptor.Identity,descriptor.SizeBytes,hash,false)]};
                    await catalog.SaveAsync(state,token);
                });
                var descriptor=transfer.Register(page.Items.Single(i=>i.Kind=="file"));
                using(var provider=new CloudFilesProvider(root,transfer.OpenAsync))
                {
                    provider.Add(descriptor.RelativePath,descriptor.SizeBytes,descriptor.Identity);
                    handler.ExpireNext=true;
                    await provider.HydrateAsync(descriptor.RelativePath);
                    Check(handler.Proofs==2,"an expired access grant renews without another passkey during the real CFAPI download");
                    Check(provider.Errors.IsEmpty,"the integrated provider completed without callback errors");
                    Check((await catalog.LoadAsync()).Originals.Single().Sha256==Convert.ToHexString(SHA256.HashData(plain)),"the baseline is checkpointed before foreground access");
                    state=state with {Originals=[state.Originals.Single() with {Complete=true}]};await catalog.SaveAsync(state);
                }
            }
            Check((await HydrationProbe.ReadAsync(Path.Combine(directory,"saved","fixture.bin"),plain)).Succeeded,
                "an independent consumer reads the saved original after device transport and provider shutdown");
            Check(!Directory.EnumerateFiles(Path.Combine(outer,"staging")).Any(),"no extra staged plaintext remains after installation");
            root.UnregisterPreservingOriginals();root=null;
        }
        finally
        {
            root?.UnregisterPreservingOriginals();WindowsDeviceKey.Delete(signer);
            CryptographicOperations.ZeroMemory(folderKey);CryptographicOperations.ZeroMemory(fileKey);CryptographicOperations.ZeroMemory(plain);Directory.Delete(outer,true);
        }
    }
    private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK){Content=JsonContent.Create(value)};
    private static string Encode(byte[] value)=>Convert.ToBase64String(value).TrimEnd('=').Replace('+','-').Replace('/','_');
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
}

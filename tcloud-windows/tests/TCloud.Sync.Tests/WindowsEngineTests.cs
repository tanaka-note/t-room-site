using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class WindowsEngineTests
{
    public static async Task RoundTrip()
    {
        var outer=Path.Combine(Path.GetTempPath(),"tcloud-engine-"+Guid.NewGuid().ToString("N"));
        var directory=Path.Combine(outer,"originals");Directory.CreateDirectory(directory);
        var signer=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));var dataKey=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        WindowsDeviceKey.Create(signer);using var rsa=RSA.Create(2048);var blob=rsa.ExportPkcs8PrivateKey();
        try{WindowsPrivateKey.Import(dataKey,blob);}finally{CryptographicOperations.ZeroMemory(blob);}
        var folderKey=RandomNumberGenerator.GetBytes(32);var fileKey=RandomNumberGenerator.GetBytes(32);
        CloudFilesRootRegistration? root=null;
        try {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),signer,dataKey,directory,VolumeInspector.ValidateDestination(directory,[]));
            root=CloudFilesRootRegistration.Attach(registration,[],initialize:true);registration=registration with {RootFileId=root.FileId};
            var wrap=CloudFileCrypto.WrapFile(folderKey,fileKey);var initial=Encoding.UTF8.GetBytes("initial original");
            var meta=CloudFileCrypto.EncryptMetadata(fileKey,new("fixture.txt","text/plain","document",1));
            var folder=new WindowsCatalogEntry("folder",7,16,"present",JsonSerializer.SerializeToElement(new{id=7,parentId=(long?)null,name="saved",cryptoVersion=0}),null,null);
            var remoteFolders=new Dictionary<long,WindowsCatalogEntry>{{7,folder}};
            long revision=17;var remote=new Dictionary<long,WindowsCatalogEntry>();var bodies=new Dictionary<long,byte[]>{{17,EncryptedChunks.Encrypt(fileKey,initial,0)}};
            var contentVersion=new string('a',64);
            WindowsCatalogEntry FileEntry(long id,JsonElement request,long rev,string version)=>new("file",id,rev,"present",JsonSerializer.SerializeToElement(new {
                id,folderId=request.TryGetProperty("folderId",out var folderId)?folderId.GetInt64():7,name="[encrypted]",cryptoVersion=1,sizeBytes=request.GetProperty("sizeBytes").GetInt64(),
                chunkSizeBytes=request.GetProperty("chunkSizeBytes").GetInt32(),chunkCount=request.GetProperty("chunkCount").GetInt32(),
                encryptedSizeBytes=request.GetProperty("encryptedSizeBytes").GetInt64(),encryptedMetadata=request.GetProperty("encryptedMetadata").GetString(),
                metadataIv=request.GetProperty("metadataIv").GetString(),wrappedFileKey=request.GetProperty("wrappedFileKey").GetString(),fileKeyIv=request.GetProperty("fileKeyIv").GetString(),contentVersion=version}),null,null);
            remote[17]=FileEntry(17,JsonSerializer.SerializeToElement(new{sizeBytes=initial.Length,chunkSizeBytes=8*1024*1024,chunkCount=1,encryptedSizeBytes=initial.Length+32,
                encryptedMetadata=meta.Ciphertext,metadataIv=meta.Iv,wrappedFileKey=wrap.Ciphertext,fileKeyIv=wrap.Iv}),revision,contentVersion);
            var keys=JsonSerializer.SerializeToElement(new{scopeHash=registration.ScopeHash,folderKeys=new[]{new{rootFolderId=7,wrappedKey=Encode(rsa.Encrypt(folderKey,RSAEncryptionPadding.OaepSHA256))}}});
            var pending=new Dictionary<string,(JsonElement Body,List<byte[]> Parts,object? Result)>();int committed=0,deleteCalls=0;long nextFile=18;bool loseCompletion=true,retryPart=true;
            var createdFolders=new Dictionary<string,long>();var publicKey=rsa.ExportParameters(false);
            object Ack(string op,long target)=>new{operationId=op,uploadId=100,fileId=target,state="committed",revision,archiveId=(long?)100,contentVersion};
            var gate=new object();bool backlogBlocked=false;int deferredReads=0;
            using var handler=new DeviceClientTests.DeviceHandler(registration){Data=request=>{
                lock(gate) {
                    var route=request.RequestUri!.AbsoluteUri[WindowsDeviceClient.BaseUrl.Length..];
                    if(route=="keys")return Json(keys);
                    if(route=="data/crypto-config")return Json(new{initialized=true,cryptoVersion=1,publicKeyJwk=new{kty="RSA",n=Encode(publicKey.Modulus!),e=Encode(publicKey.Exponent!)}});
                    if(route=="data/windows-folders") {
                        using var doc=JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());var value=doc.RootElement;
                        var op=value.GetProperty("operationId").GetString()!;
                        if(!createdFolders.TryGetValue(op,out var id)) {
                            id=8;createdFolders[op]=id;var properties=value.Deserialize<Dictionary<string,JsonElement>>()!;
                            properties["id"]=JsonSerializer.SerializeToElement(id);
                            remoteFolders[id]=new("folder",id,++revision,"present",JsonSerializer.SerializeToElement(properties),null,null);
                        }
                        return Json(new{id,operationId=op});
                    }
                    if(request.Method==HttpMethod.Delete)deleteCalls++;
                    if(route.StartsWith("content/",StringComparison.Ordinal)) {
                        var id=long.Parse(route[8..]);
                        if(id==999&&backlogBlocked){deferredReads++;return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable){Content=new StringContent("synthetic unavailable original")};}
                        var bytes=bodies[id];var range=request.Headers.Range!.Ranges.Single();var from=range.From!.Value;var to=range.To!.Value;
                        var response=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(bytes.AsSpan((int)from,(int)(to-from+1)).ToArray())};
                        response.Headers.ETag=new("\"body-"+id+"-"+remote[id].Revision+"\"");response.Content.Headers.ContentRange=new ContentRangeHeaderValue(from,to,bytes.Length);return response;
                    }
                    if(route=="data/windows-updates") {
                        using var doc=JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());var body=doc.RootElement.Clone();var op=body.GetProperty("operationId").GetString()!;
                        if(!pending.ContainsKey(op)) {
                            pending[op]=(body,[],null);var target=body.GetProperty("fileId");
                            Console.WriteLine("ENGINE fixture: preparing "+(target.ValueKind==JsonValueKind.Null?"new":target.GetRawText())+" at revision "+revision);
                        }
                        return Json(pending[op].Result??new{operationId=op,uploadId=100,fileId=17,state="pending"});
                    }
                    if(route=="data/uploads/100/parts/1") {
                        var active=pending.Last(p=>p.Value.Result is null);active.Value.Parts.Clear();active.Value.Parts.Add(request.Content!.ReadAsByteArrayAsync().GetAwaiter().GetResult());return Json(new{partNumber=1,etag="stored"});
                    }
                    if(route.StartsWith("data/windows-updates/",StringComparison.Ordinal)&&route.EndsWith("/complete",StringComparison.Ordinal)) {
                        var op=route.Split('/')[2];var active=pending[op];if(active.Result is not null)return Json(active.Result);
                        if(retryPart){retryPart=false;return new HttpResponseMessage(HttpStatusCode.Conflict){Content=JsonContent.Create(new{code="parts_retry_required"})};}
                        var target=active.Body.GetProperty("fileId").ValueKind==JsonValueKind.Null?nextFile++:active.Body.GetProperty("fileId").GetInt64();
                        bodies[target]=active.Parts.Single();revision++;committed++;contentVersion=Convert.ToHexString(SHA256.HashData(bodies[target])).ToLowerInvariant();
                        remote[target]=FileEntry(target,active.Body,revision,contentVersion);var ack=Ack(op,target);pending[op]=(active.Body,active.Parts,ack);
                        if(loseCompletion){loseCompletion=false;throw new HttpRequestException("synthetic lost completion reply");}
                        return Json(ack);
                    }
                    if(route.StartsWith("data/files/",StringComparison.Ordinal)&&request.Method==HttpMethod.Patch) {
                        var id=long.Parse(route.Split('/')[2]);using var doc=JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                        if(remote[id].State!="present")return new HttpResponseMessage(HttpStatusCode.NotFound){Content=JsonContent.Create(new{error="synthetic trashed file"})};
                        if(remote[id].Revision!=doc.RootElement.GetProperty("windowsExpectedRevision").GetInt64())return new HttpResponseMessage(HttpStatusCode.Conflict){Content=JsonContent.Create(new{error="synthetic changed head"})};
                        Console.WriteLine("ENGINE fixture: patching "+id+" at revision "+revision);
                        var body=doc.RootElement;var dict=remote[id].Value!.Value.Deserialize<Dictionary<string,JsonElement>>()!;
                        dict["encryptedMetadata"]=body.GetProperty("encryptedMetadata").Clone();dict["metadataIv"]=body.GetProperty("metadataIv").Clone();
                        dict["wrappedFileKey"]=body.GetProperty("wrappedFileKey").Clone();dict["fileKeyIv"]=body.GetProperty("fileKeyIv").Clone();
                        remote[id]=remote[id] with {Revision=++revision,Value=JsonSerializer.SerializeToElement(dict)};return Json(new{ok=true});
                    }
                    if(route.StartsWith("data/folders/",StringComparison.Ordinal)&&request.Method==HttpMethod.Patch) {
                        var id=long.Parse(route.Split('/')[2]);using var doc=JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
                        var properties=remoteFolders[id].Value!.Value.Deserialize<Dictionary<string,JsonElement>>()!;properties["name"]=doc.RootElement.GetProperty("name").Clone();
                        remoteFolders[id]=remoteFolders[id] with {Revision=++revision,Value=JsonSerializer.SerializeToElement(properties)};return Json(new{ok=true});
                    }
                    throw new InvalidOperationException("Unexpected synthetic engine route: "+route);
                }
            }};
            using var transport=new HttpClient(handler);using var device=new WindowsDeviceClient(transport,registration);
            var catalog=new LocalSyncCatalog(Path.Combine(outer,"pc","catalog.json"),registration);
            await catalog.SaveAsync(catalog.Empty());
            WindowsSyncEngine? engine=null;
            async Task Publish() {
                WindowsCatalogEntry[] entries;long cursor;lock(gate){entries=[..remoteFolders.Values,..remote.Values];cursor=revision;}
                var state=await catalog.UpdateAsync(s=>s with {Remote=entries,RemotePosition=new(new string('a',32),cursor)});
                if(engine is not null)await engine.ReconcileAsync(state,CancellationToken.None);
            }
            async Task Wait(Func<bool> condition,string message) {
                var deadline=DateTime.UtcNow.AddSeconds(25);
                while(DateTime.UtcNow<deadline){await Publish();if(engine!.Completion.IsCompleted)await engine.Completion;if(condition())return;await Task.Delay(200);}
                var state=await catalog.LoadAsync();
                throw new TimeoutException(message+"; errors="+string.Join(";",engine!.Errors.Select(e=>e.GetType().Name+":"+e.Message))+"; originals="+JsonSerializer.Serialize(state.Originals)+"; remote="+revision);
            }
            await Publish();
            engine=new(device,registration,root,catalog,Path.Combine(outer,"pc"));
            try {
                var path=Path.Combine(directory,"saved","fixture.txt");
                await Wait(()=>File.Exists(path)&&(CloudFilesLocalStorage.PlaceholderState(path)&0x30)==0,"initial retained download");
                Check(await File.ReadAllTextAsync(path)=="initial original","download retains the original");
                Console.WriteLine("ENGINE fixture: initial retained");
                var backlogPath=Path.Combine(directory,"saved","backlog.txt");
                var backlogMetadata=CloudFileCrypto.EncryptMetadata(fileKey,new("backlog.txt","text/plain","document",1));
                lock(gate) {
                    var current=remote[17];remote.Clear();backlogBlocked=true;
                    bodies[999]=EncryptedChunks.Encrypt(fileKey,initial,0);
                    remote[999]=FileEntry(999,JsonSerializer.SerializeToElement(new{sizeBytes=initial.Length,chunkSizeBytes=8*1024*1024,chunkCount=1,encryptedSizeBytes=initial.Length+32,
                        encryptedMetadata=backlogMetadata.Ciphertext,metadataIv=backlogMetadata.Iv,wrappedFileKey=wrap.Ciphertext,fileKeyIv=wrap.Iv}),++revision,new string('b',64));
                    remote[17]=current;
                }
                await Wait(()=>File.Exists(backlogPath)&&Volatile.Read(ref deferredReads)>0,"initial mirror has an unavailable original ahead of existing files");
                await File.WriteAllTextAsync(path,"saved revision");
                await Wait(()=>committed==1,"saved edit upload");
                await Wait(()=>!Directory.EnumerateFiles(Path.Combine(outer,"pc","uploads"),"*.json").Any(),"lost completion reply recovers and acknowledges");
                Check(Encoding.UTF8.GetString(EncryptedChunks.Decrypt(fileKey,bodies[17],0))=="saved revision","stable file key and current Web chunk format");
                Check(committed==1,"lost reply never creates a second content revision");
                Console.WriteLine("ENGINE fixture: overwrite acknowledged");
                var unchanged=Path.Combine(directory,"saved","unchanged.tmp");await File.WriteAllTextAsync(unchanged,"saved revision");
                File.Replace(unchanged,path,null);
                await Wait(()=>catalog.LoadAsync().GetAwaiter().GetResult().Originals.Single(e=>e.Id==17).LocalFileId==WindowsFileState.Read(path).Id
                    &&(CloudFilesLocalStorage.PlaceholderState(path)&1)!=0,"an identical Office replacement retains identity and deletion protection without uploading another version");
                Check(committed==1,"saving identical bytes does not archive another old version");
                var renamed=Path.Combine(directory,"saved","renamed.txt");File.Move(path,renamed);
                await Wait(()=>CloudFileCrypto.DecryptMetadata(fileKey,new(remote[17].Value!.Value.GetProperty("encryptedMetadata").GetString()!,remote[17].Value!.Value.GetProperty("metadataIv").GetString()!)).Name=="renamed.txt","local rename uploads encrypted metadata");
                await Wait(()=>File.Exists(renamed),"renamed original remains available");
                Console.WriteLine("ENGINE fixture: rename published");
                var newPath=Path.Combine(directory,"saved","new.txt");await File.WriteAllTextAsync(newPath,"new original");
                await Wait(()=>committed==2,"new original upload");
                await Wait(()=>!Directory.EnumerateFiles(Path.Combine(outer,"pc","uploads"),"*.json").Any(),"new original baseline checkpoint");
                Console.WriteLine("ENGINE fixture: new upload acknowledged");
                var childDirectory=Path.Combine(directory,"saved","child");Directory.CreateDirectory(childDirectory);
                await File.WriteAllTextAsync(Path.Combine(childDirectory,"literal~003F.txt"),"child original");
                await Wait(()=>committed==3,"child folder creation and encrypted file upload");
                await Wait(()=>!Directory.EnumerateFiles(Path.Combine(outer,"pc","uploads"),"*.json").Any(),"child original baseline");
                Check((CloudFilesLocalStorage.PlaceholderState(backlogPath)&0x30)!=0,"overwrites, names and new uploads never wait for the initial mirror to finish");
                engine.BeforeHydrationValidation=full=>{
                    if(!full.Equals(backlogPath,StringComparison.OrdinalIgnoreCase))return;
                    engine.BeforeHydrationValidation=null;
                    File.WriteAllText(full,"saved as hydration completed");
                };
                lock(gate){backlogBlocked=false;}
                await Wait(()=>(CloudFilesLocalStorage.PlaceholderState(backlogPath)&0x30)==0,"background originals resume after local uploads");
                await Wait(()=>committed==4,"a save during hydration validation is uploaded rather than suppressed as a provider notification");
                Check(await File.ReadAllTextAsync(backlogPath)=="saved as hydration completed","the immediate save remains intact");
                Check(Encoding.UTF8.GetString(EncryptedChunks.Decrypt(fileKey,bodies[999],0))=="saved as hydration completed","the immediate save reaches the existing remote file");
                Check(remote[19].Value!.Value.GetProperty("folderId").GetInt64()==8,"child files use the new inherited folder key");
                var renamedChild=Path.Combine(directory,"saved","renamed-child");Directory.Move(childDirectory,renamedChild);
                await Wait(()=>remoteFolders[8].Value!.Value.GetProperty("name").GetString()=="renamed-child","folder rename uses the existing display name");
                await Wait(()=>!File.Exists(Path.Combine(outer,"pc","metadata.json")),"folder rename checkpoint");
                await Wait(()=>File.Exists(Path.Combine(renamedChild,"literal~003F.txt")),"a parent rename preserves the literal local file name");
                var childValue=remote[19].Value!.Value;
                var childFolderKey=CloudFileCrypto.UnlockChildFolder(folderKey,new(remoteFolders[8].Value!.Value.GetProperty("parentWrappedKey").GetString()!,remoteFolders[8].Value!.Value.GetProperty("parentWrapIv").GetString()!));
                try {
                    var childFileKey=CloudFileCrypto.UnlockFile(childFolderKey,new(childValue.GetProperty("wrappedFileKey").GetString()!,childValue.GetProperty("fileKeyIv").GetString()!));
                    try{Check(CloudFileCrypto.DecryptMetadata(childFileKey,new(childValue.GetProperty("encryptedMetadata").GetString()!,childValue.GetProperty("metadataIv").GetString()!)).Name=="literal~003F.txt","a folder rename never converts Windows name escapes into an online rename");}
                    finally{CryptographicOperations.ZeroMemory(childFileKey);}
                }finally{CryptographicOperations.ZeroMemory(childFolderKey);}
                lock(gate) {
                    var deleted=DateTimeOffset.UtcNow.ToString("O");var operation=Guid.NewGuid().ToString();
                    remote[19]=new("file",19,++revision,"trashed",null,deleted,operation);
                    remoteFolders[8]=new("folder",8,++revision,"trashed",null,deleted,operation);
                }
                await Wait(()=>!Directory.Exists(renamedChild),"verified folder trash removes the local directory without resurrection");
                await engine.DisposeAsync();engine=null;
                Check(await File.ReadAllTextAsync(renamed)=="saved revision","provider shutdown retains ordinary plaintext");
                await File.WriteAllTextAsync(renamed,"offline edit");
                engine=new(device,registration,root,catalog,Path.Combine(outer,"pc"));
                await Wait(()=>committed==5,"restart uploads a save made offline without a passkey");
                await Wait(()=>!Directory.EnumerateFiles(Path.Combine(outer,"pc","uploads"),"*.json").Any(),"offline edit baseline checkpoint");
                var replacement=Encoding.UTF8.GetBytes("updated online original");
                var replacementMetadata=CloudFileCrypto.EncryptMetadata(fileKey,new("renamed.txt","text/plain","document",2));
                lock(gate) {
                    var previous=remote[17].Value!.Value.Deserialize<Dictionary<string,JsonElement>>()!;
                    previous["sizeBytes"]=JsonSerializer.SerializeToElement(replacement.Length);previous["encryptedSizeBytes"]=JsonSerializer.SerializeToElement(replacement.Length+32);
                    previous["encryptedMetadata"]=JsonSerializer.SerializeToElement(replacementMetadata.Ciphertext);previous["metadataIv"]=JsonSerializer.SerializeToElement(replacementMetadata.Iv);
                    previous["contentVersion"]=JsonSerializer.SerializeToElement(new string('f',64));
                    bodies[17]=EncryptedChunks.Encrypt(fileKey,replacement,0);remote[17]=remote[17] with {Revision=++revision,Value=JsonSerializer.SerializeToElement(previous)};
                }
                await Wait(()=>File.Exists(renamed)&&File.ReadAllText(renamed)=="updated online original","atomic remote body replacement");
                await engine.DisposeAsync();engine=null;
                using var lateWriter=new FileStream(renamed,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete);
                lock(gate){remote[17]=new("file",17,++revision,"trashed",null,DateTimeOffset.UtcNow.ToString("O"),Guid.NewGuid().ToString());}
                engine=new(device,registration,root,catalog,Path.Combine(outer,"pc"));
                await Wait(()=>!File.Exists(renamed),"verified Web trash removes its local original");
                await Wait(()=>catalog.LoadAsync().GetAwaiter().GetResult().Originals.Single(e=>e.Id==17).Deleted,"Web trash cleanup completes while the writable handle remains open");
                var lateBytes=Encoding.UTF8.GetBytes("save after Web trash");lateWriter.Position=0;await lateWriter.WriteAsync(lateBytes);lateWriter.SetLength(lateBytes.Length);lateWriter.Flush(true);
                lateWriter.Dispose();
                await Wait(()=>Directory.Exists(engine.RecoveryDirectory)&&Directory.EnumerateFiles(engine.RecoveryDirectory,"*.txt").Any(p=>File.ReadAllText(p)=="save after Web trash"),"a still-open Office-style handle can save after Web trash without losing the edit");
                Check(deleteCalls==0,"the local engine never calls online Delete");
            }catch(Exception error){Console.Error.WriteLine("SYNTHETIC engine state: "+JsonSerializer.Serialize((await catalog.LoadAsync()).Originals));throw new InvalidOperationException("Synthetic engine failure",error);}
            finally{if(engine is not null)await engine.DisposeAsync();}
            root.UnregisterPreservingOriginals();root=null;
        }finally {
            root?.UnregisterPreservingOriginals();WindowsDeviceKey.Delete(signer);WindowsPrivateKey.Delete(dataKey);
            CryptographicOperations.ZeroMemory(folderKey);CryptographicOperations.ZeroMemory(fileKey);Directory.Delete(outer,true);
        }
    }
    public static async Task BulkMirror()
    {
        const int count=32;
        var outer=Path.Combine(Path.GetTempPath(),"tcloud-bulk-"+Guid.NewGuid().ToString("N"));var directory=Path.Combine(outer,"originals");Directory.CreateDirectory(directory);
        var signer=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));var dataKey=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        WindowsDeviceKey.Create(signer);using var rsa=RSA.Create(2048);var blob=rsa.ExportPkcs8PrivateKey();
        try{WindowsPrivateKey.Import(dataKey,blob);}finally{CryptographicOperations.ZeroMemory(blob);}
        var folderKey=RandomNumberGenerator.GetBytes(32);var fileKey=RandomNumberGenerator.GetBytes(32);CloudFilesRootRegistration? root=null;
        try {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),signer,dataKey,directory,VolumeInspector.ValidateDestination(directory,[]));
            root=CloudFilesRootRegistration.Attach(registration,[],initialize:true);registration=registration with {RootFileId=root.FileId};
            var payload=Encoding.UTF8.GetBytes(new string('b',32768));var wrap=CloudFileCrypto.WrapFile(folderKey,fileKey);
            var entries=new List<WindowsCatalogEntry>{new("folder",7,1,"present",JsonSerializer.SerializeToElement(new{id=7,parentId=(long?)null,name="saved",cryptoVersion=0}),null,null)};
            var bodies=new Dictionary<long,byte[]>();
            for(int i=0;i<count;i++) {
                long id=17+i;var meta=CloudFileCrypto.EncryptMetadata(fileKey,new("bulk-"+i+".txt","text/plain","document",1));var body=EncryptedChunks.Encrypt(fileKey,payload,0);bodies[id]=body;
                entries.Add(new("file",id,id,"present",JsonSerializer.SerializeToElement(new{id,folderId=7,name="[encrypted]",cryptoVersion=1,sizeBytes=payload.Length,
                    chunkSizeBytes=8*1024*1024,chunkCount=1,encryptedSizeBytes=body.Length,encryptedMetadata=meta.Ciphertext,metadataIv=meta.Iv,
                    wrappedFileKey=wrap.Ciphertext,fileKeyIv=wrap.Iv,contentVersion=Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant()}),null,null));
            }
            var keys=new{scopeHash=registration.ScopeHash,folderKeys=new[]{new{rootFolderId=7,wrappedKey=Encode(rsa.Encrypt(folderKey,RSAEncryptionPadding.OaepSHA256))}}};
            int contentReads=0;var requestedIds=new System.Collections.Concurrent.ConcurrentDictionary<long,byte>();
            using var handler=new DeviceClientTests.DeviceHandler(registration){Data=request=>{
                var route=request.RequestUri!.AbsoluteUri[WindowsDeviceClient.BaseUrl.Length..];if(route=="keys")return Json(keys);
                if(!route.StartsWith("content/",StringComparison.Ordinal))throw new InvalidOperationException("Unexpected bulk fixture mutation");
                Interlocked.Increment(ref contentReads);
                requestedIds.TryAdd(long.Parse(route[8..]),0);
                var bytes=bodies[long.Parse(route[8..])];var range=request.Headers.Range!.Ranges.Single();var from=range.From!.Value;var to=range.To!.Value;
                var response=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(bytes.AsSpan((int)from,(int)(to-from+1)).ToArray())};
                response.Headers.ETag=new("\"bulk-"+route[8..]+"\"");response.Content.Headers.ContentRange=new ContentRangeHeaderValue(from,to,bytes.Length);return response;
            }};
            using var transport=new HttpClient(handler);using var device=new WindowsDeviceClient(transport,registration);
            var catalog=new LocalSyncCatalog(Path.Combine(outer,"pc","catalog.json"),registration);var snapshot=catalog.Empty() with {Remote=entries.ToArray(),RemotePosition=new(new string('a',32),17+count)};await catalog.SaveAsync(snapshot);
            var complete=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using(var engine=new WindowsSyncEngine(device,registration,root,catalog,Path.Combine(outer,"pc"),new TransferProgress(s=>{if(s.Message.StartsWith("同期済み",StringComparison.Ordinal))complete.TrySetResult();}))) {
                engine.BeforeHydrationValidation=full=>{if(Path.GetFileName(full)=="bulk-0.txt")Check(requestedIds.ContainsKey(18),"the next original starts before validating the current body");};
                await engine.ReconcileAsync(snapshot,CancellationToken.None);
                var finished=await Task.WhenAny(complete.Task,engine.Completion,Task.Delay(TimeSpan.FromSeconds(45)));
                if(finished!=complete.Task)throw new InvalidOperationException("Bulk hydration did not settle: "+string.Join(";",engine.Errors.Select(e=>e.Message)));
                var retained=await catalog.LoadAsync();Check(retained.Originals.Length==count&&retained.Originals.All(o=>o.Complete&&o.LocalState is not null),"every completed body has a durable verified baseline");
                foreach(var record in retained.Originals)Check((await File.ReadAllBytesAsync(LocalPaths.ResolveUnderRoot(directory,record.RelativePath))).AsSpan().SequenceEqual(payload),"bulk plaintext equals its authenticated original");
            }
            // Older interrupted hydration left a valid stamp/hash but no
            // completion flag. Repair the flag without downloading it again.
            var resumed=await catalog.UpdateAsync(s=>s with {Originals=s.Originals.Select((o,i)=>i==0?o with {Complete=false}:o).ToArray()});
            var readsBeforeRestart=Volatile.Read(ref contentReads);var settled=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using(var engine=new WindowsSyncEngine(device,registration,root,catalog,Path.Combine(outer,"pc"),new TransferProgress(s=>{if(s.Message.StartsWith("同期済み",StringComparison.Ordinal))settled.TrySetResult();}))) {
                await engine.ReconcileAsync(resumed,CancellationToken.None);
                var finished=await Task.WhenAny(settled.Task,engine.Completion,Task.Delay(TimeSpan.FromSeconds(45)));
                Check(finished==settled.Task,"restart settles cached originals");
                Check((await catalog.LoadAsync()).Originals.All(o=>o.Complete),"existing validated bodies repair interrupted completion flags");
                Check(Volatile.Read(ref contentReads)==readsBeforeRestart,"repair never downloads an already saved original again");
            }
            root.UnregisterPreservingOriginals();root=null;
        }finally {
            root?.UnregisterPreservingOriginals();WindowsDeviceKey.Delete(signer);WindowsPrivateKey.Delete(dataKey);
            CryptographicOperations.ZeroMemory(folderKey);CryptographicOperations.ZeroMemory(fileKey);Directory.Delete(outer,true);
        }
    }
    private sealed class TransferProgress(Action<WindowsTransferStatus> report):IProgress<WindowsTransferStatus>{public void Report(WindowsTransferStatus value)=>report(value);}
    private static string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
    private static HttpResponseMessage Json(object value)=>new(HttpStatusCode.OK){Content=JsonContent.Create(value)};
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
}

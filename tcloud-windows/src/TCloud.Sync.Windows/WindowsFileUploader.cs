using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed class WindowsUploadConflictException(string code):IOException("オンラインの変更と競合しています。編集内容を保全します。")
{public string Code{get;}=code;}

public sealed record PreparedWindowsUpload(PendingWindowsUpload Record,VerifiedOriginal Snapshot):IAsyncDisposable
{public ValueTask DisposeAsync()=>Snapshot.DisposeAsync();}

/// <summary>Uploads only a stable saved copy; resumes with the device proof and existing vault envelopes.</summary>
public sealed class WindowsFileUploader(WindowsDeviceClient device,WindowsDeviceRegistration registration,
    CloudFilesRootRegistration root,WindowsUploadJournal journal,string staging)
{
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    public async Task<PreparedWindowsUpload> PrepareAsync(CloudOriginalResolver resolver,WindowsCatalogEntry? previous,long folderId,
        string relativePath,string epoch,CloudFileMetadata metadata,CancellationToken token=default)
    {
        root.VerifyPresent();var source=LocalPaths.ResolveUnderRoot(root.Root,relativePath);
        if(!VolumeInspector.Inspect(staging).Matches(registration.Volume))throw new IOException("送信用の保存先が登録したHDDと一致しません。");
        var snapshot=await LocalOriginalSnapshot.CaptureAsync(source,staging,token:token,retain:true);
        byte[]? folderKey=null,fileKey=null;
        try {
            folderKey=resolver.CopyFolderKey(folderId);
            var id=Guid.NewGuid().ToString("N");CloudCipherEnvelope wrapped;object? restore=null;
            if(previous is not null) {
                using var original=resolver.Resolve(previous);
                if(original.FileKey is null)throw new InvalidDataException("旧形式の原本は暗号化フォルダへ保存してから編集してください。");
                fileKey=original.FileKey.ToArray();
                var value=previous.Value!.Value;
                wrapped=value.GetProperty("folderId").GetInt64()==folderId
                    ?new(value.GetProperty("wrappedFileKey").GetString()!,value.GetProperty("fileKeyIv").GetString()!)
                    :CloudFileCrypto.WrapFile(folderKey,fileKey);
                var old=original.Metadata!;var extension=Path.GetExtension(old.Name);
                var stem=old.Name[..(old.Name.Length-extension.Length)];
                var suffix=$" (旧版 {DateTime.Now:yyyy-MM-dd HHmmss}-{id[..8]})";
                if(stem.Length+suffix.Length+extension.Length>240)stem=stem[..Math.Max(1,240-suffix.Length-extension.Length)];
                var alias=old with {Name=stem+suffix+extension};
                var encryptedAlias=CloudFileCrypto.EncryptMetadata(fileKey,alias);
                restore=new{encryptedMetadata=encryptedAlias.Ciphertext,metadataIv=encryptedAlias.Iv,name=(string?)null,
                    displayName=value.TryGetProperty("displayMetadataVersion",out var display)&&display.GetInt32()==1?alias.Name:null};
            }else{fileKey=RandomNumberGenerator.GetBytes(32);wrapped=CloudFileCrypto.WrapFile(folderKey,fileKey);}
            var extra=metadata.Extra is null?new Dictionary<string,JsonElement>():new(metadata.Extra);
            extra["sha256"]=JsonSerializer.SerializeToElement(snapshot.Sha256.ToLowerInvariant());
            // A changed video needs fresh duration/container inspection by the
            // existing client pipeline, rather than copying stale media facts.
            if(metadata.MediaKind=="video"){extra.Remove("durationSeconds");extra.Remove("containerType");}
            metadata=metadata with {Extra=extra};var encrypted=CloudFileCrypto.EncryptMetadata(fileKey,metadata);
            var size=snapshot.Body.Length;
            var chunk=(int)Math.Max(8L*1024*1024,((size+9999)/10000+1024*1024-1)/(1024*1024)*(1024*1024));
            var count=checked((int)((size+chunk-1)/chunk));
            var layout=new EncryptedFileLayout(size,chunk,count,checked(size+32L*count));layout.Validate();
            var body=JsonSerializer.SerializeToElement(new {operationId=id,epoch,fileId=previous?.Id,expectedRevision=previous?.Revision,folderId,sizeBytes=size,
                cryptoVersion=1,encryptedSizeBytes=layout.EncryptedSizeBytes,chunkSizeBytes=chunk,chunkCount=count,
                encryptedMetadata=encrypted.Ciphertext,metadataIv=encrypted.Iv,wrappedFileKey=wrapped.Ciphertext,fileKeyIv=wrapped.Iv,
                archiveRestore=restore,fastDisplay=await FastDisplayAsync(snapshot.Body,metadata,token)},Json);
            var record=new PendingWindowsUpload(1,registration.ScopeHash,registration.Volume,registration.RootFileId!.Value,id,relativePath,
                Path.GetFileName(snapshot.PersistedPath!),size,snapshot.Sha256,snapshot.SourceFileId,snapshot.SourceUsn,body,[]);
            await journal.SaveAsync(record,token);return new(record,snapshot);
        }catch{await snapshot.DisposeAsync();root.VerifyPresent();if(snapshot.PersistedPath is not null)File.Delete(snapshot.PersistedPath);throw;}
        finally{if(folderKey is not null)CryptographicOperations.ZeroMemory(folderKey);if(fileKey is not null)CryptographicOperations.ZeroMemory(fileKey);}
    }

    public async Task<PendingWindowsUpload> TransferAsync(PendingWindowsUpload record,CloudOriginalResolver resolver,
        Stream? preparedBody=null,IProgress<long>? progress=null,CancellationToken token=default)
    {
        root.VerifyPresent();var started=await Request("windows-updates",record.Request,token);
        var operationId=started.GetProperty("operationId").GetString();
        if(operationId!=record.OperationId)throw new InvalidDataException("送信処理の識別情報が一致しません。");
        if(started.GetProperty("state").GetString()=="committed")return await Remember(record,started,token);
        if(started.GetProperty("state").GetString()!="pending")throw new WindowsUploadConflictException("operation_closed");
        var uploadId=started.GetProperty("uploadId").GetInt64();
        var folderKey=resolver.CopyFolderKey(record.Request.GetProperty("folderId").GetInt64());byte[]? fileKey=null;FileStream? owned=null;
        try {
            fileKey=CloudFileCrypto.UnlockFile(folderKey,new(record.Request.GetProperty("wrappedFileKey").GetString()!,record.Request.GetProperty("fileKeyIv").GetString()!));
            var body=preparedBody??(owned=new FileStream(journal.SnapshotPath(record),FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.Asynchronous|FileOptions.SequentialScan));
            if(body.Length!=record.SizeBytes)throw new InvalidDataException("保存済み送信用原本のサイズが変わっています。");
            var chunk=record.Request.GetProperty("chunkSizeBytes").GetInt32();var count=record.Request.GetProperty("chunkCount").GetInt32();
            var buffer=new byte[(int)Math.Min(chunk,record.SizeBytes)];using var checksum=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            try {
                for(var index=0;index<count;index++) {
                    token.ThrowIfCancellationRequested();root.VerifyPresent();body.Position=(long)index*chunk;
                    var length=(int)Math.Min(chunk,record.SizeBytes-body.Position);await body.ReadExactlyAsync(buffer.AsMemory(0,length),token);
                    checksum.AppendData(buffer,0,length);var partHash=Convert.ToHexString(SHA256.HashData(buffer.AsSpan(0,length)));
                    var previous=record.Parts.SingleOrDefault(p=>p.PartNumber==index+1);
                    if(previous?.PlainSha256!=partHash) {
                        var encrypted=EncryptedChunks.Encrypt(fileKey,buffer.AsSpan(0,length),index);
                        try {
                            using var response=await device.SendDataAsync($"uploads/{uploadId}/parts/{index+1}",HttpMethod.Put,()=>new ByteArrayContent(encrypted),token:token);
                            var part=await Read(response,token);
                            if(part.GetProperty("partNumber").GetInt32()!=index+1)throw new InvalidDataException("送信済み部分の識別情報が一致しません。");
                            var saved=new UploadedPart(index+1,part.GetProperty("etag").GetString()!,partHash);
                            record=record with {Parts=[..record.Parts.Where(p=>p.PartNumber!=index+1),saved]};await journal.SaveAsync(record,token);
                        }finally{CryptographicOperations.ZeroMemory(encrypted);}
                    }
                    CryptographicOperations.ZeroMemory(buffer.AsSpan(0,length));progress?.Report(Math.Min(record.SizeBytes,(long)(index+1)*chunk));
                }
                if(!Convert.ToHexString(checksum.GetHashAndReset()).Equals(record.Sha256,StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("送信用原本の検証に失敗しました。オンラインの原本は更新していません。");
            }finally{CryptographicOperations.ZeroMemory(buffer);}
            var completed=await Request("windows-updates/"+record.OperationId+"/complete",new{parts=record.Parts.OrderBy(p=>p.PartNumber).Select(p=>new{p.PartNumber,p.Etag})},token);
            return await Remember(record,completed,token);
        }finally{if(owned is not null)await owned.DisposeAsync();CryptographicOperations.ZeroMemory(folderKey);if(fileKey is not null)CryptographicOperations.ZeroMemory(fileKey);}
    }
    public async Task CancelAsync(PendingWindowsUpload record,CancellationToken token=default)
    {root.VerifyPresent();_=await Request("windows-updates/"+record.OperationId+"/cancel",new{},token);}
    private async Task<PendingWindowsUpload> Remember(PendingWindowsUpload record,JsonElement response,CancellationToken token)
    {
        var result=response.Deserialize<UploadAcknowledgement>(Json)??throw new InvalidDataException("送信結果を読み取れません。");
        if(result.State!="committed"||result.OperationId!=record.OperationId||result.FileId<1||result.UploadId<1||result.Revision<1)
            throw new InvalidDataException("送信結果が一致しません。");
        record=record with {Result=result};await journal.SaveAsync(record,token);return record;
    }
    private async Task<JsonElement> Request(string route,object body,CancellationToken token)
    {using var response=await device.SendDataAsync(route,HttpMethod.Post,()=>JsonContent.Create(body,options:Json),token:token);return await Read(response,token);}
    private static async Task<JsonElement> Read(HttpResponseMessage response,CancellationToken token)
    {
        var value=await WindowsDeviceClient.ReadJsonAsync(response,token,1024*1024);
        if(response.StatusCode==HttpStatusCode.Conflict)throw new WindowsUploadConflictException(value.TryGetProperty("code",out var code)?code.GetString()??"revision_conflict":"revision_conflict");
        response.EnsureSuccessStatusCode();return value;
    }
    private static async Task<object?> FastDisplayAsync(Stream body,CloudFileMetadata metadata,CancellationToken token)
    {
        if(metadata.MediaKind=="video")return null;
        var header=new byte[(int)Math.Min(16,body.Length)];body.Position=0;await body.ReadExactlyAsync(header,token);body.Position=0;
        string? signature=header switch {
            [0xff,0xd8,0xff,..] when metadata.MediaKind=="image"=>"jpeg",
            [137,80,78,71,13,10,26,10,..] when metadata.MediaKind=="image"=>"png",
            [71,73,70,56,..] when metadata.MediaKind=="image"=>"gif",
            [82,73,70,70,_,_,_,_,87,69,66,80,..] when metadata.MediaKind=="image"=>"webp",
            [37,80,68,70,45,..] when metadata.MediaKind=="document"=>"pdf",
            [80,75,3,4,..] when metadata.MediaKind=="document"=>"zip",_=>null};
        CryptographicOperations.ZeroMemory(header);
        return signature is null?null:new{signature,name=metadata.Name,mimeType=metadata.MimeType,mediaKind=metadata.MediaKind,lastModified=metadata.LastModified};
    }
}

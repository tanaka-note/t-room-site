using System.Text.Json;
using System.Text.RegularExpressions;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record UploadedPart(int PartNumber,string Etag,string PlainSha256);
public sealed record UploadAcknowledgement(string OperationId,long UploadId,long FileId,string State,long Revision,long? ArchiveId,string? ContentVersion=null);
public sealed record PendingWindowsUpload(int Version,string ScopeHash,VolumeBinding Volume,long RootFileId,
    string OperationId,string RelativePath,string SnapshotName,long SizeBytes,string Sha256,long SourceFileId,long SourceUsn,
    JsonElement Request,UploadedPart[] Parts,UploadAcknowledgement? Result=null);

/// <summary>PC-only restart records. File keys remain wrapped; no Cookie, bearer, PRF or private key is stored.</summary>
public sealed class WindowsUploadJournal(string directory,string staging,WindowsDeviceRegistration registration)
{
    private readonly string directory=Path.GetFullPath(directory),staging=Path.GetFullPath(staging);
    private readonly SemaphoreSlim gate=new(1,1);
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    private const int MaxBytes=4*1024*1024;
    public string SnapshotPath(PendingWindowsUpload record)
    {
        Validate(record);var path=LocalPaths.ResolveUnderRoot(staging,record.SnapshotName);
        if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の送信用原本は使用しません。");
        return path;
    }
    public async Task SaveAsync(PendingWindowsUpload record,CancellationToken token=default)
    {
        Validate(record);await gate.WaitAsync(token);var pending=Path.Combine(directory,record.OperationId+"."+Guid.NewGuid().ToString("N")+".pending");
        try {
            CheckDirectory();Directory.CreateDirectory(directory);CheckDirectory();
            var bytes=JsonSerializer.SerializeToUtf8Bytes(record,Json);if(bytes.Length>MaxBytes)throw new InvalidDataException("送信記録が上限を超えています。");
            await using(var file=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {await file.WriteAsync(bytes,token);await file.FlushAsync(token);file.Flush(flushToDisk:true);}
            token.ThrowIfCancellationRequested();CheckDirectory();
            var path=Path.Combine(directory,record.OperationId+".json");
            if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の送信記録は使用しません。");
            if(File.Exists(path))File.Replace(pending,path,null);else File.Move(pending,path);
        }finally{if(File.Exists(pending))File.Delete(pending);gate.Release();}
    }
    public async Task<PendingWindowsUpload[]> LoadAsync(CancellationToken token=default)
    {
        await gate.WaitAsync(token);
        try {
            CheckDirectory();if(!Directory.Exists(directory))return [];
            var paths=Directory.EnumerateFiles(directory,"*.json").ToArray();if(paths.Length>10000)throw new InvalidDataException("送信待ち件数が上限を超えています。");
            var records=new List<PendingWindowsUpload>();
            foreach(var path in paths) {
                if(!Regex.IsMatch(Path.GetFileName(path),"^[a-f0-9]{32}\\.json$"))throw new InvalidDataException("送信記録の名前が不正です。");
                if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の送信記録は使用しません。");
                await using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,4096,FileOptions.Asynchronous);
                if(file.Length is <1 or >MaxBytes)throw new InvalidDataException("送信記録のサイズが不正です。");
                var record=await JsonSerializer.DeserializeAsync<PendingWindowsUpload>(file,Json,token)??throw new InvalidDataException("送信記録を読み取れません。");
                Validate(record);if(Path.GetFileNameWithoutExtension(path)!=record.OperationId)throw new InvalidDataException("送信記録が一致しません。");records.Add(record);
            }
            return records.ToArray();
        }finally{gate.Release();}
    }
    // Called only after the original's new baseline has been durably recorded.
    public async Task ForgetAsync(PendingWindowsUpload record,CancellationToken token=default)
    {
        Validate(record);await gate.WaitAsync(token);
        try {CheckDirectory();var path=Path.Combine(directory,record.OperationId+".json");
            if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の送信記録は使用しません。");
            File.Delete(path);
        }finally{gate.Release();}
    }
    private void Validate(PendingWindowsUpload value)
    {
        static bool Hash(string? text)=>text?.Length==64&&text.All(char.IsAsciiHexDigit);
        if(value.Version!=1||value.ScopeHash!=registration.ScopeHash||value.Volume!=registration.Volume||value.RootFileId!=registration.RootFileId
            ||value.RootFileId==0||!Regex.IsMatch(value.OperationId??"","^[a-f0-9]{32}$")
            ||!Regex.IsMatch(value.SnapshotName??"","^[a-f0-9]{32}\\.upload$")||!Hash(value.Sha256)||value.SizeBytes is <1 or >671088640000
            ||value.Request.ValueKind!=JsonValueKind.Object||value.Parts is null||value.Parts.Length>10000)
            throw new InvalidDataException("送信記録のアカウント・媒体・形式が一致しません。");
        _=LocalPaths.ResolveUnderRoot(registration.Destination,value.RelativePath);
        var request=value.Request;
        if(request.GetProperty("operationId").GetString()!=value.OperationId||request.GetProperty("sizeBytes").GetInt64()!=value.SizeBytes
            ||request.GetProperty("cryptoVersion").GetInt32()!=1||request.GetProperty("folderId").GetInt64()<1)
            throw new InvalidDataException("送信記録の内容が一致しません。");
        string[] allowed=["operationId","epoch","fileId","expectedRevision","folderId","sizeBytes","cryptoVersion","encryptedSizeBytes","chunkSizeBytes","chunkCount",
            "encryptedMetadata","metadataIv","wrappedFileKey","fileKeyIv","archiveRestore","fastDisplay"];
        if(request.EnumerateObject().Any(p=>!allowed.Contains(p.Name)))throw new InvalidDataException("送信記録に不明な項目があります。");
        foreach(var part in value.Parts)
            if(part.PartNumber<1||part.PartNumber>10000||string.IsNullOrEmpty(part.Etag)||part.Etag.Length>256||!Hash(part.PlainSha256))throw new InvalidDataException("送信済み部分の記録が不正です。");
        if(value.Parts.Select(p=>p.PartNumber).Distinct().Count()!=value.Parts.Length)throw new InvalidDataException("送信記録が重複しています。");
        if(value.Result is {} result&&(result.OperationId!=value.OperationId||result.FileId<1||result.UploadId<1||result.Revision<1||result.State!="committed"))
            throw new InvalidDataException("送信結果の形式が不正です。");
    }
    private void CheckDirectory()
    {
        for(var item=new DirectoryInfo(directory);item is not null;item=item.Parent)
            if(item.Exists&&item.LinkTarget is not null)throw new IOException("リンク経由の送信記録は使用しません。");
    }
}

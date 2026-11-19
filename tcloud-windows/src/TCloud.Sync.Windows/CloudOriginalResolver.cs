using System.Security.Cryptography;
using System.Text.Json;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record ResolvedOriginal(long Id,long Revision,string RelativePath,long SizeBytes,
    EncryptedFileLayout? Layout,byte[]? FileKey):IDisposable
{
    public long StoredBytes=>Layout?.EncryptedSizeBytes??SizeBytes;
    public void Dispose(){if(FileKey is not null)CryptographicOperations.ZeroMemory(FileKey);}
}

/// <summary>Uses the existing vault envelopes locally; no decrypted keys enter a catalog or request.</summary>
public sealed class CloudOriginalResolver:IDisposable
{
    private readonly Dictionary<long,JsonElement> folders;
    private readonly Dictionary<long,byte[]> folderKeys=[];
    private readonly Dictionary<long,string> folderPaths=[];
    private readonly HashSet<long> roots=[];
    private readonly RSA privateKey;
    private readonly object gate=new();
    private bool disposed;
    public CloudOriginalResolver(RSA privateKey,IEnumerable<WindowsCatalogEntry> entries,JsonElement keys)
    {
        this.privateKey=privateKey;
        folders=entries.Where(e=>e.Kind=="folder"&&e.State=="present"&&e.Value.HasValue)
            .ToDictionary(e=>e.Id,e=>e.Value!.Value);
        try
        {
            foreach(var root in keys.GetProperty("folderKeys").EnumerateArray())
            {
                var id=root.GetProperty("rootFolderId").GetInt64();
                if(!roots.Add(id))throw new InvalidDataException("同期ルートの鍵が重複しています。");
                folderKeys.Add(id,CloudFileCrypto.UnlockFolder(privateKey,root.GetProperty("wrappedKey").GetString()!));
            }
        }
        catch {Dispose();throw;}
    }
    public ResolvedOriginal Resolve(WindowsCatalogEntry entry)
    {lock(gate)return ResolveCore(entry);}
    private ResolvedOriginal ResolveCore(WindowsCatalogEntry entry)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        if(entry.Kind!="file"||entry.State!="present"||entry.Value is not {} value)throw new InvalidDataException("取得対象のファイルではありません。");
        var folder=Number(value,"folderId");var size=value.GetProperty("sizeBytes").GetInt64();
        if(size<1||size>64L*1024*1024*10000||Number(value,"cryptoVersion") is not(null or 0 or 1))
            throw new InvalidDataException("対応していない原本の形式です。");
        byte[]? key=null;
        try
        {
            EncryptedFileLayout? layout=null;string name;
            if(Number(value,"cryptoVersion")==1)
            {
                if(folder is null)throw new InvalidDataException("暗号化ファイルの保存先がありません。");
                key=CloudFileCrypto.UnlockFile(FolderKey(folder.Value,[]),Envelope(value,"wrappedFileKey","fileKeyIv"));
                name=CloudFileCrypto.DecryptMetadata(key,Envelope(value,"encryptedMetadata","metadataIv")).Name;
                layout=new(size,value.GetProperty("chunkSizeBytes").GetInt32(),value.GetProperty("chunkCount").GetInt32(),
                    value.GetProperty("encryptedSizeBytes").GetInt64());layout.Validate();
            }
            else name=value.GetProperty("name").GetString()??throw new InvalidDataException("ファイル名がありません。");
            var parent=folder is null?"":FolderPath(folder.Value,[]);
            var path=Path.Combine(parent,LocalPaths.EncodeName(name));
            _=LocalPaths.ResolveUnderRoot(Path.GetTempPath(),path);
            return new(entry.Id,entry.Revision,path,size,layout,key);
        }
        catch {if(key is not null)CryptographicOperations.ZeroMemory(key);throw;}
    }
    private byte[] FolderKey(long id,HashSet<long> seen)
    {
        if(folderKeys.TryGetValue(id,out var existing))return existing;
        if(!seen.Add(id)||seen.Count>100||!folders.TryGetValue(id,out var folder))throw new InvalidDataException("フォルダの鍵を確認できません。");
        byte[] key;
        // Administrator envelopes allow a folder to be decoded independently.
        // Members can use only the wrapped root and its child envelopes.
        if(roots.Count==0)key=CloudFileCrypto.UnlockFolder(privateKey,folder.GetProperty("adminWrappedKey").GetString()!);
        else if(Number(folder,"parentId") is {} parent)key=CloudFileCrypto.UnlockChildFolder(FolderKey(parent,seen),Envelope(folder,"parentWrappedKey","parentWrapIv"));
        else throw new InvalidDataException("利用できるルートの鍵がありません。");
        folderKeys.Add(id,key);return key;
    }
    private string FolderPath(long id,HashSet<long> seen)
    {
        if(folderPaths.TryGetValue(id,out var existing))return existing;
        if(!seen.Add(id)||seen.Count>100||!folders.TryGetValue(id,out var folder))throw new InvalidDataException("フォルダ構成を確認できません。");
        var name=Number(folder,"cryptoVersion")==1?CloudFileCrypto.DecryptFolderName(FolderKey(id,[]),Envelope(folder,"encryptedName","nameIv"))
            :folder.GetProperty("name").GetString()??throw new InvalidDataException("フォルダ名がありません。");
        var parent=roots.Contains(id)?null:Number(folder,"parentId");
        var path=Path.Combine(parent is null?"":FolderPath(parent.Value,seen),LocalPaths.EncodeName(name));
        folderPaths.Add(id,path);return path;
    }
    private static long? Number(JsonElement value,string field)=>value.TryGetProperty(field,out var result)&&result.ValueKind!=JsonValueKind.Null?result.GetInt64():null;
    private static CloudCipherEnvelope Envelope(JsonElement value,string cipher,string iv)=>new(value.GetProperty(cipher).GetString()!,value.GetProperty(iv).GetString()!);
    public void Dispose(){lock(gate){if(disposed)return;disposed=true;foreach(var value in folderKeys.Values)CryptographicOperations.ZeroMemory(value);folderKeys.Clear();}}
}

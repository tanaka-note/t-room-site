using System.Text.Json;

namespace TCloud.Sync.Windows;

internal static class WindowsAtomicState
{
    public static void Check(string path)
    {
        if(new FileInfo(path).LinkTarget is not null)throw new IOException("リンク経由の同期情報は使用しません。");
        for(var dir=Directory.GetParent(Path.GetFullPath(path));dir is not null;dir=dir.Parent)
            if(dir.Exists&&dir.LinkTarget is not null)throw new IOException("リンク経由の同期情報は使用しません。");
    }
    public static async Task SaveAsync<T>(string path,T value,CancellationToken token)
    {
        path=Path.GetFullPath(path);Check(path);Directory.CreateDirectory(Path.GetDirectoryName(path)!);Check(path);
        var pending=path+"."+Guid.NewGuid().ToString("N")+".pending";
        try {
            await using(var stream=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {await JsonSerializer.SerializeAsync(stream,value,cancellationToken:token);await stream.FlushAsync(token);stream.Flush(true);}
            token.ThrowIfCancellationRequested();Check(path);
            if(File.Exists(path))File.Replace(pending,path,null);else File.Move(pending,path);
        }finally{if(File.Exists(pending))File.Delete(pending);}
    }
    public static async Task<T?> LoadAsync<T>(string path,CancellationToken token)
    {
        Check(path);if(!File.Exists(path))return default;
        await using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,4096,FileOptions.Asynchronous);
        if(stream.Length is <1 or >1048576)throw new InvalidDataException("同期情報のサイズが不正です。");
        return await JsonSerializer.DeserializeAsync<T>(stream,cancellationToken:token)??throw new InvalidDataException("同期情報を読み取れません。");
    }
}

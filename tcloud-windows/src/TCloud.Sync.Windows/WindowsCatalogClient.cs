using System.Net;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public sealed record WindowsCatalogEntry(string Kind,long Id,long Revision,string State,JsonElement? Value,
    string? DeletedAt,string? TrashOperationId);
public sealed record WindowsCatalogStart(string Epoch,long Cursor);
public sealed record WindowsCatalogPage(string Epoch,long Until,long Next,bool Complete,WindowsCatalogEntry[] Items);
public sealed class WindowsCatalogResetException():IOException("オンラインの差分記録が切り替わりました。全件を再確認します。");

public interface IWindowsCatalogSource
{
    Task<WindowsCatalogStart> StartAsync(CancellationToken token=default);
    Task<WindowsCatalogPage> PageAsync(WindowsCatalogStart start,long after,bool snapshot,CancellationToken token=default);
}

public sealed class WindowsCatalogClient(WindowsDeviceClient device):IWindowsCatalogSource
{
    private static readonly JsonSerializerOptions Json=new(JsonSerializerDefaults.Web);
    public async Task<WindowsCatalogStart> StartAsync(CancellationToken token=default)
    {
        var value=(await Read("catalog/start",token)).Deserialize<WindowsCatalogStart>(Json)
            ??throw new InvalidDataException("一覧の確認情報がありません。");
        if(value.Epoch.Length!=32||value.Epoch.Any(c=>!char.IsAsciiHexDigit(c))||value.Cursor<0)
            throw new InvalidDataException("一覧の確認情報が不正です。");
        return value;
    }
    public async Task<WindowsCatalogPage> PageAsync(WindowsCatalogStart start,long after,bool snapshot,CancellationToken token=default)
    {
        if(after<0||after>start.Cursor)throw new ArgumentOutOfRangeException(nameof(after));
        var route=$"catalog/{(snapshot?"snapshot":"changes")}?epoch={Uri.EscapeDataString(start.Epoch)}&until={start.Cursor}&after={after}";
        var page=(await Read(route,token)).Deserialize<WindowsCatalogPage>(Json)
            ??throw new InvalidDataException("一覧の応答がありません。");
        if(page.Epoch!=start.Epoch||page.Until!=start.Cursor||page.Next<after||page.Next>start.Cursor
            ||!page.Complete&&page.Next<=after||page.Complete!=(page.Next==start.Cursor)||page.Items.Length>200)
            throw new InvalidDataException("一覧の続きの位置が不正です。");
        foreach(var item in page.Items)
            if(item.Id<1||item.Revision<=after||item.Revision>page.Next||item.Kind is not("file" or "folder")
                ||item.State is not("present" or "trashed" or "purged")
                ||item.State=="present"&&item.Value is null
                ||item.State!="present"&&(string.IsNullOrEmpty(item.TrashOperationId)||string.IsNullOrEmpty(item.DeletedAt)))
                throw new InvalidDataException("一覧の項目が不正です。");
        return page;
    }
    private async Task<JsonElement> Read(string route,CancellationToken token)
    {
        using var response=await device.SendAsync(route,HttpMethod.Get,token:token);
        var value=await WindowsDeviceClient.ReadJsonAsync(response,token,8*1024*1024);
        if(response.StatusCode==HttpStatusCode.Conflict&&value.TryGetProperty("code",out var code)&&code.GetString()=="catalog_reset")
            throw new WindowsCatalogResetException();
        response.EnsureSuccessStatusCode();return value;
    }
}

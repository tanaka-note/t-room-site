using System.Text.Json;
using TCloud.Sync.Windows;

if (args.Length == 2 && args[0] == "inspect")
{
    try
    {
        var roots = new[] { Environment.GetEnvironmentVariable("OneDrive"), Environment.GetEnvironmentVariable("OneDriveConsumer"),
            Environment.GetEnvironmentVariable("OneDriveCommercial") }.OfType<string>();
        var binding = VolumeInspector.ValidateDestination(args[1], roots);
        var volume = VolumeInspector.Inspect(args[1]);
        Console.WriteLine(JsonSerializer.Serialize(new { supported = true, volume.FileSystem, volume.DriveType,
            volume.AvailableBytes, destination = Path.GetFullPath(args[1]), binding.RelativeRoot }));
        return 0;
    }
    catch (Exception error) when (error is IOException or ArgumentException or System.ComponentModel.Win32Exception)
    { Console.Error.WriteLine(error.Message); return 1; }
}
Console.WriteLine("T-Cloud Windows 開発版: inspect <保存先フォルダ> で保存先を読み取り確認します。");
Console.WriteLine("オンライン同期・認証・実データの変更は、まだ有効になっていません。");
return args.Length == 0 ? 0 : 2;

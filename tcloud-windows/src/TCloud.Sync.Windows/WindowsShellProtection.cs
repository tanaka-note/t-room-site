using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Text;

namespace TCloud.Sync.Windows;

/// <summary>Per-user Shell capabilities apply to the actual physical folder path and inherited children.</summary>
public static class WindowsShellProtection
{
    public const string ClassId="{14bd3096-e835-4a10-a5ca-ea1182b63614}";
    public static void Register(string library)
    {
        library=Path.GetFullPath(library);WindowsAtomicState.Check(library);
        if(!File.Exists(library))throw new FileNotFoundException("エクスプローラー連携のDLLがありません。",library);
        using var cls=Registry.CurrentUser.CreateSubKey(@"Software\Classes\CLSID\"+ClassId);
        using var server=cls.CreateSubKey("InProcServer32");
        var existing=server.GetValue("") as string;
        if(existing is not null&&!existing.Equals(library,StringComparison.OrdinalIgnoreCase)&&File.Exists(existing)) {
            var installed=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TCloud","Windows","app")+Path.DirectorySeparatorChar;
            if(!Path.GetFullPath(existing).StartsWith(installed,StringComparison.OrdinalIgnoreCase)||!library.StartsWith(installed,StringComparison.OrdinalIgnoreCase))
                throw new IOException("既存のエクスプローラー連携と保存先が異なります。");
        }
        cls.SetValue("","T-Cloud");server.SetValue("",library);server.SetValue("ThreadingModel","Apartment");
        using var shell=cls.CreateSubKey("ShellFolder");shell.SetValue("Attributes",unchecked((int)0xe0000011),RegistryValueKind.DWord);
    }
    public static void ProtectFolder(string directory)
    {
        _=VolumeInspector.ValidateDestination(directory,[]);var path=Path.Combine(directory,"desktop.ini");WindowsAtomicState.Check(path);
        var text="[.ShellClassInfo]\r\nCLSID="+ClassId+"\r\nCLSID2="+ClassId+"\r\n";
        if(File.Exists(path)) {
            if(File.ReadAllText(path,Encoding.Unicode)!=text)throw new IOException("既存のフォルダ表示設定を上書きしません。");
            return;
        }
        using(var stream=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read,4096,FileOptions.WriteThrough))
        using(var writer=new StreamWriter(stream,Encoding.Unicode)){writer.Write(text);writer.Flush();stream.Flush(true);}
        File.SetAttributes(path,FileAttributes.Hidden|FileAttributes.System);
        File.SetAttributes(directory,File.GetAttributes(directory)|FileAttributes.ReadOnly|FileAttributes.System);
        SHChangeNotify(0x8000000,0x1000,0,0);
    }
    [DllImport("shell32.dll")] private static extern void SHChangeNotify(uint id,uint flags,nint item1,nint item2);
}

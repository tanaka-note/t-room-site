using System.Security.AccessControl;
using System.Security.Principal;

namespace XDownloader.Auth;

public static class PrivateFiles
{
    public static void EnsureDirectory(string path)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in new[] { WindowsIdentity.GetCurrent().User!, new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        var info = new DirectoryInfo(path);
        if (!info.Exists) info.Create(security);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("ログイン情報の保存先にリンクが設定されています。安全な保存先を確認してください。");
        info.SetAccessControl(security);
    }

    public static string CreateOwnedDirectory(string parent)
    {
        EnsureDirectory(parent);
        var path = System.IO.Path.Combine(parent,Guid.NewGuid().ToString("N"));
        EnsureDirectory(path);
        File.WriteAllText(System.IO.Path.Combine(path,".owned"),"x-downloader-private-v1");
        return path;
    }

    public static void DeleteOwnedDirectory(string parent, string path)
    {
        var relative = System.IO.Path.GetRelativePath(System.IO.Path.GetFullPath(parent),System.IO.Path.GetFullPath(path));
        if (!Guid.TryParseExact(relative,"N",out _) || !Directory.Exists(path)) return;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("ログイン用の一時領域を安全に削除できませんでした。");
        var marker = System.IO.Path.Combine(path,".owned");
        if (!File.Exists(marker) || File.ReadAllText(marker) != "x-downloader-private-v1") return;
        // Enumerate without traversing links before recursively deleting app-owned state.
        CheckNoLinks(path);
        Directory.Delete(path,recursive:true);
    }

    private static void CheckNoLinks(string directory)
    {
        foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
        {
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("ログイン用の一時領域にリンクがあります。自動削除を中止しました。");
            if (entry is DirectoryInfo child) CheckNoLinks(child.FullName);
        }
    }

    public static void CleanOwnedDirectories(string parent)
    {
        EnsureDirectory(parent);
        foreach (var path in Directory.EnumerateDirectories(parent)) DeleteOwnedDirectory(parent,path);
    }
}

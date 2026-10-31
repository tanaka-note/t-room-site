using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using TCloud.Sync.Core;

namespace TCloud.Sync.Windows;

public sealed record StorageVolume(string MountPoint, string GuidPath, uint SerialNumber, string FileSystem,
    DriveType DriveType, long AvailableBytes)
{
    public bool Supported => FileSystem.Equals("NTFS", StringComparison.OrdinalIgnoreCase) && DriveType == DriveType.Fixed;
    public bool Matches(VolumeBinding expected) => Supported && SerialNumber == expected.SerialNumber
        && GuidPath.Equals(expected.GuidPath, StringComparison.OrdinalIgnoreCase);
}

public static class VolumeInspector
{
    // This probe never creates directories, registers a provider or formats disks.
    public static StorageVolume Inspect(string path)
    {
        var absolute = Path.GetFullPath(path);
        var mount = new StringBuilder(1024);
        if (!GetVolumePathName(absolute, mount, mount.Capacity)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var guid = new StringBuilder(1024);
        if (!GetVolumeNameForVolumeMountPoint(mount.ToString(), guid, guid.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var fileSystem = new StringBuilder(64);
        if (!GetVolumeInformation(mount.ToString(), null, 0, out var serial, out _, out _, fileSystem, fileSystem.Capacity))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var drive = new DriveInfo(mount.ToString());
        return new(mount.ToString(), guid.ToString(), serial, fileSystem.ToString(), drive.DriveType, drive.AvailableFreeSpace);
    }

    public static VolumeBinding ValidateDestination(string path, IEnumerable<string> otherSyncRoots)
    {
        var absolute = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var volume = Inspect(absolute);
        if (!volume.Supported) throw new IOException("保存先にはNTFSの固定ディスクを選択してください。");
        if (absolute.Equals(Path.TrimEndingDirectorySeparator(volume.MountPoint), StringComparison.OrdinalIgnoreCase))
            throw new IOException("ドライブ全体ではなくT-Cloud専用フォルダを選択してください。");
        foreach (var other in otherSyncRoots.Where(item => !string.IsNullOrWhiteSpace(item)))
        {
            var otherRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(other));
            if (Overlaps(absolute, otherRoot)) throw new IOException("他の同期サービスと重なるフォルダは選択できません。");
        }
        for (var directory = new DirectoryInfo(absolute); directory is not null; directory = directory.Parent)
            if (directory.Exists && directory.LinkTarget is not null) throw new IOException("リンク経由のフォルダは選択できません。");
        return new(volume.GuidPath, volume.SerialNumber, Path.GetRelativePath(volume.MountPoint, absolute));
    }

    public static bool IsExpectedVolumePresent(string root, VolumeBinding binding)
    {
        try
        {
            var volume = Inspect(root);
            return volume.Matches(binding) && string.Equals(Path.GetRelativePath(volume.MountPoint, Path.GetFullPath(root)),
                binding.RelativeRoot, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception error) when (error is IOException or Win32Exception or UnauthorizedAccessException) { return false; }
    }

    private static bool Overlaps(string a, string b) => a.Equals(b, StringComparison.OrdinalIgnoreCase)
        || a.StartsWith(b + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
        || b.StartsWith(a + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    [DllImport("kernel32.dll", EntryPoint = "GetVolumePathNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumePathName(string path, StringBuilder volumePath, int length);
    [DllImport("kernel32.dll", EntryPoint = "GetVolumeNameForVolumeMountPointW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, StringBuilder name, int length);
    [DllImport("kernel32.dll", EntryPoint = "GetVolumeInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(string root, StringBuilder? label, int labelLength, out uint serial,
        out uint maximumComponentLength, out uint flags, StringBuilder fileSystem, int fileSystemLength);
}

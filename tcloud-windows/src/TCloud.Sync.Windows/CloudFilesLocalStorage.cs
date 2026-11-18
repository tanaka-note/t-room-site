using Microsoft.Win32.SafeHandles;

namespace TCloud.Sync.Windows;

/// <summary>Retains the complete original. Success from pinning alone is not download completion.</summary>
public static class CloudFilesLocalStorage
{
    // Called by the background download worker with a handle to its validated destination.
    // Both calls are synchronous; do not call this method on the UI/native callback thread.
    public static void HydrateAndKeep(SafeFileHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        if (handle.IsInvalid || handle.IsClosed) throw new ArgumentException("保存先のファイルが開かれていません。", nameof(handle));
        CloudFilesNative.Check(CloudFilesNative.CfSetPinState(handle, 1 /* PINNED */, 0, 0));
        CloudFilesNative.Check(CloudFilesNative.CfHydratePlaceholder(handle, 0, -1 /* CF_EOF */, 0, 0));
    }
}

using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;

internal sealed record ShellCapabilities(bool CanDelete, bool HasDeleteCommand, bool CanRename);

/// <summary>Reads the real Shell's capabilities and classic menu without displaying or invoking it.</summary>
internal static class ShellProbe
{
    public static ShellCapabilities Read(string path)
    {
        ShellCapabilities? result = null;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { result = ReadCurrentApartment(path); }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
        return result!;
    }

    internal static ShellCapabilities ReadCurrentApartment(string path)
    {
        var itemId = typeof(IShellItem).GUID;
        Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, 0, itemId, out var item));
        nint menuPointer = 0;
        var menuHandle = CreatePopupMenu();
        if (menuHandle == 0) throw new System.ComponentModel.Win32Exception();
        try
        {
            Marshal.ThrowExceptionForHR(item.GetAttributes(0x30, out var attributes));
            var handler = new Guid("3981e225-f559-11d3-8e3a-00c04f6837d5"); // BHID_SFUIObject
            var menuId = new Guid("000214e4-0000-0000-c000-000000000046");
            Marshal.ThrowExceptionForHR(item.BindToHandler(0, handler, menuId, out menuPointer));
            var query = ComMethod<QueryMenu>(menuPointer, 3);
            var getCommand = ComMethod<ReadCommand>(menuPointer, 5);
            Marshal.ThrowExceptionForHR(query(menuPointer, menuHandle, 0, 1, 0x7fff, 0));
            var hasDelete = false;
            for (var index = 0; index < GetMenuItemCount(menuHandle); index++)
            {
                var command = GetMenuItemID(menuHandle, index);
                if (command is 0 or uint.MaxValue) continue;
                var verb = new StringBuilder(256);
                if (getCommand(menuPointer, command - 1, 4, 0, verb, 256) >= 0
                    && verb.ToString().Equals("delete", StringComparison.OrdinalIgnoreCase)) hasDelete = true;
            }
            return new((attributes & 0x20) != 0, hasDelete, (attributes & 0x10) != 0);
        }
        finally
        {
            DestroyMenu(menuHandle);
            if (menuPointer != 0) Marshal.Release(menuPointer);
            Marshal.ReleaseComObject(item);
        }
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(nint context, in Guid handler, in Guid interfaceId, out nint result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint type, out nint name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem other, uint hints, out int order);
    }

    private static T ComMethod<T>(nint pointer, int slot) where T : Delegate
        => Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(pointer), slot * IntPtr.Size));

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int QueryMenu(nint instance, nint menu, uint index, uint firstCommand, uint lastCommand, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    private delegate int ReadCommand(nint instance, nuint command, uint type, nint reserved,
        [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, uint length);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, nint context, in Guid interfaceId, out IShellItem item);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint CreatePopupMenu();
    [DllImport("user32.dll")] private static extern int GetMenuItemCount(nint menu);
    [DllImport("user32.dll")] private static extern uint GetMenuItemID(nint menu, int index);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DestroyMenu(nint menu);
}

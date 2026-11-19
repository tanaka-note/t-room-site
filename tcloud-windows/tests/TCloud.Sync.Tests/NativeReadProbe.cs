using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

/// <summary>Compare event-based overlapped Windows I/O with the runtime's IOCP reader.</summary>
internal static class NativeReadProbe
{
    public static byte[] ReadHead(string path)
    {
        _ = FixtureClient.PathArgument(path);
        using var file = CreateFile(path, 0x80000000, 3, 0, 3, 0x40000000, 0);
        if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        using var ready = CreateEvent(0, true, false, null);
        if (ready.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var request = Marshal.AllocHGlobal(Marshal.SizeOf<Overlapped>());
        var result = new byte[1000];
        var pinned = GCHandle.Alloc(result, GCHandleType.Pinned);
        try
        {
            Marshal.StructureToPtr(new Overlapped { Event = ready.DangerousGetHandle() }, request, false);
            if (!ReadFile(file, pinned.AddrOfPinnedObject(), (uint)result.Length, 0, request)
                && Marshal.GetLastWin32Error() != 997) throw new Win32Exception(Marshal.GetLastWin32Error());
            // The buffer and OVERLAPPED remain alive until the kernel completes the I/O.
            if (!GetOverlappedResult(file, request, out var count, true)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (count != result.Length) throw new EndOfStreamException();
            return result;
        }
        finally { pinned.Free(); Marshal.FreeHGlobal(request); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Overlapped { public nint Internal, InternalHigh; public uint Offset, OffsetHigh; public nint Event; }
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEvent(nint security, [MarshalAs(UnmanagedType.Bool)] bool manual,
        [MarshalAs(UnmanagedType.Bool)] bool initial, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(SafeFileHandle file, nint buffer, uint count, nint read, nint request);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOverlappedResult(SafeFileHandle file, nint request, out uint read, [MarshalAs(UnmanagedType.Bool)] bool wait);
}

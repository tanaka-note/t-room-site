using System.Runtime.InteropServices;

namespace TCloud.Sync.Windows;

// Win64 Cloud Files ABI. The native fixture tests validate sizes and real calls.
internal static class CloudFilesNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct Registration
    {
        public uint StructSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderVersion;
        public nint SyncRootIdentity;
        public uint SyncRootIdentityLength;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public Guid ProviderId;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Policy { public ushort Primary; public ushort Modifier; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Policies
    {
        public uint StructSize;
        public Policy Hydration;
        public Policy Population;
        public uint InSync;
        public uint HardLink;
        public uint PlaceholderManagement;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicInfo
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Metadata { public BasicInfo Basic; public long FileSize; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct Placeholder
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string RelativeFileName;
        public Metadata FsMetadata;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public uint Flags;
        public int Result;
        public long CreateUsn;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct CallbackInfo
    {
        public uint StructSize;
        public long ConnectionKey;
        public nint CallbackContext;
        public nint VolumeGuidName;
        public nint VolumeDosName;
        public uint VolumeSerialNumber;
        public long SyncRootFileId;
        public nint SyncRootIdentity;
        public uint SyncRootIdentityLength;
        public long FileId;
        public long FileSize;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public nint NormalizedPath;
        public long TransferKey;
        public byte PriorityHint;
        public nint CorrelationVector;
        public nint ProcessInfo;
        public long RequestKey;
    }
    [StructLayout(LayoutKind.Explicit, Size = 64)]
    internal struct CallbackParameters
    {
        [FieldOffset(0)] public uint ParamSize;
        [FieldOffset(8)] public uint Flags;
        [FieldOffset(16)] public long RequiredOffset;
        [FieldOffset(24)] public long RequiredLength;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    internal delegate void Callback(in CallbackInfo info, in CallbackParameters parameters);
    [StructLayout(LayoutKind.Sequential)]
    internal struct CallbackRegistration { public int Type; public nint Function; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct OperationInfo
    {
        public uint StructSize;
        public int Type;
        public long ConnectionKey;
        public long TransferKey;
        public nint CorrelationVector;
        public nint SyncStatus;
        public long RequestKey;
    }
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    internal struct TransferParameters
    {
        [FieldOffset(0)] public uint ParamSize;
        [FieldOffset(8)] public uint Flags;
        [FieldOffset(12)] public int CompletionStatus;
        [FieldOffset(16)] public nint Buffer;
        [FieldOffset(24)] public long Offset;
        [FieldOffset(32)] public long Length;
    }

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    internal static extern int CfRegisterSyncRoot(string path, in Registration registration, in Policies policies, uint flags);
    [DllImport("cldapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    internal static extern int CfUnregisterSyncRoot(string path);
    [DllImport("cldapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    internal static extern int CfConnectSyncRoot(string path, [In] CallbackRegistration[] callbacks,
        nint context, uint flags, out long connectionKey);
    [DllImport("cldapi.dll", PreserveSig = true)]
    internal static extern int CfDisconnectSyncRoot(long connectionKey);
    [DllImport("cldapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    internal static extern int CfCreatePlaceholders(string path, [In, Out] Placeholder[] placeholders, uint count, uint flags, out uint processed);
    [DllImport("cldapi.dll", PreserveSig = true)]
    internal static extern int CfExecute(in OperationInfo info, in TransferParameters parameters);

    internal static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
}

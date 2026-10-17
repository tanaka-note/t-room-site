using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace XDownloader.Core;

[SupportedOSPlatform("windows")]
internal static class WindowsProcessJob
{
    internal static SafeFileHandle Attach(Process process)
    {
        var job=CreateJobObject(IntPtr.Zero,null);
        try
        {
            if (job.IsInvalid) throw new InvalidOperationException();
            var information=new ExtendedLimit { Basic=new BasicLimit { Flags=0x2000 } }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            var size=Marshal.SizeOf<ExtendedLimit>();
            var buffer=Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information,buffer,false);
                if (!SetInformationJobObject(job,9,buffer,(uint)size) || !AssignProcessToJobObject(job,process.Handle))
                    throw new InvalidOperationException();
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return job;
        }
        catch
        {
            job.Dispose();
            try { if (!process.HasExited) process.Kill(entireProcessTree:true); process.WaitForExit(); }
            catch (InvalidOperationException) { }
            throw new InvalidOperationException("取得プロセスの安全な実行環境を準備できませんでした。アプリを再起動してください。");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long PerProcessTime,PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet,MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }

    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateJobObjectW")]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes,string? name);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job,int informationClass,IntPtr information,uint length);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job,IntPtr process);
}

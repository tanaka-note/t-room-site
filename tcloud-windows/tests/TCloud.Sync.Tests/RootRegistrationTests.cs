using System.Security.Cryptography;
using System.Runtime.InteropServices;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class RootRegistrationTests
{
    public static Task FreshVolume()
    {
        var temporary=Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()))+Path.DirectorySeparatorChar;
        var directory=Path.GetFullPath(Path.Combine(temporary,"tcloud-root-bootstrap-"+Guid.NewGuid().ToString("N")));
        if(!directory.StartsWith(temporary,StringComparison.OrdinalIgnoreCase))throw new IOException("Invalid fixture directory");
        Directory.CreateDirectory(directory);CloudFilesRootRegistration? mounted=null;
        static int Uninitialized(string path,int kind,nint buffer,uint length,out uint returned){returned=0;return unchecked((int)0x80070001);}
        try {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),directory,VolumeInspector.ValidateDestination(directory,[]));
            mounted=CloudFilesRootRegistration.Attach(registration,[],true,Uninitialized);mounted.VerifyPresent();
            var saved=registration with {RootFileId=mounted.FileId};
            Throws<COMException>(()=>CloudFilesRootRegistration.Attach(saved,[],false,Uninitialized));
            mounted.VerifyPresent();
            var foreignRejected=false;
            try{_=CloudFilesRootRegistration.Attach(registration with {ScopeHash=new string('0',64)},[],true,Uninitialized);}
            catch(Exception error)when(error is COMException or IOException or UnauthorizedAccessException
                ||error is ArgumentException&&error.HResult==unchecked((int)0x80070057)){foreignRejected=true;}
            Check(foreignRejected,"the non-update registration must reject an existing owner even when the initial query fails");mounted.VerifyPresent();
            mounted.UnregisterPreservingOriginals();mounted=null;
            var sentinel=Path.Combine(directory,"sentinel.txt");File.WriteAllText(sentinel,"existing plaintext");
            Throws<COMException>(()=>CloudFilesRootRegistration.Attach(registration,[],true,Uninitialized));
            Check(File.ReadAllText(sentinel)=="existing plaintext","a populated directory is never adopted after a failed query");
        }finally{mounted?.UnregisterPreservingOriginals();Directory.Delete(directory,true);}
        return Task.CompletedTask;
    }
    public static Task Persistence()
    {
        var directory=Path.Combine(Path.GetTempPath(),"tcloud-root-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        CloudFilesRootRegistration? mounted=null;
        try
        {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),directory,
                VolumeInspector.ValidateDestination(directory,[]));
            mounted=CloudFilesRootRegistration.Attach(registration,[],initialize:true);
            registration=registration with {RootFileId=mounted.FileId};
            var path=Path.Combine(directory,"saved.txt");File.WriteAllText(path,"saved plaintext");
            _=CloudFilesRootRegistration.Attach(registration,[]);
            Throws<IOException>(()=>CloudFilesRootRegistration.Attach(registration with {ScopeHash=new string('0',64)},[]));
            var child=Path.Combine(directory,"nested");Directory.CreateDirectory(child);
            var nested=registration with {Destination=child,Volume=VolumeInspector.ValidateDestination(child,[])};
            Throws<IOException>(()=>CloudFilesRootRegistration.Attach(nested,[],initialize:true));
            mounted.UnregisterPreservingOriginals();mounted=null;
            Check(File.ReadAllText(path)=="saved plaintext","explicit unlink preserves every original");
            var moved=directory+"-moved";Directory.Move(directory,moved);
            try {Throws<IOException>(()=>CloudFilesRootRegistration.Attach(registration,[]));Check(!Directory.Exists(directory),"a moved sync root is never silently recreated");}
            finally {Directory.Move(moved,directory);}
            Throws<IOException>(()=>CloudFilesRootRegistration.Attach(registration with {RootFileId=null},[],initialize:true));
            mounted=CloudFilesRootRegistration.Attach(registration,[]);
            Check(File.ReadAllText(path)=="saved plaintext","a recorded directory can recover its own registration without touching the body");
            mounted.UnregisterPreservingOriginals();mounted=null;
            Check(File.ReadAllText(path)=="saved plaintext","unowned populated directory is never adopted or modified");
        }
        finally {mounted?.UnregisterPreservingOriginals();Directory.Delete(directory,true);}
        return Task.CompletedTask;
    }
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    private static void Throws<T>(Action action)where T:Exception {try{action();}catch(T){return;}throw new InvalidOperationException("Expected "+typeof(T).Name);}
}

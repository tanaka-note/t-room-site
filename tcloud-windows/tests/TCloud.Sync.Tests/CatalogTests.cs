using System.Security.Cryptography;
using System.Diagnostics;
using System.Text.Json;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class CatalogTests
{
    public static async Task PathBatches()
    {
        var directory=Path.Combine(Path.GetTempPath(),"tcloud-path-batch-"+Guid.NewGuid().ToString("N"));
        var root=Path.Combine(directory,"root");var parent=Path.Combine(root,"parent");var outside=Path.Combine(directory,"outside");
        Directory.CreateDirectory(parent);Directory.CreateDirectory(outside);File.WriteAllText(Path.Combine(outside,"sentinel.txt"),"keep");
        try {
            var paths=Enumerable.Range(0,3200).Select(i=>"parent/file-"+i+".txt").ToArray();
            LocalPaths.ValidateAllUnderRoot(root,paths);
            foreach(var invalid in new[]{"../outside","parent/file:stream","parent//file","C:\\outside"})
                await Throws<ArgumentException>(()=>{LocalPaths.ValidateAllUnderRoot(root,paths.Append(invalid));return Task.CompletedTask;});
            // A batch never caches filesystem trust across calls or into I/O.
            Directory.Delete(parent);
            var start=new ProcessStartInfo("cmd.exe"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
            foreach(var arg in new[]{"/c","mklink","/J",parent,outside})start.ArgumentList.Add(arg);
            using(var process=Process.Start(start)!) {await process.WaitForExitAsync();Check(process.ExitCode==0,"create isolated junction fixture");}
            await Throws<IOException>(()=>{LocalPaths.ValidateAllUnderRoot(root,paths);return Task.CompletedTask;});
            await Throws<IOException>(()=>Task.FromResult(LocalPaths.ResolveUnderRoot(root,"parent/sentinel.txt")));
            Check(File.ReadAllText(Path.Combine(outside,"sentinel.txt"))=="keep","link target remains untouched");
        }finally {
            if(new DirectoryInfo(parent).LinkTarget is not null)Directory.Delete(parent);
            Directory.Delete(directory,true);
        }
    }
    public static async Task Restart()
    {
        var directory=Path.Combine(Path.GetTempPath(),"tcloud-catalog-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        try
        {
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Hash(),Hash(),Hash(),Path.Combine(directory,"originals"),new("fixture-volume",1,"originals"),123);
            var path=Path.Combine(directory,"catalog.json");var store=new LocalSyncCatalog(path,registration);
            var state=store.Empty() with {Originals=[new(17,10,"saved.txt",Hash(),22,Hash(),true)]};
            var start=new WindowsCatalogStart(new string('a',32),20);
            var item=new WindowsCatalogEntry("file",17,20,"present",JsonSerializer.SerializeToElement(new {name="saved.txt"}),null,null);
            state=LocalSyncCatalog.ApplyPage(state,start,new(start.Epoch,20,20,true,[item]));
            await store.SaveAsync(state);
            var reopened=await new LocalSyncCatalog(path,registration).LoadAsync();
            Check(reopened.RemotePosition==state.RemotePosition&&reopened.Originals.Single()==state.Originals.Single(),"cursor and original baseline survive reopening together");
            using var cancel=new CancellationTokenSource();cancel.Cancel();
            await Throws<OperationCanceledException>(()=>store.SaveAsync(state with {Originals=[]},cancel.Token));
            Check((await store.LoadAsync()).Originals.Length==1,"an interrupted checkpoint preserves the previous originals and cursor");
            await Throws<InvalidDataException>(()=>new LocalSyncCatalog(path,registration with {RootFileId=999}).LoadAsync());
            var reset=new WindowsCatalogStart(new string('b',32),1);
            await Throws<WindowsCatalogResetException>(()=>Task.FromResult(LocalSyncCatalog.ApplyPage(state,reset,new(reset.Epoch,1,1,true,[]))));
            var resnapshot=LocalSyncCatalog.ApplyPage(state,reset,new(reset.Epoch,1,1,true,[]),reset:true);
            Check(resnapshot.Remote.Length==0&&resnapshot.Originals.Length==1,"a catalog reset or missing remote item never drops the saved local baseline");
            var deletion=new WindowsCatalogEntry("file",17,21,"trashed",null,"2026-11-19T00:00:00Z",Guid.NewGuid().ToString("N"));
            var deleted=LocalSyncCatalog.ApplyPage(state,new(start.Epoch,21),new(start.Epoch,21,21,true,[deletion]));
            await store.SaveAsync(deleted);
            var old=LocalSyncCatalog.ApplyPage(deleted,new(start.Epoch,21),new(start.Epoch,21,21,true,[item]));
            Check(old.Remote.Single().State=="trashed","a late older record cannot resurrect a known tombstone");
            Check(!Directory.EnumerateFiles(directory,"*.pending").Any(),"checkpoint leaves no partial metadata file");
        }
        finally {Directory.Delete(directory,true);}
    }
    private static string Hash()=>Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    private static async Task Throws<T>(Func<Task> action)where T:Exception{try{await action();}catch(T){return;}throw new InvalidOperationException("Expected "+typeof(T).Name);}
}

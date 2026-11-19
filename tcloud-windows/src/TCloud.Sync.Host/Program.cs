using System.Security.Principal;
using System.Text.Json;
using TCloud.Sync.Windows;

namespace TCloud.Sync.Host;

internal static class Program
{
    [STAThread] private static int Main(string[] args)
    {
        if(args.Length==2&&args[0]=="--render-login") {
            ApplicationConfiguration.Initialize();using var preview=new MainForm(false,preview:true);
            preview.Show();Application.DoEvents();preview.PerformLayout();
            foreach(Control panel in preview.Controls)foreach(Control control in panel.Controls)
                if(control.Visible&&(control.Bottom>panel.ClientSize.Height-panel.Padding.Bottom||control.Right>panel.ClientSize.Width-panel.Padding.Right))
                    throw new InvalidOperationException("ログインカードの内容が表示領域からはみ出しています。");
            using var bitmap=new Bitmap(preview.Width,preview.Height);preview.DrawToBitmap(bitmap,new Rectangle(Point.Empty,preview.Size));
            using var output=new FileStream(Path.GetFullPath(args[1]),FileMode.CreateNew,FileAccess.Write,FileShare.None);
            bitmap.Save(output,System.Drawing.Imaging.ImageFormat.Png);return 0;
        }
        if(args.Length==2&&args[0]=="inspect") {
            try {
                var binding=VolumeInspector.ValidateDestination(args[1],MainForm.OtherSyncRoots());var volume=VolumeInspector.Inspect(args[1]);
                Console.WriteLine(JsonSerializer.Serialize(new{supported=true,volume.FileSystem,volume.DriveType,volume.AvailableBytes,destination=Path.GetFullPath(args[1]),binding.RelativeRoot}));return 0;
            }catch(Exception error)when(error is IOException or ArgumentException or System.ComponentModel.Win32Exception){Console.Error.WriteLine(error.Message);return 1;}
        }
        var sid=WindowsIdentity.GetCurrent().User!.Value;
        var exitEventName=@"Local\TCloud.Windows.Quit."+sid;
        if(args.SequenceEqual(new[]{"--quit"})) {
            try{using var existing=EventWaitHandle.OpenExisting(exitEventName);existing.Set();}catch(WaitHandleCannotBeOpenedException){ }return 0;
        }
        using var mutex=new Mutex(false,@"Local\TCloud.Windows."+sid);
        bool acquired;
        try{acquired=mutex.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}
        if(!acquired)return 0;
        try{
            ApplicationConfiguration.Initialize();using var form=new MainForm(args.Contains("--background"));
            using var exitEvent=new EventWaitHandle(false,EventResetMode.ManualReset,exitEventName);exitEvent.Reset();
            var wait=ThreadPool.RegisterWaitForSingleObject(exitEvent,(_,_)=>{
                try{form.BeginInvoke(async()=>await form.QuitFromRequestAsync());}catch(InvalidOperationException){ }
            },null,Timeout.Infinite,true);
            try{Application.Run(form);}finally{wait.Unregister(null);}return 0;
        }
        finally{mutex.ReleaseMutex();}
    }
}

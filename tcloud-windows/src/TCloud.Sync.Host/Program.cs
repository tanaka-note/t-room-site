using System.Security.Principal;
using System.Text.Json;
using TCloud.Sync.Windows;

namespace TCloud.Sync.Host;

internal static class Program
{
    [STAThread] private static int Main(string[] args)
    {
        if(args.Length==2&&args[0] is "--render-login" or "--render-sync-status") {
            ApplicationConfiguration.Initialize();using var preview=new MainForm(false,preview:true);
            var dashboard=args[0]=="--render-sync-status"?preview.ShowDashboardForPreview():null;
            preview.Show();Application.DoEvents();preview.PerformLayout();
            if(dashboard is null){
                foreach(Control panel in preview.Controls)foreach(Control control in panel.Controls)
                    if(control.Visible&&(control.Bottom>panel.ClientSize.Height-panel.Padding.Bottom||control.Right>panel.ClientSize.Width-panel.Padding.Right))
                        throw new InvalidOperationException("ログインカードの内容が表示領域からはみ出しています。");
            }else PopulateDashboardPreview(dashboard);
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

    private static void PopulateDashboardPreview(SyncDashboard dashboard)
    {
        var now=new DateTimeOffset(2026,11,27,14,38,0,TimeSpan.FromHours(9));
        WindowsActivityItem Item(string id,string path,WindowsActivityOperation operation,WindowsActivityState state,long? size=null,long bytes=0,string? reason=null)
            =>new(id,path,operation,state,now.AddMinutes(-2),size,bytes,reason,
                state is WindowsActivityState.Confirmed or WindowsActivityState.Retained?now.AddMinutes(-1):null);
        dashboard.SetConnection(true,@"E:\T-Cloud",true,null);
        dashboard.Apply(new(1,
            [Item("memo","会議メモ.txt",WindowsActivityOperation.Added,WindowsActivityState.Attention,
                reason:"HDD内にある既存のT-Cloudフォルダへ移動すると自動送信されます。"),
             Item("video",@"写真・動画\旅行\旅行動画.mp4",WindowsActivityOperation.Added,WindowsActivityState.Sending,2576980377,859832320),
             Item("bill",@"仕事\経理\領収書_11月.pdf",WindowsActivityOperation.Updated,WindowsActivityState.Checking,348160),
             Item("quote",@"仕事\B社\見積書.pdf",WindowsActivityOperation.Updated,WindowsActivityState.Confirmed,493568)],
            [Item("copy",@"写真・動画\旅行\旅行写真.jpg",WindowsActivityOperation.Downloaded,WindowsActivityState.Retained,6081740)],
            now,true,null));
        if(dashboard.VisibleCount!=4)throw new InvalidOperationException("送信履歴が表示されません。");
        dashboard.SelectDirection(1);
        if(dashboard.VisibleCount!=1)throw new InvalidOperationException("原本取得の一覧に切り替えられません。");
        dashboard.SelectDirection(0);
        Application.DoEvents();
    }
}

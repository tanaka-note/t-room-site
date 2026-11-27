using Microsoft.Win32;
using System.Diagnostics;
using System.Security.Cryptography;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

namespace TCloud.Sync.Host;

internal sealed class MainForm:Form
{
    private readonly WindowsDeviceRegistrationFile registrationFile=WindowsDeviceRegistrationFile.ForCurrentUser();
    private readonly string pcDirectory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TCloud","Windows");
    private readonly Button enroll=new(){Text="パスキーでログイン",Height=44,Width=364};
    private readonly Button choose=new(){Text="HDDの保存先を選択",Height=36,Width=364};
    private readonly Button open=new(){Text="HDDのフォルダを開く",Height=36,Width=364,Visible=false};
    private readonly Label destination=new(){AutoSize=false,Height=44,Width=364};
    private readonly Label status=new(){AutoSize=false,Height=80,Width=364,Text="保存先を選択してください。"};
    private readonly CheckBox startup=new(){Text="Windowsへのサインイン時に同期を再開",Checked=true,Width=364,Height=30};
    private readonly Label instruction=new(){Text="パスキーを使ってログインしてください。",Width=364,Height=32};
    private readonly FlowLayoutPanel card;
    private readonly NotifyIcon tray;
    private readonly CancellationTokenSource lifetime=new();
    private readonly System.Windows.Forms.Timer dashboardTimer=new(){Interval=650};
    private SyncDashboard? dashboard;
    private WindowsSyncActivity? activity;
    private WindowsSyncEngine? activeEngine;
    private WindowsSyncLoop? activeLoop;
    private long dashboardVersion=-1;
    private Task? service;
    private Task? enrollmentTask;
    private bool quitting;
    private string? selected;
    public MainForm(bool background,bool preview=false)
    {
        Text="T-Cloud HDD同期";ClientSize=new(500,590);MinimumSize=MaximumSize=Size;StartPosition=FormStartPosition.CenterScreen;
        Font=new("Yu Gothic UI",10);BackColor=Color.FromArgb(244,246,243);ForeColor=Color.FromArgb(41,56,49);
        card=new FlowLayoutPanel{Location=new(30,30),Size=new(440,530),Padding=new(36,24,36,24),BackColor=Color.White,
            FlowDirection=FlowDirection.TopDown,WrapContents=false};
        card.Controls.Add(new Label{Text="T-Cloud",Font=new(Font.FontFamily,20,FontStyle.Bold),Width=364,Height=48});
        card.Controls.Add(instruction);card.Controls.Add(enroll);card.Controls.Add(choose);card.Controls.Add(destination);card.Controls.Add(startup);card.Controls.Add(open);card.Controls.Add(status);Controls.Add(card);
        enroll.BackColor=Color.FromArgb(87,114,99);enroll.ForeColor=Color.White;enroll.FlatStyle=FlatStyle.Flat;enroll.FlatAppearance.BorderSize=0;
        enroll.Enabled=false;choose.Click+=Choose;enroll.Click+=Enroll;
        open.Click+=(_,_)=>OpenHdd();
        startup.CheckedChanged+=(_,_)=>{if(registrationFile.Exists)SetStartup();};
        var menu=new ContextMenuStrip();menu.Items.Add("同期状況を開く",null,(_,_)=>{Show();WindowState=FormWindowState.Normal;Activate();});
        menu.Items.Add("HDDのフォルダを開く",null,(_,_)=>OpenHdd());menu.Items.Add("終了",null,async(_,_)=>await QuitAsync());
        menu.Items.Insert(2,new ToolStripMenuItem("保全した編集を開く",null,(_,_)=>OpenRecovery(null)));
        tray=new NotifyIcon{Icon=SystemIcons.Application,Text="T-Cloud HDD同期",ContextMenuStrip=menu,Visible=!preview};
        tray.DoubleClick+=(_,_)=>{Show();Activate();};
        FormClosing+=(_,args)=>{if(quitting)return;if(args.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing){lifetime.Cancel();return;}args.Cancel=true;Hide();};
        dashboardTimer.Tick+=(_,_)=>RefreshDashboard();
        VisibleChanged+=(_,_)=>{if(Visible){RefreshDashboard();if(dashboard is not null)dashboardTimer.Start();}else dashboardTimer.Stop();};
        FormClosed+=(_,_)=>dashboardTimer.Dispose();
        Shown+=(_,_)=>{if(!preview&&registrationFile.Exists){ShowRegistered();service=RunServiceAsync(lifetime.Token);if(background)Hide();}};
        if(preview){choose.Enabled=enroll.Enabled=false;FormClosed+=(_,_)=>tray.Dispose();}
    }
    internal static IEnumerable<string> OtherSyncRoots()=>new[]{Environment.GetEnvironmentVariable("OneDrive"),Environment.GetEnvironmentVariable("OneDriveConsumer"),Environment.GetEnvironmentVariable("OneDriveCommercial")}.OfType<string>();
    private void Choose(object? sender,EventArgs args)
    {
        using var dialog=new FolderBrowserDialog{Description="NTFSの外付けHDDに、空のT-Cloud専用フォルダを選択してください。",UseDescriptionForTitle=true,ShowNewFolderButton=true};
        if(dialog.ShowDialog(this)!=DialogResult.OK)return;
        try {
            _=VolumeInspector.ValidateDestination(dialog.SelectedPath,OtherSyncRoots());
            if(Directory.EnumerateFileSystemEntries(dialog.SelectedPath).Any())throw new IOException("初回は空の専用フォルダを選択してください。");
            selected=dialog.SelectedPath;destination.Text=selected;enroll.Enabled=true;status.Text="初回のみパスキーで本人確認を行います。";
        }catch(Exception error){status.Text=SafeMessage(error);}
    }
    private async void Enroll(object? sender,EventArgs args)
    {enrollmentTask=EnrollAsync();await enrollmentTask;}
    private async Task EnrollAsync()
    {
        if(selected is null||service is not null)return;choose.Enabled=enroll.Enabled=false;
        try {
            WindowsShellProtection.Register(Path.Combine(AppContext.BaseDirectory,"TCloud.ShellExtension.dll"));
            await WindowsDeviceEnrollment.EnrollAsync(Handle,false,selected,registrationFile,new Progress<string>(s=>{if(service is null)status.Text=s;}),lifetime.Token,preferBestRole:true);
            SetStartup();ShowRegistered();service=RunServiceAsync(lifetime.Token);
        }catch(Exception error){status.Text=SafeMessage(error);if(registrationFile.Exists){ShowRegistered();service=RunServiceAsync(lifetime.Token);}else choose.Enabled=enroll.Enabled=true;}
    }
    private void ShowRegistered()
    {
        startup.Checked=StartupEnabled();
        if(startup.Checked)SetStartup();
        ShowDashboard();
    }
    private void ShowDashboard()
    {
        if(dashboard is not null)return;
        SuspendLayout();
        card.Visible=false;
        MaximumSize=Size.Empty;
        MinimumSize=new(850,570);
        ClientSize=new(990,645);
        dashboard=new(startup,OpenHdd);
        dashboard.CheckRequested+=()=>{
            activeEngine?.RequestCheck();activeLoop?.RequestCheck();RefreshDashboard();
        };
        dashboard.RecoveryRequested+=OpenRecovery;
        dashboard.VerifyRequested+=async row=>await ReadbackAsync(row);
        Controls.Add(dashboard);dashboard.BringToFront();
        ResumeLayout(true);
        if(Visible)dashboardTimer.Start();
    }
    internal SyncDashboard ShowDashboardForPreview()
    {
        ShowDashboard();return dashboard!;
    }
    private void OpenHdd()
    {
        try {
            var path=CloudFilesRootRegistration.ResolveDestination(registrationFile.Load());
            Process.Start(new ProcessStartInfo(path){UseShellExecute=true});
        }catch(Exception error){ShowActionMessage(SafeMessage(error));}
    }
    private void OpenRecovery(WindowsActivityItem? item)
    {
        try {
            var registered=registrationFile.Load();var root=CloudFilesRootRegistration.ResolveDestination(registered);
            var recovery=item?.PreservedPath is {} saved?Path.GetDirectoryName(LocalPaths.ResolveUnderRoot(root,saved))!
                :Path.Combine(Path.GetDirectoryName(root)!,".TCloud-"+registered.DeviceId,"Recovery");
            if(Directory.Exists(recovery))Process.Start(new ProcessStartInfo(recovery){UseShellExecute=true});
            else ShowActionMessage("保全した編集のフォルダを確認できません。");
        }catch(Exception error){ShowActionMessage(SafeMessage(error));}
    }
    private void ShowActionMessage(string message)
    {
        if(dashboard is not null)MessageBox.Show(this,message,Text,MessageBoxButtons.OK,MessageBoxIcon.Information);
        else status.Text=message;
    }
    private async Task ReadbackAsync(WindowsActivityItem item)
    {
        if(activeEngine is not {} engine||dashboard is not {} view)return;
        view.ShowReadback(item.Key,true,"オンラインの原本を読み戻しています。");
        try {
            await engine.VerifyReadbackAsync(item.Key,new Progress<long>(bytes=>{
                if(item.Size is >0)view.ShowReadback(item.Key,true,$"原本を読み戻しています（{bytes/(double)item.Size.Value:P0}）。");
            }),lifetime.Token);
            view.ShowReadback(item.Key,false,"原本の読み戻し検証済み");RefreshDashboard();
        }catch(Exception error)when(error is IOException or HttpRequestException or CryptographicException or InvalidDataException
            or UnauthorizedAccessException or OperationCanceledException or System.ComponentModel.Win32Exception){
            if(!lifetime.IsCancellationRequested)view.ShowReadback(item.Key,false,error is IOException or InvalidDataException?error.Message:"原本を読み戻せませんでした。接続と原本の状態を確認してください。");
        }
    }
    private void RefreshDashboard()
    {
        if(dashboard is null||activity?.Snapshot(dashboardVersion) is not {} snapshot)return;
        dashboardVersion=snapshot.Version;dashboard.Apply(snapshot);
    }
    private async Task RunServiceAsync(CancellationToken token)
    {
        while(!token.IsCancellationRequested) {
            var connected=false;
            try {
                var registration=registrationFile.Load();
                if(registration.RootFileId is not null)await LoadActivityAsync(registration,token);
                WindowsShellProtection.Register(Path.Combine(AppContext.BaseDirectory,"TCloud.ShellExtension.dll"));
                SetStatus("HDDの同期フォルダを確認しています。");
                var root=await Task.Run(()=>CloudFilesRootRegistration.Attach(registration,OtherSyncRoots(),initialize:registration.RootFileId is null),token);
                if(registration.RootFileId is null){registration=registration with {RootFileId=root.FileId};registrationFile.Save(registration);}
                if(!registration.Destination.Equals(root.Root,StringComparison.OrdinalIgnoreCase)){
                    registration=registration with {Destination=root.Root};registrationFile.Save(registration);
                }
                connected=true;
                await LoadActivityAsync(registration,token);
                var statePath=Path.Combine(pcDirectory,"catalog.json");
                if(!File.Exists(statePath)&&Directory.EnumerateFileSystemEntries(root.Root).Any(p=>!Path.GetFileName(p).Equals("desktop.ini",StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidDataException("同期記録がありません。HDDの原本を保持して同期を停止しました。");
                var catalog=new LocalSyncCatalog(statePath,registration);if(!File.Exists(statePath))await catalog.SaveAsync(catalog.Empty(),token);
                WindowsShellProtection.ProtectFolder(root.Root);destination.Text=root.Root;
                using var http=WindowsDeviceClient.CreateTransport();using var device=new WindowsDeviceClient(http,registration);
                using var session=CancellationTokenSource.CreateLinkedTokenSource(token);
                await using var engine=new WindowsSyncEngine(device,registration,root,catalog,pcDirectory,protectFolder:WindowsShellProtection.ProtectFolder,activity:activity);
                var sync=new WindowsSyncLoop(new(new WindowsCatalogClient(device),catalog),root.VerifyPresent,engine.ReconcileAsync,
                    new Progress<WindowsSyncStatus>(s=>{
                        if(!ReferenceEquals(activeEngine,engine))return;
                        if(s.State is WindowsSyncState.Current){dashboard?.SetConnection(true,root.Root,true,null);return;}
                        if(s.State is WindowsSyncState.Checking)return;
                        var reason=StateMessage(s.State);engine.SetCatalogUnavailable(reason);
                        var present=s.State!=WindowsSyncState.DestinationUnavailable;
                        dashboard?.SetConnection(present,root.Root,s.State==WindowsSyncState.ConnectionPending,reason);
                    }));
                activeEngine=engine;activeLoop=sync;
                dashboard?.SetConnection(true,root.Root,true,"オンラインの一覧を確認しています。");
                var polling=sync.RunAsync(session.Token);var finished=await Task.WhenAny(polling,engine.Completion);session.Cancel();
                if(finished==engine.Completion){await engine.Completion;await polling;throw new IOException("同期処理を再開しています。");}
                var stopped=await polling;
                if(stopped is WindowsSyncState.AuthorizationRevoked or WindowsSyncState.InitialRegistrationIncomplete or WindowsSyncState.StateInvalid){
                    engine.SetCatalogUnavailable(StateMessage(stopped));dashboard?.SetConnection(true,root.Root,false,StateMessage(stopped));return;
                }
            }catch(OperationCanceledException)when(token.IsCancellationRequested){return;}
            catch(Exception error)when(error is CryptographicException or InvalidDataException or UnauthorizedAccessException or System.Text.Json.JsonException or WindowsDeviceRegistrationIncompleteException)
            {ReportUnavailable(connected,SafeMessage(error));return;}
            catch(System.Runtime.InteropServices.COMException error)
            {ReportUnavailable(connected,$"HDDの同期処理を続けられません（Windows 0x{error.HResult:X8}）。再試行します。");}
            catch(Exception error)when(error is IOException or HttpRequestException or System.ComponentModel.Win32Exception)
            {ReportUnavailable(false,"HDDまたは通信の復帰を待っています。保存済みの原本は利用できます。");}
            finally{activeEngine=null;activeLoop=null;}
            try{await Task.Delay(TimeSpan.FromSeconds(5),token);}catch(OperationCanceledException)when(token.IsCancellationRequested){return;}
        }
    }
    private async Task LoadActivityAsync(WindowsDeviceRegistration registration,CancellationToken token)
    {
        if(activity is not null)return;
        var store=new WindowsSyncActivity(pcDirectory,registration);
        await store.LoadAsync(token);activity=store;dashboardVersion=-1;RefreshDashboard();
    }
    private void ReportUnavailable(bool connected,string message)
    {
        activity?.Invalidate(message);
        dashboard?.SetConnection(connected,connected?destination.Text:null,false,message);
        SetStatus(message);
    }
    private void SetStatus(string text){status.Text=text;tray.Text="T-Cloud HDD同期";}
    private static string StateMessage(WindowsSyncState state)=>state switch {
        WindowsSyncState.AuthorizationRevoked=>"端末の同期認可が失効しています。HDDの原本は保持されています。",
        WindowsSyncState.InitialRegistrationIncomplete=>"端末の初回登録が完了していません。HDDの原本は保持されています。",
        WindowsSyncState.StateInvalid=>"同期情報を確認できないため停止しました。HDDの原本は保持されています。",
        WindowsSyncState.DestinationUnavailable=>"登録したHDDの接続を待っています。",
        WindowsSyncState.ConnectionPending=>"通信の復帰を待っています。再ログインは不要です。",_=>"同期を停止しました。"};
    private static string SafeMessage(Exception error)=>error switch {
        WindowsEnrollmentHttpException=>error.Message,
        WindowsDeviceRevokedException or InvalidDataException=>error.Message,
        OperationCanceledException=>"本人確認を中断しました。",
        HttpRequestException=>"通信またはサービスの応答を確認できません。しばらくして再試行してください。",
        CryptographicException=>"端末の鍵または本人確認の結果を確認できません。保存済みの原本は保持されています。",
        IOException or ArgumentException=>error.Message,_=>"処理を完了できませんでした。保存済みの原本は保持されています。"};
    private void SetStartup()
    {
        using var run=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
        if(startup.Checked)run.SetValue("TCloud.Windows","\""+Environment.ProcessPath+"\" --background");else run.DeleteValue("TCloud.Windows",false);
    }
    private static bool StartupEnabled(){using var run=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");return run?.GetValue("TCloud.Windows") is string;}
    private async Task QuitAsync()
    {
        SetStatus("同期を終了しています。HDDの原本は保持されます。");lifetime.Cancel();
        if(enrollmentTask is not null)await enrollmentTask;
        if(service is not null)try{await service;}catch(Exception){SetStatus("同期を停止しました。HDDの原本は保持されています。");}
        quitting=true;tray.Visible=false;tray.Dispose();lifetime.Dispose();Close();
    }
    internal Task QuitFromRequestAsync()=>QuitAsync();
}

using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using XDownloader.App;
using XDownloader.Core;
using XDownloader.Auth;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        var app=new Application { ShutdownMode=ShutdownMode.OnExplicitShutdown };
        app.Startup+=async (_,_) =>
        {
            var root=Path.Combine(Path.GetTempPath(),"xdownloader-ui-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            MainWindow? window=null;
            try
            {
                foreach (var name in new[]{"yt-dlp.exe","ffmpeg.exe","ffprobe.exe"}) File.WriteAllText(Path.Combine(root,name),"fixture");
                var engine=new UiEngine(); var login=new UiLogin();
                window=new MainWindow(new Downloader(root,engine),login) { ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
                window.Show();
                T Control<T>(string name) where T:FrameworkElement => (T)window.FindName(name);
                var url=Control<TextBox>("UrlInput"); var analyze=Control<Button>("AnalyzeButton");
                var add=Control<Button>("DownloadButton"); var title=Control<TextBox>("TitleInput");
                var videos=Control<ComboBox>("VideoChoice"); var qualities=Control<ComboBox>("QualityChoice");
                var status=Control<TextBlock>("Status"); var cancel=Control<Button>("CancelButton");
                var folder=Control<TextBox>("FolderInput"); folder.Text=Path.Combine(root,"saved");
                var queue=window.QueueForTest;
                void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                async Task Analyze(string input)
                {
                    url.Text=input; Click(analyze); Click(analyze);
                    await Until(()=>analyze.IsEnabled);
                }
                Check(!add.IsEnabled && !title.IsEnabled,"save disabled before analysis");
                await Analyze("https://evil.test/user/status/123");
                Check(engine.Analyses==0 && status.Text.Contains("投稿URL"),"invalid URL never starts engine");
                var beforeLoad=DateTime.Now;
                await Analyze("https://x.com/user/status/123");
                Check(engine.Analyses==1 && videos.Items.Count==2 && qualities.Items.Count>0,"double analysis prevented and media choices populated");
                var suggested=title.Text;
                var date=DateTime.ParseExact(suggested[..14],"yyyyMMddHHmmss",System.Globalization.CultureInfo.InvariantCulture);
                Check(date>=beforeLoad.AddSeconds(-1) && date<=DateTime.Now && suggested.EndsWith("_X動作確認用の動画1（投稿者1）"),"editable title includes local load time and uploader");
                title.Text="動画1の日付なし"; videos.SelectedIndex=1;
                Check(title.Text==suggested[..15]+"X動作確認用の動画2（投稿者2）","videos share the load date");
                title.Text=" \t"; Check(!add.IsEnabled,"empty title disables queue addition");
                title.Text="<>:\"/\\|?*"; Check(!add.IsEnabled,"invalid-only title disables queue addition");
                title.Text="20200101_動画2の編集名"; videos.SelectedIndex=0;
                Check(title.Text=="動画1の日付なし","video switching retains title edits");
                videos.SelectedIndex=1;
                Click(add);
                Check(url.IsEnabled && analyze.IsEnabled && url.Text.Length==0 && !add.IsEnabled,"queue addition frees input for the next URL immediately");
                await Analyze("https://x.com/user/status/456"); title.Text="次のURLの日付なし"; Click(add);
                await Analyze("https://x.com/user/status/789"); title.Text="三本目"; Click(add);
                Check(queue.Snapshot().Count(j=>j.State=="running")==2 && queue.Snapshot()[2].State=="waiting","URL analysis continues while two downloads run and another waits");
                Check(!Control<Button>("LogoutButton").IsEnabled,"queued downloads prevent identity changes");
                queue.Cancel(queue.Snapshot()[0].Id);
                await Until(()=>queue.Snapshot()[2].State=="running");
                engine.ReleaseDownloads(); await queue.WhenIdleAsync().WaitAsync(TimeSpan.FromSeconds(10));
                var items=queue.Snapshot();
                Check(items[0].State=="cancelled" && Path.GetFileName(items[1].SavedPath)=="次のURLの日付なし.mp4" && Path.GetFileName(items[2].SavedPath)=="三本目.mp4","individual cancellation and per-job captured names");
                Check(engine.Maximum==2 && !Directory.EnumerateDirectories(folder.Text).Any(),"parallel limit and staging cleanup");
                await Analyze("https://x.com/user/status/456"); Click(add);
                Check(status.Text.Contains("追加済み") || status.Text.Contains("保存済み"),"same completed video cannot be queued twice");
                url.Text="https://x.com/user/status/999";
                Check(!title.IsEnabled && title.Text.Length==0,"changing URL clears stale title and selection");

                async Task WithEditor(Action<SavePostWindow> edit)
                {
                    var drive=DriveEditor(edit);
                    var save=window.SaveBrowserPostForTest("https://x.com/user/status/999");
                    await Task.WhenAll(save,drive).WaitAsync(TimeSpan.FromSeconds(10));
                }
                await WithEditor(editor =>
                {
                    Check(editor.TitleForTest.Text.EndsWith("_X動作確認用の動画1（投稿者1）"),"browser save opens native title editor with editable date");
                    var editorContent=(FrameworkElement)editor.Content;
                    editorContent.Measure(new Size(620,500)); editorContent.Arrange(new Rect(0,0,620,500)); editorContent.UpdateLayout();
                    Render(editorContent,620,340,"windows-x-downloader-title.png");
                    editor.TitleForTest.Text="ブラウザーから日付なし";
                    editor.VideosForTest.SelectedIndex=1; editor.VideosForTest.SelectedIndex=0;
                    Check(editor.TitleForTest.Text=="ブラウザーから日付なし","browser editor retains per-video edits");
                    editor.TitleForTest.Text=""; Check(!editor.AddForTest.IsEnabled,"browser editor rejects empty title");
                    editor.TitleForTest.Text="ブラウザーから日付なし"; Click(editor.AddForTest);
                });
                await queue.WhenIdleAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Check(Path.GetFileName(queue.Snapshot()[^1].SavedPath)=="ブラウザーから日付なし.mp4","browser and URL flows use the same queue and preserve edited title");
                var count=queue.Snapshot().Count;
                await WithEditor(editor=>editor.Close());
                Check(queue.Snapshot().Count==count,"cancelling browser title confirmation adds nothing");
                var discard=false;
                var q=new Quality("MP4","mp4");
                var dirty=new SavePostWindow("https://x.com/user/status/999",[new VideoInfo("1231","fixture",null,[q])],folder.Text,()=>discard)
                    { Owner=window,ShowActivated=false,Opacity=0 };
                dirty.Show(); dirty.TitleForTest.Text="未保存のタイトル"; dirty.Close();
                Check(dirty.IsVisible && dirty.TitleForTest.Text=="未保存のタイトル","declining discard keeps the title editor and input");
                discard=true; dirty.Close(); Check(!dirty.IsVisible,"approved discard closes only the title editor");
                try { await window.SaveBrowserPostForTest("https://x.com/home"); throw new Exception("timeline accepted"); }
                catch (ArgumentException) { Check(true,"browser submission accepts post details only"); }

                Click(Control<Button>("LoginButton")); await Until(()=>login.Browses==1 && Control<Button>("LoginButton").IsEnabled);
                Check(Control<TextBlock>("LoginStatus").Text.Contains("保存済み") && title.Text.Length==0,"browser login commit refreshes status and invalidates analysis");
                Click(Control<Button>("LogoutButton")); await Until(()=>analyze.IsEnabled);
                Check(login.Logouts==1 && !Control<Button>("LogoutButton").IsEnabled,"logout clears saved identity when idle");

                engine.AnalysisDelay=1000; url.Text="https://x.com/user/status/888"; Click(analyze); Click(cancel);
                await Until(()=>analyze.IsEnabled); Check(status.Text.Contains("キャンセル"),"foreground analysis cancellation restores input");
                engine.AnalysisDelay=30; await Analyze("https://x.com/user/status/888");
                var content=(FrameworkElement)window.Content;
                content.Measure(new Size(820,920)); content.Arrange(new Rect(0,0,820,920)); content.UpdateLayout();
                Render(content,820,(int)content.ActualHeight,"windows-x-downloader-ui.png");
                ((ScrollViewer)content).ScrollToBottom(); content.UpdateLayout();
                Render(content,820,(int)content.ActualHeight,"windows-x-downloader-queue.png");
                engine.HoldDownloads(); Click(add);
                var browserStore=new WindowsLoginStore(Path.Combine(root,"close-browser-auth"));
                var browsing=new XLoginWindow(browserStore,Path.Combine(root,"close-browser-profiles"),offlineFixture:true,onSavePost:window.SaveBrowserPostForTest)
                    { Owner=window,ShowActivated=false,ShowInTaskbar=false,Opacity=0 };
                browsing.Show(); await browsing.WaitForBrowserAsync();
                engine.AnalysisDelay=1000;
                var importing=window.SaveBrowserPostForTest("https://x.com/user/status/1000");
                browsing.Close();
                try { await importing; throw new Exception("closed browser completed import"); }
                catch (InvalidOperationException error) { Check(error.Message.Contains("キャンセル"),"closing the browser cancels only its pending import"); }
                await browsing.CleanupAsync();
                Check(queue.HasUnfinished && queue.Snapshot()[^1].State=="running","closing the browser preserves already queued downloads");
                engine.AnalysisDelay=1000; url.Text="https://x.com/user/status/777"; Click(analyze); window.Close();
                await Until(()=>!window.IsVisible);
                Check(!queue.HasUnfinished && !Directory.EnumerateDirectories(folder.Text).Any(),"close cancels analysis and all downloads before exit");
                await BrowserSmoke.VerifyAsync(root);
                Console.WriteLine("RESULT WPF smoke tests passed"); app.Shutdown(0);
            }
            catch (Exception error) { Console.WriteLine("FAIL WPF: "+error); window?.Close(); app.Shutdown(1); }
            finally { Directory.Delete(root,true); }
        };
        return app.Run();
    }
    private static async Task DriveEditor(Action<SavePostWindow> action)
    {
        SavePostWindow? editor=null;
        await Until(()=> (editor=Application.Current.Windows.OfType<SavePostWindow>().FirstOrDefault()) is not null);
        try { action(editor!); } catch { editor!.Close(); throw; }
    }
    private static void Render(FrameworkElement content,int width,int height,string name)
    {
        var pixels=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32); pixels.Render(content);
        var background=new DrawingVisual();
        using (var drawing=background.RenderOpen())
        { drawing.DrawRectangle(SystemColors.WindowBrush,null,new Rect(0,0,width,height)); drawing.DrawImage(pixels,new Rect(0,0,width,height)); }
        var image=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32); image.Render(background);
        var artifact=Path.Combine(Directory.GetCurrentDirectory(),"tmp",name);
        Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
        using var file=File.Create(artifact); var png=new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(image)); png.Save(file);
        Console.WriteLine("WPF_RENDER "+artifact);
    }
    private static async Task Until(Func<bool> condition)
    {
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition()) await Task.Delay(10,timeout.Token);
    }
    private static void Check(bool result,string label) { if (!result) throw new Exception(label); Console.WriteLine("PASS "+label); }
}

internal sealed class UiLogin : IXLoginService
{
    public LoginState State { get; private set; }=LoginState.Anonymous;
    public int Logouts { get; private set; }
    public int Browses { get; private set; }
    public Task<bool> LoginAsync(Window owner,CancellationToken token) => Task.FromResult(false);
    public Task BrowseAsync(Window owner,Func<string,Task> savePost,Func<bool> canChangeSession,Action saved,CancellationToken token)
    { Browses++; if (canChangeSession()) { State=LoginState.Ready; saved(); } return Task.CompletedTask; }
    public void Logout() { Logouts++; State=LoginState.Anonymous; }
}

internal sealed class UiEngine : IEngineProcess
{
    public int Analyses { get; private set; }
    public int AnalysisDelay { get; set; }=30;
    private TaskCompletionSource released=new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int active;
    public int Maximum { get; private set; }
    public void ReleaseDownloads() => released.TrySetResult();
    public void HoldDownloads() => released=new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async Task<EngineResult> RunAsync(string executable,IReadOnlyList<string> args,string directory,TimeSpan timeout,Action<string>? output,CancellationToken token)
    {
        if (args.Contains("--dump-single-json"))
        {
            Analyses++; await Task.Delay(AnalysisDelay,token);
            return new(0,"""
            {"entries":[
             {"id":"1231","title":"投稿者1 - 動作確認用の動画1","uploader":"投稿者1","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":720}]},
             {"id":"1232","title":"投稿者2 - 動作確認用の動画2","uploader":"投稿者2","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":1080}]}
            ]}
            ""","");
        }
        if (executable.EndsWith("ffprobe.exe")) return new(0,"{\"streams\":[{\"codec_type\":\"video\"}]}","");
        active++; Maximum=Math.Max(Maximum,active);
        try
        {
            await released.Task.WaitAsync(token);
            var path=Path.Combine(directory,"fixture.mp4"); File.WriteAllText(path,"safe fixture");
            output?.Invoke("XD_FILE:"+JsonSerializer.Serialize(path)); return new(0,"","");
        }
        finally { active--; }
    }
}

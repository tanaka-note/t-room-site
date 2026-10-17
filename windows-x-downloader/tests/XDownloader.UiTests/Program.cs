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
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.Startup += async (_, _) =>
        {
            var root = Path.Combine(Path.GetTempPath(), "xdownloader-ui-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            MainWindow? window = null;
            try
            {
                foreach (var name in new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe" }) File.WriteAllText(Path.Combine(root,name), "fixture");
                var engine = new UiEngine();
                var login = new UiLogin();
                window = new MainWindow(new Downloader(root, engine),login) { ShowActivated = false, ShowInTaskbar = false, Opacity = 0 };
                // Real WPF window lifetime/event dispatch; invisible and absent from the taskbar.
                window.Show();
                T Control<T>(string name) where T : FrameworkElement => (T)window.FindName(name);
                var url = Control<TextBox>("UrlInput");
                var analyze = Control<Button>("AnalyzeButton");
                var download = Control<Button>("DownloadButton");
                var cancel = Control<Button>("CancelButton");
                var status = Control<TextBlock>("Status");
                var videos = Control<ComboBox>("VideoChoice");
                var qualities = Control<ComboBox>("QualityChoice");
                var title = Control<TextBox>("TitleInput");
                var loginButton = Control<Button>("LoginButton");
                var logoutButton = Control<Button>("LogoutButton");
                Control<TextBox>("FolderInput").Text = Path.Combine(root, "saved");
                void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                async Task Idle()
                {
                    var deadline = DateTime.UtcNow.AddSeconds(10);
                    while (!analyze.IsEnabled && DateTime.UtcNow < deadline) await Task.Delay(20);
                    Check(analyze.IsEnabled, "UI operation completed");
                }
                Check(!download.IsEnabled, "download disabled before analysis");
                Check(!title.IsEnabled && title.Text.Length==0, "save title disabled before analysis");
                Check(loginButton.IsEnabled && !logoutButton.IsEnabled, "anonymous login controls");
                url.Text = "https://evil.test/user/status/123"; Click(analyze); await Idle();
                Check(status.Text.Contains("投稿URL") && !download.IsEnabled, "invalid URL shown without starting engine");
                Check(engine.Analyses == 0, "invalid input makes no network request");
                url.Text = "https://x.com/user/status/123"; Click(analyze);
                Check(!url.IsEnabled && cancel.IsEnabled, "busy controls locked");
                Check(!loginButton.IsEnabled && !logoutButton.IsEnabled, "credentials cannot change during analysis");
                Click(analyze); await Idle();
                Check(engine.Analyses == 1, "double analysis prevented");
                Check(videos.Items.Count == 2 && qualities.Items.Count > 0 && download.IsEnabled, "multiple videos and qualities selectable");
                Check(title.IsEnabled && title.Text=="X動作確認用の動画1（投稿者1）", "save title suggested with uploader");
                title.Text="X動画1の編集名（投稿者1）";
                videos.SelectedIndex = 1;
                Check(qualities.SelectedIndex == 0, "changing video resets quality");
                Check(title.Text=="X動作確認用の動画2（投稿者2）", "switching video selects its own title");
                title.Text=" \t";
                Check(!download.IsEnabled, "empty edited title disables save");
                title.Text="<>:\"/\\|?*";
                Check(!download.IsEnabled, "invalid-only edited title disables save");
                title.Text="X保存前に編集（投稿者2）";
                videos.SelectedIndex=0;
                Check(title.Text=="X動画1の編集名（投稿者1）", "switching back restores edited title");
                videos.SelectedIndex=1;
                Check(title.Text=="X保存前に編集（投稿者2）" && download.IsEnabled, "per-video edited title is retained");
                var beforeSave=DateTimeOffset.Now;
                Click(download); await Idle();
                Check(status.Text == "保存しました。", "save completion displayed");
                var saved = Control<TextBox>("SavedFile");
                var afterSave=DateTimeOffset.Now;
                var fileName=Path.GetFileName(saved.Text);
                Check(File.Exists(saved.Text) && fileName.EndsWith("_X保存前に編集（投稿者2）.mp4"), "selected video saved with edited title");
                var timestamp=DateTime.ParseExact(fileName[..14],"yyyyMMddHHmmss",System.Globalization.CultureInfo.InvariantCulture);
                Check(timestamp>=beforeSave.LocalDateTime.AddSeconds(-1) && timestamp<=afterSave.LocalDateTime, "saved filename begins with local save time through seconds");
                var content = (FrameworkElement)window.Content;
                content.Measure(new Size(760,740)); content.Arrange(new Rect(0,0,760,740)); content.UpdateLayout();
                var image = new RenderTargetBitmap(760,740,96,96,PixelFormats.Pbgra32); image.Render(content);
                var artifact = Path.Combine(Directory.GetCurrentDirectory(), "tmp", "windows-x-downloader-ui.png");
                Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
                using (var file = File.Create(artifact)) { var png = new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(image)); png.Save(file); }
                Console.WriteLine("WPF_RENDER " + artifact);
                url.Text = "https://x.com/user/status/456";
                Check(!download.IsEnabled && videos.Items.Count == 0 && saved.Visibility == Visibility.Collapsed, "URL change invalidates stale selection");
                Check(title.Text.Length==0 && !title.IsEnabled, "URL change clears edited title");
                engine.Delay = 1000; Click(analyze); Click(cancel); await Idle();
                Check(status.Text.Contains("キャンセル") && !download.IsEnabled, "analysis cancellation restores controls");
                engine.Delay = 50; Click(analyze); await Idle();
                engine.Delay = 1000; Click(download); Click(cancel); await Idle();
                Check(status.Text.Contains("キャンセル") && !Directory.EnumerateDirectories(Control<TextBox>("FolderInput").Text).Any(), "download cancellation cleans staging");
                login.NextResult=false; Click(loginButton); await Idle();
                Check(Control<TextBlock>("LoginStatus").Text=="未ログイン", "cancelled login keeps anonymous state");
                login.NextResult=true; Click(loginButton); await Idle();
                Check(Control<TextBlock>("LoginStatus").Text.Contains("保存済み") && logoutButton.IsEnabled, "login success refreshes status");
                Check(!download.IsEnabled && videos.Items.Count==0 && url.Text.Contains("456"), "login change invalidates analysis while preserving input");
                Check(title.Text.Length==0 && !title.IsEnabled, "login change clears edited title");
                engine.Delay=50; Click(analyze); await Idle();
                engine.Delay=1000; Click(download); Click(logoutButton);
                Check(login.Logouts==0 && !loginButton.IsEnabled && !logoutButton.IsEnabled, "logout cannot race a download");
                Click(cancel); await Idle();
                Click(logoutButton); await Idle();
                Check(login.Logouts==1 && !logoutButton.IsEnabled && !download.IsEnabled && videos.Items.Count==0, "logout clears authentication and prior analysis");
                Click(analyze); window.Close(); await Idle();
                Check(!window.IsVisible, "close during operation cancels then closes");
                await BrowserSmoke.VerifyAsync(root);
                Console.WriteLine("RESULT WPF smoke tests passed");
                app.Shutdown(0);
            }
            catch (Exception e) { Console.WriteLine("FAIL WPF: " + e); window?.Close(); app.Shutdown(1); }
            finally { Directory.Delete(root,true); }
        };
        return app.Run();
    }

    private static void Check(bool value, string label)
    { if (!value) throw new Exception(label); Console.WriteLine("PASS " + label); }
}

internal sealed class UiLogin : IXLoginService
{
    public LoginState State {get;private set;}=LoginState.Anonymous;
    public bool NextResult {get;set;}
    public int Logouts {get;private set;}
    public async Task<bool> LoginAsync(Window owner,CancellationToken token)
    { await Task.Delay(30,token); if (NextResult) State=LoginState.Ready; return NextResult; }
    public void Logout() { Logouts++; State=LoginState.Anonymous; }
}

internal sealed class UiEngine : IEngineProcess
{
    public int Analyses { get; private set; }
    public int Delay { get; set; } = 50;
    public async Task<EngineResult> RunAsync(string executable, IReadOnlyList<string> arguments, string directory, TimeSpan timeout, Action<string>? output, CancellationToken token)
    {
        if (arguments.Contains("--dump-single-json"))
        {
            Analyses++;
            await Task.Delay(Delay,token);
            return new(0, """
            {"entries":[
             {"id":"1231","title":"投稿者1 - 動作確認用の動画1","uploader":"投稿者1","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":720}]},
             {"id":"1232","title":"投稿者2 - 動作確認用の動画2","uploader":"投稿者2","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":1080}]}
            ]}
            """, "");
        }
        if (executable.EndsWith("ffprobe.exe")) return new(0,"{\"streams\":[{\"codec_type\":\"video\"}]}","");
        var path = Path.Combine(directory,"video.mp4"); File.WriteAllText(path,"safe fixture");
        await Task.Delay(Delay,token);
        output?.Invoke("XD_FILE:" + JsonSerializer.Serialize(path));
        return new(0,"","");
    }
}

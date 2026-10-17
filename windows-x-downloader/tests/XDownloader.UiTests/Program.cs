using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using XDownloader.App;
using XDownloader.Core;

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
                window = new MainWindow(new Downloader(root, engine)) { ShowActivated = false, ShowInTaskbar = false, Opacity = 0 };
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
                Control<TextBox>("FolderInput").Text = Path.Combine(root, "saved");
                void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                async Task Idle()
                {
                    var deadline = DateTime.UtcNow.AddSeconds(10);
                    while (!analyze.IsEnabled && DateTime.UtcNow < deadline) await Task.Delay(20);
                    Check(analyze.IsEnabled, "UI operation completed");
                }
                Check(!download.IsEnabled, "download disabled before analysis");
                url.Text = "https://evil.test/user/status/123"; Click(analyze); await Idle();
                Check(status.Text.Contains("投稿URL") && !download.IsEnabled, "invalid URL shown without starting engine");
                Check(engine.Analyses == 0, "invalid input makes no network request");
                url.Text = "https://x.com/user/status/123"; Click(analyze);
                Check(!url.IsEnabled && cancel.IsEnabled, "busy controls locked");
                Click(analyze); await Idle();
                Check(engine.Analyses == 1, "double analysis prevented");
                Check(videos.Items.Count == 2 && qualities.Items.Count > 0 && download.IsEnabled, "multiple videos and qualities selectable");
                videos.SelectedIndex = 1;
                Check(qualities.SelectedIndex == 0, "changing video resets quality");
                Click(download); await Idle();
                Check(status.Text == "保存しました。", "save completion displayed");
                var saved = Control<TextBox>("SavedFile");
                Check(File.Exists(saved.Text) && saved.Text.Contains("1232"), "selected video saved");
                var content = (FrameworkElement)window.Content;
                content.Measure(new Size(760,590)); content.Arrange(new Rect(0,0,760,590)); content.UpdateLayout();
                var image = new RenderTargetBitmap(760,590,96,96,PixelFormats.Pbgra32); image.Render(content);
                var artifact = Path.Combine(Directory.GetCurrentDirectory(), "tmp", "windows-x-downloader-ui.png");
                Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
                using (var file = File.Create(artifact)) { var png = new PngBitmapEncoder(); png.Frames.Add(BitmapFrame.Create(image)); png.Save(file); }
                Console.WriteLine("WPF_RENDER " + artifact);
                url.Text = "https://x.com/user/status/456";
                Check(!download.IsEnabled && videos.Items.Count == 0 && saved.Visibility == Visibility.Collapsed, "URL change invalidates stale selection");
                engine.Delay = 1000; Click(analyze); Click(cancel); await Idle();
                Check(status.Text.Contains("キャンセル") && !download.IsEnabled, "analysis cancellation restores controls");
                engine.Delay = 50; Click(analyze); await Idle();
                engine.Delay = 1000; Click(download); Click(cancel); await Idle();
                Check(status.Text.Contains("キャンセル") && !Directory.EnumerateDirectories(Control<TextBox>("FolderInput").Text).Any(), "download cancellation cleans staging");
                Click(analyze); window.Close(); await Idle();
                Check(!window.IsVisible, "close during operation cancels then closes");
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
             {"id":"1231","title":"動作確認用の動画1","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":720}]},
             {"id":"1232","title":"動作確認用の動画2","formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":1080}]}
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

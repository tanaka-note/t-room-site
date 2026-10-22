using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Collections.ObjectModel;
using Microsoft.Win32;
using XDownloader.Core;
using XDownloader.Auth;

namespace XDownloader.App;

public partial class MainWindow : Window
{
    private readonly Downloader downloader;
    private readonly IXLoginService? loginService;
    private readonly DownloadQueue queue;
    private readonly CancellationTokenSource browserLifetime = new();
    private Task? browserTask;
    private bool browserOpen;
    private bool allowClose;
    private readonly ObservableCollection<QueueRow> queueRows = [];
    private bool queueWasUnfinished;
    private readonly Dictionary<string, string> editedTitles = new();
    private CancellationTokenSource? operation;
    private string? analyzedUrl;
    private bool closingAfterCancel;
    private readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XVideoDownloader", "settings.json");

    public MainWindow() : this(new AppServices()) { }
    private MainWindow(AppServices services) : this(services.Downloader,services.Login) { }

    // Injectable engine permits offline WPF smoke tests with the same event handlers as the app.
    public MainWindow(Downloader service,IXLoginService? login=null)
    {
        downloader = service;
        loginService = login;
        queue = new DownloadQueue(service);
        InitializeComponent();
        MaxHeight=Math.Max(MinHeight,SystemParameters.WorkArea.Height);
        QueueList.ItemsSource=queueRows;
        queue.Changed += QueueChanged;
        FolderInput.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        try
        {
            if (File.Exists(settingsPath))
            {
                var setting = JsonSerializer.Deserialize<Settings>(File.ReadAllText(settingsPath));
                if (setting is not null && Path.IsPathFullyQualified(setting.SaveDirectory) && Directory.Exists(setting.SaveDirectory))
                    FolderInput.Text = setting.SaveDirectory;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { }
        RefreshLogin();
        UrlInput.Focus();
    }

    private void Url_Changed(object sender, TextChangedEventArgs e)
    {
        analyzedUrl = null;
        editedTitles.Clear();
        if (VideoChoice is null) return;
        VideoChoice.ItemsSource = null;
        QualityChoice.ItemsSource = null;
        DownloadButton.IsEnabled = false;
        SavedFile.Visibility = Visibility.Collapsed;
    }

    private void Video_Changed(object sender, SelectionChangedEventArgs e)
    {
        var video = VideoChoice.SelectedItem as VideoInfo;
        QualityChoice.ItemsSource = video?.Qualities;
        QualityChoice.SelectedIndex = QualityChoice.Items.Count > 0 ? 0 : -1;
        TitleInput.Text = video is null ? "" : editedTitles.GetValueOrDefault(video.Id) ?? "";
        SetBusy(operation is not null);
    }

    private void Title_Changed(object sender, TextChangedEventArgs e)
    {
        if (DownloadButton is null) return;
        if (VideoChoice.SelectedItem is VideoInfo video) editedTitles[video.Id] = TitleInput.Text;
        DownloadButton.IsEnabled = operation is null && analyzedUrl is not null && VideoChoice.SelectedItem is VideoInfo
            && QualityChoice.SelectedItem is Quality && SaveFileName.IsUsable(TitleInput.Text);
        SavedFile.Visibility = Visibility.Collapsed;
    }

    private async void Analyze_Click(object sender, RoutedEventArgs e)
    {
        if (operation is not null || closingAfterCancel) return;
        await RunOperationAsync(async token =>
        {
            var url = PostUrl.Normalize(UrlInput.Text);
            analyzedUrl = null;
            editedTitles.Clear();
            VideoChoice.ItemsSource = null;
            Status.Text = "動画情報を解析しています…";
            var videos = await downloader.AnalyzeAsync(url, token);
            var loadedAt = DateTimeOffset.Now;
            foreach (var video in videos) editedTitles[video.Id] = SaveFileName.Suggest(video, loadedAt);
            analyzedUrl = url;
            VideoChoice.ItemsSource = videos;
            VideoChoice.SelectedIndex = 0;
            Status.Text = $"{videos.Count}件の動画が見つかりました。動画・画質を選び、保存タイトルを確認してください。";
        });
    }

    private void Download_Click(object sender, RoutedEventArgs e)
    {
        if (operation is not null || closingAfterCancel || analyzedUrl is null || VideoChoice.SelectedItem is not VideoInfo video
            || QualityChoice.SelectedItem is not Quality quality) return;
        try
        {
            queue.Enqueue(new(analyzedUrl, video, quality, FolderInput.Text, TitleInput.Text));
            ClearAnalysis();
            UrlInput.Text="";
            UrlInput.Focus();
            Status.Text="保存待ちに追加しました。次のURLを読み込めます。";
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        { Status.Text=SafeMessage(error); }
    }

    private async Task RunOperationAsync(Func<CancellationToken, Task> action,bool propagate=false)
    {
        operation = new CancellationTokenSource();
        SetBusy(true);
        SavedFile.Visibility = Visibility.Collapsed;
        Progress.Value = 0;
        Progress.IsIndeterminate = true;
        try { await action(operation.Token); }
        catch (Exception e)
        {
            if (e is DownloadAccessException) queue.Pause();
            Status.Text=SafeMessage(e);
            if (propagate) throw new InvalidOperationException(Status.Text);
        }
        finally
        {
            operation.Dispose();
            operation = null;
            Progress.IsIndeterminate = false;
            RefreshLogin();
        }
    }

    private void SetBusy(bool busy)
    {
        UrlInput.IsEnabled = AnalyzeButton.IsEnabled = VideoChoice.IsEnabled = QualityChoice.IsEnabled = FolderButton.IsEnabled = !busy && !closingAfterCancel;
        CancelButton.IsEnabled = busy;
        TitleInput.IsEnabled = !busy && !closingAfterCancel && analyzedUrl is not null && VideoChoice.SelectedItem is VideoInfo;
        DownloadButton.IsEnabled = !busy && !closingAfterCancel && analyzedUrl is not null && VideoChoice.SelectedItem is VideoInfo && QualityChoice.SelectedItem is Quality && SaveFileName.IsUsable(TitleInput.Text);
        LoginButton.IsEnabled = !busy && !browserOpen && !closingAfterCancel && loginService is not null;
        LogoutButton.IsEnabled = !busy && !browserOpen && !queue.HasUnfinished && loginService is not null && loginService.State != LoginState.Anonymous;
    }

    private void RefreshLogin()
    {
        var state=loginService?.State ?? LoginState.Anonymous;
        LoginStatus.Text=state switch
        {
            LoginState.Ready => "Xログイン保存済み",
            LoginState.Expired => "Xへの再ログインが必要",
            LoginState.Unreadable => "Xログイン情報を確認できません",
            _ => "未ログイン"
        };
        LoginButton.Content="Xを開く";
        SetBusy(operation is not null);
    }

    private void ClearAnalysis()
    {
        analyzedUrl=null;
        editedTitles.Clear();
        VideoChoice.ItemsSource=null;
        QualityChoice.ItemsSource=null;
        DownloadButton.IsEnabled=false;
        SavedFile.Visibility=Visibility.Collapsed;
    }

    private async void Login_Click(object sender,RoutedEventArgs e)
    {
        if (operation is not null || loginService is null || browserOpen || closingAfterCancel) return;
        browserOpen=true; RefreshLogin();
        try
        {
            browserTask=loginService.BrowseAsync(this,SaveBrowserPostAsync,()=>operation is null && !queue.HasUnfinished,
                ()=> { ClearAnalysis(); RefreshLogin(); },browserLifetime.Token);
            await browserTask;
        }
        catch (Exception error) { Status.Text=SafeMessage(error); }
        finally { browserOpen=false; RefreshLogin(); }
    }

    private async Task SaveBrowserPostAsync(string url)
    {
        if (operation is not null || closingAfterCancel) throw new InvalidOperationException("解析中です。完了してから保存を押してください。");
        url=PostUrl.Normalize(url);
        await RunOperationAsync(async token=>
        {
            using var linked=CancellationTokenSource.CreateLinkedTokenSource(token,browserLifetime.Token);
            var browserOwner=OwnedWindows.OfType<XLoginWindow>().FirstOrDefault();
            void BrowserClosed(object? sender,EventArgs args) => linked.Cancel();
            if (browserOwner is not null) browserOwner.Closed+=BrowserClosed;
            try
            {
                Status.Text="投稿の動画情報を読み込んでいます…";
                var media=await downloader.AnalyzeAsync(url,linked.Token);
                linked.Token.ThrowIfCancellationRequested();
                var editor=new SavePostWindow(url,media,FolderInput.Text) { Owner=browserOwner as Window ?? this,Opacity=Opacity,ShowActivated=Opacity!=0 };
                using var cancelled=linked.Token.Register(()=>Dispatcher.BeginInvoke(()=> { if (editor.IsVisible) editor.Close(); }));
                if (editor.ShowDialog()==true && editor.Request is { } request)
                {
                    linked.Token.ThrowIfCancellationRequested();
                    queue.Enqueue(request);
                    Status.Text="保存待ちに追加しました。Xの閲覧を続けられます。";
                }
            }
            finally { if (browserOwner is not null) browserOwner.Closed-=BrowserClosed; }
        },propagate:true);
    }

    private async void Logout_Click(object sender,RoutedEventArgs e)
    {
        if (operation is not null || loginService is null || browserOpen || queue.HasUnfinished) return;
        await RunOperationAsync(_ =>
        {
            loginService.Logout();
            ClearAnalysis();
            RefreshLogin();
            Status.Text="アプリに保存したXのログイン情報を消去しました。";
            return Task.CompletedTask;
        });
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => Cancel();
    private void Cancel()
    {
        if (operation is null) return;
        Status.Text = "キャンセルしています…";
        CancelButton.IsEnabled = false;
        operation.Cancel();
    }

    private async void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (allowClose) return;
        e.Cancel = true;
        if (closingAfterCancel) return;
        if (Application.Current.Windows.OfType<SavePostWindow>().Any(editor=>!editor.ApproveClose())) return;
        closingAfterCancel = true;
        SetBusy(operation is not null);
        Cancel();
        browserLifetime.Cancel();
        await queue.StopAsync();
        while (operation is not null) await Task.Delay(20);
        if (browserTask is not null) { try { await browserTask; } catch (Exception) { } }
        queue.Changed-=QueueChanged;
        await System.Windows.Threading.Dispatcher.Yield();
        allowClose=true; Close();
    }

    private void Window_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Escape || operation is null) return;
        Cancel();
        e.Handled = true;
    }

    private void Folder_Click(object sender, RoutedEventArgs e)
    {
        var picker = new OpenFolderDialog { Title = "動画の保存先", InitialDirectory = FolderInput.Text, Multiselect = false };
        if (picker.ShowDialog(this) != true) return;
        FolderInput.Text = picker.FolderName;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
            File.WriteAllText(settingsPath, JsonSerializer.Serialize(new Settings(picker.FolderName)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { Status.Text = "保存先を変更しました。設定を記録できないため、次回起動時には元に戻ります。"; }
    }

    private void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(FolderInput.Text);
            var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
            start.ArgumentList.Add(FolderInput.Text);
            Process.Start(start)?.Dispose();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        { Status.Text = "保存先を開けませんでした。フォルダーの場所を確認してください。"; }
    }

    private void QueueChanged()
    {
        if (!Dispatcher.CheckAccess()) { _=Dispatcher.InvokeAsync(QueueChanged); return; }
        var items=queue.Snapshot();
        foreach (var item in items)
        {
            var row=queueRows.FirstOrDefault(existing=>existing.Id==item.Id);
            if (row is null) queueRows.Add(new QueueRow(item)); else row.Update(item);
        }
        var running=items.Count(j=>j.State=="running"); var waiting=items.Count(j=>j.State=="waiting");
        QueueSummary.Text=$"取得中 {running}件 ／ 待ち {waiting}件"+(queue.IsPaused ? "（新しい取得を停止中）" : "（最大2件同時）");
        CancelAllButton.IsEnabled=queue.HasUnfinished;
        ResumeQueueButton.Visibility=queue.IsPaused ? Visibility.Visible : Visibility.Collapsed;
        if (queueWasUnfinished!=queue.HasUnfinished) { queueWasUnfinished=queue.HasUnfinished; RefreshLogin(); }
    }
    private void CancelJob_Click(object sender,RoutedEventArgs e) { if (sender is Button { Tag: Guid id }) queue.Cancel(id); }
    private void CancelAll_Click(object sender,RoutedEventArgs e) { foreach (var job in queue.Snapshot()) if (job.CanCancel) queue.Cancel(job.Id); }
    private void ResumeQueue_Click(object sender,RoutedEventArgs e) => queue.Resume();
    private static string SafeMessage(Exception e) => e is OperationCanceledException ? "キャンセルしました。"
        : e is ArgumentException or InvalidOperationException or FileNotFoundException or TimeoutException ? e.Message
        : e is IOException or UnauthorizedAccessException ? "ファイルの保存に失敗しました。空き容量・保存先の権限を確認してください。"
        : "処理を完了できませんでした。アプリを再起動して試してください。";
    internal DownloadQueue QueueForTest => queue;
    internal Task SaveBrowserPostForTest(string url) => SaveBrowserPostAsync(url);

    private sealed class QueueRow(QueuedDownload value) : INotifyPropertyChanged
    {
        private QueuedDownload current=value;
        public Guid Id => current.Id;
        public string Title => current.Title;
        public string Message => current.Message;
        public double? Percent => current.Percent;
        public string? SavedPath => current.SavedPath;
        public bool CanCancel => current.CanCancel;
        public event PropertyChangedEventHandler? PropertyChanged;
        public void Update(QueuedDownload next)
        {
            if (current==next) return;
            current=next; PropertyChanged?.Invoke(this,new PropertyChangedEventArgs(null));
        }
    }

    private sealed record Settings(string SaveDirectory);
}

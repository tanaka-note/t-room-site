using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Win32;
using XDownloader.Core;

namespace XDownloader.App;

public partial class MainWindow : Window
{
    private readonly Downloader downloader;
    private CancellationTokenSource? operation;
    private string? analyzedUrl;
    private bool closingAfterCancel;
    private readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XVideoDownloader", "settings.json");

    public MainWindow() : this(new Downloader(Path.Combine(AppContext.BaseDirectory, "tools"))) { }

    // Injectable engine permits offline WPF smoke tests with the same event handlers as the app.
    public MainWindow(Downloader service)
    {
        downloader = service;
        InitializeComponent();
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
        UrlInput.Focus();
    }

    private void Url_Changed(object sender, TextChangedEventArgs e)
    {
        analyzedUrl = null;
        if (VideoChoice is null) return;
        VideoChoice.ItemsSource = null;
        QualityChoice.ItemsSource = null;
        DownloadButton.IsEnabled = false;
        SavedFile.Visibility = Visibility.Collapsed;
    }

    private void Video_Changed(object sender, SelectionChangedEventArgs e)
    {
        QualityChoice.ItemsSource = (VideoChoice.SelectedItem as VideoInfo)?.Qualities;
        QualityChoice.SelectedIndex = QualityChoice.Items.Count > 0 ? 0 : -1;
        DownloadButton.IsEnabled = operation is null && analyzedUrl is not null && QualityChoice.SelectedItem is Quality;
    }

    private async void Analyze_Click(object sender, RoutedEventArgs e)
    {
        if (operation is not null) return;
        await RunOperationAsync(async token =>
        {
            var url = PostUrl.Normalize(UrlInput.Text);
            analyzedUrl = null;
            VideoChoice.ItemsSource = null;
            Status.Text = "動画情報を解析しています…";
            var videos = await downloader.AnalyzeAsync(url, token);
            analyzedUrl = url;
            VideoChoice.ItemsSource = videos;
            VideoChoice.SelectedIndex = 0;
            Status.Text = $"{videos.Count}件の動画が見つかりました。動画と画質を選んで保存できます。";
        });
    }

    private async void Download_Click(object sender, RoutedEventArgs e)
    {
        if (operation is not null || analyzedUrl is null || VideoChoice.SelectedItem is not VideoInfo video
            || QualityChoice.SelectedItem is not Quality quality) return;
        var url = analyzedUrl;
        await RunOperationAsync(async token =>
        {
            Status.Text = "ダウンロードを準備しています…";
            var progress = new Progress<DownloadProgress>(value =>
            {
                if (operation is null || operation.IsCancellationRequested) return;
                Progress.IsIndeterminate = value.Percent is null;
                Progress.Value = value.Percent ?? 0;
                Status.Text = value.Message;
            });
            var saved = await downloader.DownloadAsync(url, video, quality, FolderInput.Text, progress, token);
            Progress.Value = 100;
            Status.Text = "保存しました。";
            SavedFile.Text = saved;
            SavedFile.Visibility = Visibility.Visible;
        });
    }

    private async Task RunOperationAsync(Func<CancellationToken, Task> action)
    {
        operation = new CancellationTokenSource();
        SetBusy(true);
        SavedFile.Visibility = Visibility.Collapsed;
        Progress.Value = 0;
        Progress.IsIndeterminate = true;
        try { await action(operation.Token); }
        catch (OperationCanceledException) { Status.Text = "キャンセルしました。"; }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or FileNotFoundException or TimeoutException)
        { Status.Text = e.Message; }
        catch (UnauthorizedAccessException) { Status.Text = "保存先への書き込みが許可されていません。保存先を変更してください。"; }
        catch (IOException) { Status.Text = "ファイルの保存に失敗しました。空き容量・保存先・ファイルの使用状況を確認してください。"; }
        catch (Exception) { Status.Text = "処理を完了できませんでした。アプリの再起動、またはエンジンの再準備を試してください。"; }
        finally
        {
            operation.Dispose();
            operation = null;
            Progress.IsIndeterminate = false;
            SetBusy(false);
            if (closingAfterCancel) Close();
        }
    }

    private void SetBusy(bool busy)
    {
        UrlInput.IsEnabled = AnalyzeButton.IsEnabled = VideoChoice.IsEnabled = QualityChoice.IsEnabled = FolderButton.IsEnabled = !busy;
        CancelButton.IsEnabled = busy;
        DownloadButton.IsEnabled = !busy && analyzedUrl is not null && VideoChoice.SelectedItem is VideoInfo && QualityChoice.SelectedItem is Quality;
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => Cancel();
    private void Cancel()
    {
        if (operation is null) return;
        Status.Text = "キャンセルしています…";
        CancelButton.IsEnabled = false;
        operation.Cancel();
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (operation is null) return;
        e.Cancel = true;
        closingAfterCancel = true;
        Cancel();
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

    private sealed record Settings(string SaveDirectory);
}

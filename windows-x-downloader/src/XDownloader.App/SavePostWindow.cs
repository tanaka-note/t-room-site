using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.ComponentModel;
using XDownloader.Core;

namespace XDownloader.App;

// Native confirmation editor; no page script, DOM inspection or browser-to-host bridge.
internal sealed class SavePostWindow : Window
{
    private readonly ComboBox videos = new() { Margin = new Thickness(0, 4, 0, 12) };
    private readonly ComboBox qualities = new() { Margin = new Thickness(0, 4, 0, 12) };
    private readonly TextBox title = new() { MaxLength = SaveFileName.MaxTitleLength, Padding = new Thickness(7), Margin = new Thickness(0, 4, 0, 4) };
    private readonly Button add = new() { Content = "保存待ちに追加", Padding = new Thickness(16, 8, 16, 8), IsDefault = true };
    private readonly Dictionary<string, string> titles = new();
    private readonly Dictionary<string, string> originalTitles = new();
    private readonly Func<bool> confirmDiscard;
    private bool discardApproved;
    public DownloadRequest? Request { get; private set; }

    internal SavePostWindow(string url, IReadOnlyList<VideoInfo> media, string destination,Func<bool>? discardConfirmation=null)
    {
        confirmDiscard=discardConfirmation ?? (()=>MessageBox.Show(this,"編集したタイトルを破棄して閉じますか？","タイトルの編集",MessageBoxButton.YesNo,MessageBoxImage.Question,MessageBoxResult.No)==MessageBoxResult.Yes);
        Title = "保存する動画とタイトル"; Width = 620; SizeToContent = SizeToContent.Height;
        ShowInTaskbar=false;
        ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        FontFamily = new System.Windows.Media.FontFamily("Yu Gothic UI"); FontSize = 14;
        var loadedAt = DateTimeOffset.Now;
        foreach (var video in media) originalTitles[video.Id] = titles[video.Id] = SaveFileName.Suggest(video, loadedAt);
        var panel = new StackPanel { Margin = new Thickness(20) };
        panel.Children.Add(new TextBlock { Text = "保存する動画" }); panel.Children.Add(videos);
        panel.Children.Add(new TextBlock { Text = "画質" }); panel.Children.Add(qualities);
        panel.Children.Add(new TextBlock { Text = "保存タイトル" }); panel.Children.Add(title);
        panel.Children.Add(new TextBlock { Text = "日付も自由に変更・削除できます。", FontSize = 12 });
        panel.Children.Add(new TextBlock { Text = "保存先：" + destination, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 12) });
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "キャンセル", IsCancel = true, Padding = new Thickness(16, 8, 16, 8), Margin = new Thickness(8, 0, 0, 0) };
        buttons.Children.Add(add); buttons.Children.Add(cancel); panel.Children.Add(buttons); Content = panel;
        videos.SelectionChanged += (_, _) =>
        {
            if (videos.SelectedItem is not VideoInfo video) return;
            qualities.ItemsSource = video.Qualities; qualities.SelectedIndex = 0; title.Text = titles[video.Id]; UpdateAdd();
        };
        title.TextChanged += (_, _) => { if (videos.SelectedItem is VideoInfo video) titles[video.Id] = title.Text; UpdateAdd(); };
        add.Click += (_, _) =>
        {
            if (!add.IsEnabled || videos.SelectedItem is not VideoInfo video || qualities.SelectedItem is not Quality quality) return;
            Request = new(url, video, quality, Path.GetFullPath(destination), title.Text); DialogResult = true;
        };
        videos.ItemsSource = media; videos.SelectedIndex = 0;
        Closing+=ConfirmClosing;
    }

    internal bool ApproveClose()
    {
        if (Request is not null || discardApproved || titles.All(pair=>originalTitles[pair.Key]==pair.Value)) return true;
        discardApproved=confirmDiscard(); return discardApproved;
    }
    private void ConfirmClosing(object? sender,CancelEventArgs e) { if (!ApproveClose()) e.Cancel=true; }

    private void UpdateAdd() => add.IsEnabled = videos.SelectedItem is VideoInfo && qualities.SelectedItem is Quality && SaveFileName.IsUsable(title.Text);
    internal TextBox TitleForTest => title;
    internal ComboBox VideosForTest => videos;
    internal Button AddForTest => add;
}

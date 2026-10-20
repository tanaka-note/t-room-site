using System.Globalization;
using System.Text.Json;

namespace XDownloader.Core;

public sealed record DownloadProgress(double? Percent, string Message);

public sealed class Downloader(string toolsDirectory, IEngineProcess? runner = null, ICookieSource? cookies = null, TimeProvider? timeProvider = null)
{
    private readonly IEngineProcess process = runner ?? new EngineProcess();
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private string Engine => Path.Combine(toolsDirectory, "yt-dlp.exe");

    public void CheckTools()
    {
        foreach (var file in new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe" })
            if (!File.Exists(Path.Combine(toolsDirectory, file)))
                throw new FileNotFoundException("動画エンジンが未準備です。READMEに従って Prepare-Tools.ps1 を実行し、アプリを再起動してください。");
    }

    private List<string> CommonArguments(ICookieLease? login)
    {
        List<string> arguments = [
        "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-cookies-from-browser",
        "--no-update", "--encoding", "utf-8", "--no-colors", "--socket-timeout", "20",
        "--retries", "2", "--fragment-retries", "2", "--extractor-retries", "1", "--no-warnings",
        "--proxy", "", "--use-extractors", "twitter,twitter:amplify,twitter:card", "--ffmpeg-location", toolsDirectory
        ];
        if (login is not null) arguments.AddRange(["--cookies", login.FilePath]);
        return arguments;
    }

    public async Task<IReadOnlyList<VideoInfo>> AnalyzeAsync(string input, CancellationToken cancellationToken)
    {
        var url = PostUrl.Normalize(input);
        CheckTools();
        using var login = cookies?.Acquire();
        var arguments = CommonArguments(login);
        arguments.AddRange(["--dump-single-json", "--skip-download", "--yes-playlist", "--no-progress", "--", url]);
        var result = await process.RunAsync(Engine, arguments, toolsDirectory, TimeSpan.FromSeconds(120), null, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        EnsureSuccess(result, login is not null);
        return MediaInfo.Parse(result.Output);
    }

    public async Task<string> DownloadAsync(string input, VideoInfo video, Quality quality, string destination,
        IProgress<DownloadProgress>? progress, CancellationToken cancellationToken, string? saveTitle = null)
    {
        var url = PostUrl.Normalize(input);
        if (!video.Qualities.Contains(quality)) throw new ArgumentException("解析結果から画質を選択してください。");
        // Preserve the complete edited title, including any edited or removed date, before the first await.
        var stem = SaveFileName.Stem(saveTitle ?? SaveFileName.Suggest(video, clock.GetLocalNow()));
        CheckTools();
        using var login = cookies?.Acquire();
        var root = Path.GetFullPath(destination);
        Directory.CreateDirectory(root);
        var staging = Path.Combine(root, $".xdownloader-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        try
        {
            var arguments = CommonArguments(login);
            arguments.AddRange([
                "--yes-playlist", "--match-filters", $"id ~= ^{video.Id}$", "--format", quality.Selector,
                "--merge-output-format", "mp4", "--remux-video", "mp4", "--windows-filenames", "--no-overwrites",
                "--no-write-info-json", "--no-write-thumbnail", "--no-write-subs", "--no-write-auto-subs",
                "--newline", "--progress", "--progress-delta", "0.3", "--no-simulate",
                "--progress-template", "download:XD_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
                "--print", "after_move:XD_FILE:%(filepath)j", "--output", Path.Combine(staging, "%(id)s.%(ext)s"),
                "--", url
            ]);
            string? completed = null;
            var result = await process.RunAsync(Engine, arguments, staging, TimeSpan.FromMinutes(30), line =>
            {
                if (line.StartsWith("XD_PROGRESS:", StringComparison.Ordinal)) progress?.Report(ParseProgress(line));
                if (line.StartsWith("XD_FILE:", StringComparison.Ordinal))
                    completed = JsonSerializer.Deserialize<string>(line[8..]);
            }, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            EnsureSuccess(result, login is not null);
            if (completed is null) throw new InvalidOperationException("対象の動画が見つかりません。投稿を再解析してください。");
            var source = Path.GetFullPath(completed);
            var relative = Path.GetRelativePath(staging, source);
            if (Path.IsPathRooted(relative) || relative.StartsWith("..", StringComparison.Ordinal)
                || !string.Equals(Path.GetExtension(source), ".mp4", StringComparison.OrdinalIgnoreCase)
                || !File.Exists(source) || new FileInfo(source).Length == 0)
                throw new InvalidOperationException("保存結果を確認できませんでした。");
            await ValidateMediaAsync(source, staging, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            // Move within the chosen volume; never overwrite another download, even across app instances.
            for (var number = 0; number < 10000; number++)
            {
                var target = Path.Combine(root, stem + (number == 0 ? "" : $" ({number})") + ".mp4");
                try { File.Move(source, target, overwrite: false); return target; }
                catch (IOException) when (File.Exists(target)) { }
            }
            throw new IOException("同名のファイルが多すぎます。保存先を変更してください。");
        }
        finally
        {
            try { Directory.Delete(staging, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private async Task ValidateMediaAsync(string file, string directory, CancellationToken token)
    {
        var result = await process.RunAsync(Path.Combine(toolsDirectory, "ffprobe.exe"),
            ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_type:format=format_name,duration", "-of", "json", file],
            directory, TimeSpan.FromSeconds(30), null, token);
        if (result.ExitCode != 0) throw new InvalidOperationException("取得した動画が破損しているか、形式を確認できませんでした。");
        using var json = JsonDocument.Parse(result.Output);
        if (!json.RootElement.TryGetProperty("streams", out var streams)
            || !streams.EnumerateArray().Any(s => s.TryGetProperty("codec_type", out var type) && type.GetString() == "video"))
            throw new InvalidOperationException("取得したファイルに映像がありません。");
    }

    public static DownloadProgress ParseProgress(string line)
    {
        var parts = line["XD_PROGRESS:".Length..].Split('|');
        double? percent = double.TryParse(parts[0].Trim().TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
            && double.IsFinite(n) ? Math.Clamp(n, 0, 100) : null;
        return new(percent, percent >= 100 ? "動画を結合・検証しています…"
            : $"ダウンロード中 {parts[0].Trim()}  {(parts.Length > 1 ? parts[1].Trim() : "")}  残り {(parts.Length > 2 ? parts[2].Trim() : "不明")}");
    }

    private static void EnsureSuccess(EngineResult result, bool loggedIn)
    {
        if (result.ExitCode == 0) return;
        var error = result.Error.ToLowerInvariant();
        // Keep raw engine messages (which may contain CDN URLs and queries) out of UI/logs.
        var message = error.Contains("no such option") ? "動画エンジンのバージョンがアプリと一致しません。付属の手順でエンジンを再準備してください。"
            : error.Contains("no suitable extractor") || error.Contains("unsupported url") ? "この投稿の動画形式には対応していません。Xに直接投稿された通常の動画で試してください。"
            : error.Contains("429") || error.Contains("rate limit") ? "X側のアクセス制限に達しました。時間をおいて再試行してください。"
            : error.Contains("login") || error.Contains("protected") || error.Contains("authentication") || error.Contains("sensitive") || error.Contains("nsfw")
                ? loggedIn ? "Xのログインが失効したか、このアカウントに閲覧権限がありません。Xへ再ログインし、ブラウザーでも閲覧できる投稿か確認してください。"
                    : "ログインが必要、または閲覧が制限された投稿です。「Xにログイン」から、ご本人が閲覧できるアカウントでログインしてください。"
            : error.Contains("no video could be found") ? loggedIn
                ? "ログイン状態でも動画情報が見つかりません。動画のない投稿、削除済み、閲覧権限の不足などが考えられます。Xへの再ログインも確認してください。"
                : "この投稿から動画情報を取得できません。動画のない投稿、削除済み、閲覧制限などが考えられます。ブラウザーで再生できる場合は「Xにログイン」を試してください。"
            : error.Contains("format") ? "選択した画質で保存できません。再解析し、別の画質を選んでください。"
            : error.Contains("404") || error.Contains("unavailable") || error.Contains("not found") || error.Contains("deleted")
                ? "投稿が削除済み、または現在取得できません。ブラウザで投稿を確認してください。"
            : error.Contains("403") || error.Contains("forbidden") ? "X側から取得を拒否されました。時間をおくか、エンジン更新を確認してください。"
            : "取得に失敗しました。通信状況・投稿の公開状態を確認してください。Xの仕様変更でエンジン更新が必要な場合もあります。";
        throw new InvalidOperationException(message);
    }
}

using System.Diagnostics;

namespace Tlain.Downloader2.Core;

public sealed class ExternalToolRunner(ToolLocator tools)
{
    public async Task<string> DownloadStreamAsync(MediaRequest request, string workDirectory, string saveName, CancellationToken cancellationToken)
    {
        var binary = tools.Find("N_m3u8DL-RE") ?? throw new DownloaderException("engine_unavailable", "DASHまたは高度なHLSにはN_m3u8DL-REをtools directoryへ配置してください。");
        Directory.CreateDirectory(workDirectory);
        var start = Base(binary);
        start.ArgumentList.Add(request.Url);
        Add(start, "--tmp-dir", Path.Combine(workDirectory, "segments"));
        Add(start, "--save-dir", workDirectory);
        Add(start, "--save-name", saveName);
        start.ArgumentList.Add("--auto-select");
        start.ArgumentList.Add("--del-after-done");
        start.ArgumentList.Add("--no-log");
        start.ArgumentList.Add("--disable-update-check");
        start.ArgumentList.Add("--log-level"); start.ArgumentList.Add("WARN");
        foreach (var header in HeaderPolicy.ForExternalTool(request.Headers)) { start.ArgumentList.Add("-H"); start.ArgumentList.Add($"{Canonical(header.Key)}: {header.Value}"); }
        await RunAsync(start, cancellationToken).ConfigureAwait(false);
        return Directory.EnumerateFiles(workDirectory, $"{saveName}*", SearchOption.TopDirectoryOnly)
            .Where(path => !path.EndsWith(".log", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault()
            ?? throw new DownloaderException("engine_output_missing", "N_m3u8DL-REの完成ファイルを確認できませんでした。");
    }

    public async Task<string> DownloadWithYtDlpAsync(MediaRequest request, string workDirectory, string saveName, CancellationToken cancellationToken)
    {
        var binary = tools.Find("yt-dlp") ?? throw new DownloaderException("engine_unavailable", "yt-dlpをtools directoryへ配置してください。");
        Directory.CreateDirectory(workDirectory);
        var template = Path.Combine(workDirectory, $"{saveName}.%(ext)s");
        var start = Base(binary);
        start.ArgumentList.Add("--no-playlist"); start.ArgumentList.Add("--no-write-info-json"); start.ArgumentList.Add("--no-write-comments");
        start.ArgumentList.Add("--no-write-thumbnail"); start.ArgumentList.Add("--no-cookies-from-browser");
        Add(start, "--output", template);
        foreach (var header in HeaderPolicy.ForExternalTool(request.Headers)) { Add(start, "--add-header", $"{Canonical(header.Key)}:{header.Value}"); }
        start.ArgumentList.Add(request.Url);
        await RunAsync(start, cancellationToken).ConfigureAwait(false);
        return Directory.EnumerateFiles(workDirectory, $"{saveName}.*", SearchOption.TopDirectoryOnly).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault()
            ?? throw new DownloaderException("engine_output_missing", "yt-dlpの完成ファイルを確認できませんでした。");
    }

    private static ProcessStartInfo Base(string binary) => new(binary) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
    private static void Add(ProcessStartInfo start, string name, string value) { start.ArgumentList.Add(name); start.ArgumentList.Add(value); }
    private static string Canonical(string name) => name switch { "user-agent" => "User-Agent", "referer" => "Referer", "origin" => "Origin", "cookie" => "Cookie", "authorization" => "Authorization", _ => name };

    private static async Task RunAsync(ProcessStartInfo start, CancellationToken cancellationToken)
    {
        using var process = Process.Start(start) ?? throw new DownloaderException("engine_start_failed", "外部engineを起動できませんでした。");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        try { await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            try { await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false); } catch { }
            throw;
        }
        _ = await stdout.ConfigureAwait(false);
        _ = await stderr.ConfigureAwait(false); // Never persisted or returned: it may contain signed URLs.
        if (process.ExitCode != 0) throw new DownloaderException("engine_failed", "外部engineでメディアを取得できませんでした。");
    }
}

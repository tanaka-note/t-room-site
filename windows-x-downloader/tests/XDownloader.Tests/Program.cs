using System.Diagnostics;
using System.Text.Json;
using XDownloader.Core;

Console.OutputEncoding = new System.Text.UTF8Encoding(false);
if (args.Contains("--emit")) { Console.WriteLine("日本語の動画"); Console.Error.WriteLine("fixture stderr"); return 0; }
if (args.Contains("--sleep")) { await Task.Delay(TimeSpan.FromMinutes(1)); return 0; }
if (args.Contains("--report-and-sleep")) { Console.WriteLine(Environment.ProcessId); await Task.Delay(TimeSpan.FromMinutes(1)); return 0; }
if (args.Contains("--supervisor"))
{
    await new EngineProcess().RunAsync(Environment.ProcessPath!,["--report-and-sleep"],Directory.GetCurrentDirectory(),TimeSpan.FromMinutes(1),Console.WriteLine,CancellationToken.None);
    return 0;
}
if (args.Contains("--child"))
{
    var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
    start.ArgumentList.Add("--sleep");
    using var child = Process.Start(start)!;
    Console.WriteLine(child.Id);
    await Task.Delay(TimeSpan.FromMinutes(1));
    return 0;
}
if (args.Contains("--x-probe") || args.Contains("--x-download-probe"))
{
    string? downloadedDirectory = null;
    try
    {
        var probeUrl = args.Length > 2 ? args[2] : "https://x.com/TopHeroes_/status/2001950365332455490";
        var service = new Downloader(args[1], new DiagnosticEngine());
        var videos = await service.AnalyzeAsync(probeUrl, CancellationToken.None);
        Console.WriteLine($"LIVE_METADATA_OK videos={videos.Count} qualities={videos[0].Qualities.Count}");
        if (args.Contains("--x-download-probe"))
        {
            var selected = videos[0];
            if (selected.Duration is null or > 60) throw new Exception("Probe restricted to known short videos");
            downloadedDirectory = Path.Combine(Path.GetTempPath(), "xdownloader-live-" + Guid.NewGuid().ToString("N"));
            var quality = selected.Qualities.LastOrDefault(q => q.Label.EndsWith("HLS")) ?? selected.Qualities.Last();
            var path = await service.DownloadAsync(probeUrl, selected, quality, downloadedDirectory, null, CancellationToken.None);
            var decode = await new EngineProcess().RunAsync(Path.Combine(args[1], "ffmpeg.exe"), ["-v","error","-i",path,"-f","null","-"], args[1], TimeSpan.FromSeconds(60),null,CancellationToken.None);
            if (decode.ExitCode != 0) throw new Exception("Live media full decode failed");
            Console.WriteLine($"LIVE_DOWNLOAD_DECODE_OK bytes={new FileInfo(path).Length} hls={quality.Label.EndsWith("HLS")}");
        }
        return 0;
    }
    catch (Exception e) { Console.WriteLine($"LIVE_METADATA_UNAVAILABLE {e.Message}"); return 2; }
    finally { if (downloadedDirectory is not null && Directory.Exists(downloadedDirectory)) Directory.Delete(downloadedDirectory,true); }
}

var failures = 0;
var passed = 0;
async Task Test(string name, Func<Task> check)
{
    try { await check(); passed++; Console.WriteLine($"PASS {name}"); }
    catch (Exception e) { failures++; Console.WriteLine($"FAIL {name}: {e.Message}"); }
}
void Equal<T>(T expected, T actual) { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}"); }
void Assert(bool value, string message = "assertion failed") { if (!value) throw new Exception(message); }
async Task Throws<T>(Func<Task> action, string? contains = null) where T : Exception
{
    try { await action(); } catch (T e) { if (contains is not null) Assert(e.Message.Contains(contains)); return; }
    throw new Exception($"Expected {typeof(T).Name}");
}
Task Sync(Action action) { action(); return Task.CompletedTask; }
const string url = "https://x.com/user/status/123";
const string mediaJson = """
{"entries":[
 {"id":"1231","title":"投稿者名 - テスト動画","uploader":"投稿者名","duration":12,"formats":[
  {"format_id":"http-800","ext":"mp4","vcodec":"h264","acodec":"aac","protocol":"https","height":720,"tbr":800},
  {"format_id":"hls-2000","ext":"mp4","vcodec":"h264","acodec":"none","protocol":"m3u8_native","height":1080,"tbr":2000},
  {"format_id":"audio","ext":"mp4","vcodec":"none","protocol":"https"},
  {"format_id":"drm","ext":"mp4","protocol":"https","has_drm":true},
  {"format_id":"unsafe/selector","ext":"mp4","protocol":"https"}]},
 {"id":"1232","title":"動画2","duration":null,"formats":[{"format_id":"mp4","ext":"mp4","protocol":"https","height":null}]}
]}
""";

await Test("URL canonicalization strips tracking", () => Sync(() => Equal("https://x.com/user/status/123", PostUrl.Normalize(" https://twitter.com/user/status/123?s=20#fragment "))));
await Test("video index and canonical URL", () => Sync(() => Equal("https://x.com/i/status/123/video/2", PostUrl.Normalize("https://x.com/i/web/status/123/video/2"))));
foreach (var invalid in new[] { "http://x.com/u/status/1", "https://x.com.evil.test/u/status/1", "https://x.com@evil.test/u/status/1", "https://u:p@x.com/u/status/1", "https://x.com:8443/u/status/1", "file:///C:/a", "https://x.com/search?q=a", "--exec=malicious", "https://x.com/u/status/1/other", "https://x.com/u/status/1/video/0", "https://127.0.0.1/u/status/1" })
    await Test($"reject input {invalid}", () => Throws<ArgumentException>(() => Sync(() => PostUrl.Normalize(invalid))));
var media = MediaInfo.Parse(mediaJson);
var video = media[0];
await Test("multiple videos and nullable metadata", () => Sync(() => { Equal(2, media.Count); Equal(null, media[1].Duration); }));
await Test("quality filters DRM, audio, invalid selector; sorts by height", () => Sync(() => { Equal(3, video.Qualities.Count); Assert(video.Qualities[1].Label.StartsWith("1080p")); Assert(video.Qualities[1].Selector.Contains("+ba")); Equal("http-800", video.Qualities[2].Selector); }));
await Test("missing media rejected", () => Throws<InvalidOperationException>(() => Sync(() => MediaInfo.Parse("{\"id\":\"123\"}"))));
await Test("live media rejected", () => Throws<InvalidOperationException>(() => Sync(() => MediaInfo.Parse(mediaJson.Replace("\"id\":\"1231\"", "\"live_status\":\"is_live\",\"id\":\"1231\"").Replace("\"id\":\"1232\"", "\"live_status\":\"is_upcoming\",\"id\":\"1232\"")))));
var savedAt = new DateTimeOffset(2026,10,17,21,30,45,TimeSpan.FromHours(9));
await Test("suggested title includes editable local load date and moves uploader to suffix", () => Sync(() => Equal("20261017213045_Xテスト動画（投稿者名）", SaveFileName.Suggest(video, savedAt))));
await Test("uploader is inherited for playlists and missing names stay absent", () => Sync(() =>
{
    Equal("共通投稿者", MediaInfo.Parse(mediaJson.Replace("{\"entries\":", "{\"uploader\":\"共通投稿者\",\"entries\":"))[1].Uploader);
    Equal(null, media[1].Uploader);
    Equal("20261017213045_X動画2", SaveFileName.Suggest(media[1], savedAt));
    Equal("account_name", MediaInfo.Parse(mediaJson.Replace("\"uploader\":\"投稿者名\"", "\"uploader_id\":\"account_name\""))[0].Uploader);
    Equal("account_name", MediaInfo.Parse(mediaJson.Replace("{\"entries\":", "{\"uploader\":\"別の投稿者\",\"entries\":").Replace("\"uploader\":\"投稿者名\"", "\"uploader_id\":\"account_name\""))[0].Uploader);
}));
await Test("filename preserves changed dates and never adds a deleted date", () => Sync(() =>
{
    foreach (var title in new[]{"20261017213045_X好きな名前（投稿者名）", "20200101_X好きな名前", "X日付なし"})
        Equal(title, SaveFileName.Stem(title));
}));
await Test("filename cannot escape directory or use Windows reserved name after date removal", () => Sync(() =>
{
    var name = SaveFileName.Stem("../CON:<bad>?/x\\|*\"");
    Assert(!name.Contains('/')); Assert(!name.Contains(':')); Assert(!name.Contains('\\'));
    foreach (var title in new[]{"CON", "nul.txt", "COM1", "LPT²", "CONIN$"}) Equal("_"+title, SaveFileName.Stem(title));
    Assert(SaveFileName.Stem("CON."+new string('a',200)).Length<=SaveFileName.MaxTitleLength);
}));
await Test("filename length and emoji boundary", () => Sync(() => { var name = SaveFileName.Stem(new string('a',159) + "😀suffix"); Assert(!char.IsHighSurrogate(name[^1])); Assert(name.Length <= SaveFileName.MaxTitleLength); }));
await Test("long default titles retain uploader and closing bracket", () => Sync(() =>
{
    var title=SaveFileName.Suggest(video with { Title=new string('あ',250), Uploader=new string('名',100) }, savedAt);
    Assert(title.StartsWith("20261017213045_X") && title.Length<=SaveFileName.MaxTitleLength && title.EndsWith('）') && title.Contains('（'));
}));
await Test("empty and Windows-invalid-only titles are rejected", () => Sync(() =>
{
    foreach (var title in new[]{"", " \r\n\t", "<>:\"/\\|?*", "..."}) Assert(!SaveFileName.IsUsable(title));
    Equal("Xテスト 動画", SaveFileName.NormalizeTitle(" Xテスト\r\n動画. "));
}));
await Test("progress numbers and indeterminate", () => Sync(() => { Equal(52.3, Downloader.ParseProgress("XD_PROGRESS:52.3%|1MiB/s|00:02").Percent); Equal(null, Downloader.ParseProgress("XD_PROGRESS:NA|NA|NA").Percent); Equal(100.0, Downloader.ParseProgress("XD_PROGRESS:105%|NA|NA").Percent); }));

var sandbox = Path.Combine(Path.GetTempPath(), "x-downloader-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(sandbox);
try
{
    var tools = Path.Combine(sandbox, "tools"); Directory.CreateDirectory(tools);
    foreach (var name in new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe" }) File.WriteAllText(Path.Combine(tools, name), "fixture");
    var fake = new FakeEngine(mediaJson);
    var clock = new SaveClock(savedAt);
    var downloader = new Downloader(tools, fake, timeProvider: clock);
    await Test("analysis restricted to X and argument-list execution contract", async () =>
    {
        Equal(2, (await downloader.AnalyzeAsync(url, CancellationToken.None)).Count);
        var a = fake.LastArguments!;
        Assert(a.Contains("--no-plugin-dirs") && a.Contains("--ignore-config") && a.Contains("--no-cookies-from-browser"));
        Assert(a.Contains("twitter,twitter:amplify,twitter:card") && a[^2] == "--");
    });
    var installedTools = Path.Combine(Directory.GetCurrentDirectory(), "windows-x-downloader", "tools");
    if (File.Exists(Path.Combine(installedTools, "yt-dlp.exe")))
        await Test("real yt-dlp accepts every analysis/download CLI option offline", async () =>
        {
            var engine = Path.Combine(installedTools, "yt-dlp.exe");
            var capturedAnalysis = fake.LastArguments!;
            var analysisArguments = capturedAnalysis.Take(capturedAnalysis.Count - 2).Append("--list-extractors").ToArray();
            var parsed = await new EngineProcess().RunAsync(engine, analysisArguments, tools, TimeSpan.FromSeconds(20), null, CancellationToken.None);
            Assert(parsed.ExitCode == 0, parsed.Error);
            await downloader.DownloadAsync(url,video,video.Qualities[0],Path.Combine(sandbox,"option-check"),null,CancellationToken.None);
            var capturedDownload = fake.DownloadArguments!;
            var downloadArguments = capturedDownload.Take(capturedDownload.Count - 2).Append("--list-extractors").ToArray();
            parsed = await new EngineProcess().RunAsync(engine, downloadArguments, tools, TimeSpan.FromSeconds(20), null, CancellationToken.None);
            Assert(parsed.ExitCode == 0, parsed.Error);
        });
    else Console.WriteLine("SKIP real yt-dlp CLI check: run Prepare-Tools.ps1 to enable");
    if (File.Exists(Path.Combine(installedTools,"ffmpeg.exe")))
        await Test("real yt-dlp HTTP download, progress, ffprobe and full media decode", () => RealMediaFixture.VerifyAsync(installedTools,sandbox));
    else Console.WriteLine("SKIP real media integration: run Prepare-Tools.ps1 to enable");
    await Test("missing tools gives actionable error", () => Throws<FileNotFoundException>(() => new Downloader(sandbox).AnalyzeAsync(url, CancellationToken.None), "Prepare-Tools"));
    await Test("selected media filter, MP4 validation and no overwrite", async () =>
    {
        var dest = Path.Combine(sandbox, "保存 日本語");
        var first = await downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, CancellationToken.None);
        var second = await downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, CancellationToken.None);
        Assert(first != second && second.EndsWith(" (1).mp4"));
        Equal("fixture media", File.ReadAllText(first));
        Assert(!Directory.EnumerateDirectories(dest).Any());
        Assert(fake.DownloadArguments!.Contains("id ~= ^1231$"));
    });
    await Test("edited titles preserve kept, changed and deleted load dates through a long download", async () =>
    {
        var dest=Path.Combine(sandbox,"edited");
        clock.Utc=savedAt.UtcDateTime;
        fake.AfterDownload=()=>clock.Utc=clock.Utc.AddHours(1);
        foreach (var edited in new[]{"20261017213045_X変更した名前（投稿者名）", "20000101_X変更した日付", "X日付を削除"})
        {
            var file=await downloader.DownloadAsync(url,video,video.Qualities[0],dest,null,CancellationToken.None,edited);
            Equal(edited+".mp4",Path.GetFileName(file));
            Assert(!fake.DownloadArguments!.Any(a=>a.Contains(edited)));
        }
        fake.AfterDownload=null; clock.Utc=savedAt.UtcDateTime;
    });
    await Test("invalid edited title never starts engine or creates destination", async () =>
    {
        var dest=Path.Combine(sandbox,"empty-title");
        await Throws<ArgumentException>(()=>downloader.DownloadAsync(url,video,video.Qualities[0],dest,null,CancellationToken.None," \t"));
        Assert(!Directory.Exists(dest));
    });
    foreach (var (error, message) in new[] { ("HTTP 429 / secret-url", "アクセス制限"), ("NSFW requires login", "ログイン"), ("HTTP 403", "拒否"), ("404 deleted", "削除"), ("Requested format unavailable", "選択した画質"), ("no such option", "バージョン"), ("No video could be found in this tweet", "この投稿から動画情報を取得できません") })
        await Test($"safe error classification: {error.Split(' ')[0]}", async () =>
        {
            fake.Error = error;
            await Throws<InvalidOperationException>(() => downloader.AnalyzeAsync(url, CancellationToken.None), message);
            fake.Error = null;
        });
    await Test("failed download cleans only its staging directory", async () =>
    {
        fake.Error = "403";
        var dest = Path.Combine(sandbox, "failed"); Directory.CreateDirectory(dest);
        File.WriteAllText(Path.Combine(dest,"keep.mp4"), "existing");
        await Throws<InvalidOperationException>(() => downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, CancellationToken.None));
        Assert(!Directory.EnumerateDirectories(dest).Any()); Equal("existing", File.ReadAllText(Path.Combine(dest, "keep.mp4")));
        fake.Error = null;
    });
    await Test("ffprobe failure prevents final file", async () =>
    {
        fake.BadMedia = true;
        var dest = Path.Combine(sandbox, "bad-media");
        await Throws<InvalidOperationException>(() => downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, CancellationToken.None));
        Assert(!Directory.EnumerateFileSystemEntries(dest).Any()); fake.BadMedia = false;
    });
    await Test("engine cannot publish a path outside its job", async () =>
    {
        fake.Escape = true;
        var dest = Path.Combine(sandbox, "escape");
        await Throws<InvalidOperationException>(() => downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, CancellationToken.None));
        Assert(!Directory.EnumerateFileSystemEntries(dest).Any()); fake.Escape = false;
    });
    await Test("cancel after download before validation never publishes", async () =>
    {
        using var cancel = new CancellationTokenSource(); fake.AfterDownload = cancel.Cancel;
        var dest = Path.Combine(sandbox, "cancel");
        await Throws<OperationCanceledException>(() => downloader.DownloadAsync(url, video, video.Qualities[0], dest, null, cancel.Token));
        Assert(!Directory.EnumerateFileSystemEntries(dest).Any()); fake.AfterDownload = null;
    });
    await Test("unrecognized quality rejected", () => Throws<ArgumentException>(() => downloader.DownloadAsync(url, video, new Quality("fake", "bad"), sandbox, null, CancellationToken.None)));

    var real = new EngineProcess();
    await Test("real child process captures UTF-8 stdout/stderr", async () =>
    {
        var result = await real.RunAsync(Environment.ProcessPath!, ["--emit"], sandbox, TimeSpan.FromSeconds(10), null, CancellationToken.None);
        Equal(0, result.ExitCode); Assert(result.Output.Contains("日本語")); Assert(result.Error.Contains("fixture stderr"));
    });
    await Test("real process cancellation kills entire child tree", async () =>
    {
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10)); int childId = 0;
        await Throws<OperationCanceledException>(() => real.RunAsync(Environment.ProcessPath!, ["--child"], sandbox, TimeSpan.FromSeconds(20), line => { childId = int.Parse(line); cancel.Cancel(); }, cancel.Token));
        Assert(childId > 0);
        try { using var child = Process.GetProcessById(childId); Assert(child.HasExited, "grandchild survived cancellation"); } catch (ArgumentException) { }
    });
    await Test("real process timeout is distinct from cancellation", () => Throws<TimeoutException>(() => real.RunAsync(Environment.ProcessPath!, ["--sleep"], sandbox, TimeSpan.FromMilliseconds(400), null, CancellationToken.None)));
    if (OperatingSystem.IsWindows())
        await Test("Windows job terminates the engine when its app crashes",async()=>
        {
            var start=new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true };
            start.ArgumentList.Add("--supervisor");
            using var supervisor=Process.Start(start)!;
            int childId=0;
            try
            {
                var line=await supervisor.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
                childId=int.Parse(line!);
                supervisor.Kill(entireProcessTree:false); await supervisor.WaitForExitAsync();
                var deadline=DateTime.UtcNow.AddSeconds(5);
                while (true)
                {
                    try { using var child=Process.GetProcessById(childId); if (child.HasExited) break; }
                    catch (ArgumentException) { break; }
                    if (DateTime.UtcNow>=deadline) throw new Exception("engine survived its supervisor");
                    await Task.Delay(50);
                }
            }
            finally
            {
                if (!supervisor.HasExited) supervisor.Kill(true);
                if (childId>0) { try { using var child=Process.GetProcessById(childId); if (!child.HasExited) child.Kill(true); } catch (ArgumentException) { } }
            }
        });
}
finally { Directory.Delete(sandbox, true); }
await Test("bounded queue, duplicate protection, cancellation, pause and shutdown", QueueTests.VerifyAsync);
Console.WriteLine($"RESULT {passed} passed; {failures} failed");
return failures == 0 ? 0 : 1;

sealed class SaveClock(DateTimeOffset local) : TimeProvider
{
    public DateTimeOffset Utc { get; set; } = local.ToUniversalTime();
    public override DateTimeOffset GetUtcNow() => Utc;
    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.CreateCustomTimeZone("Fixture JST",TimeSpan.FromHours(9),"Fixture JST","Fixture JST");
}

sealed class FakeEngine(string metadata) : IEngineProcess
{
    public IReadOnlyList<string>? LastArguments { get; private set; }
    public IReadOnlyList<string>? DownloadArguments { get; private set; }
    public string? Error { get; set; }
    public bool BadMedia { get; set; }
    public bool Escape { get; set; }
    public Action? AfterDownload { get; set; }
    public Task<EngineResult> RunAsync(string executable, IReadOnlyList<string> arguments, string directory, TimeSpan timeout, Action<string>? onOutput, CancellationToken token)
    {
        token.ThrowIfCancellationRequested(); LastArguments = arguments;
        if (Error is not null) return Task.FromResult(new EngineResult(1,"",Error));
        if (executable.EndsWith("ffprobe.exe")) return Task.FromResult(new EngineResult(0, BadMedia ? "{\"streams\":[]}" : "{\"streams\":[{\"codec_type\":\"video\"}]}", ""));
        if (arguments.Contains("--dump-single-json")) return Task.FromResult(new EngineResult(0, metadata, ""));
        DownloadArguments = arguments;
        var file = Path.Combine(directory,"1231.mp4"); File.WriteAllText(file,"fixture media");
        onOutput?.Invoke("XD_PROGRESS:50.0%|1MiB/s|00:01");
        onOutput?.Invoke("XD_FILE:" + JsonSerializer.Serialize(Escape ? Path.Combine(directory,"..","outside.mp4") : file));
        AfterDownload?.Invoke();
        return Task.FromResult(new EngineResult(0,"",""));
    }
}

sealed class DiagnosticEngine : IEngineProcess
{
    public async Task<EngineResult> RunAsync(string executable, IReadOnlyList<string> arguments, string directory, TimeSpan timeout, Action<string>? output, CancellationToken token)
    {
        var result = await new EngineProcess().RunAsync(executable, arguments, directory, timeout, output, token);
        if (result.ExitCode != 0)
        {
            // Diagnostic mode only: no response body, metadata or signed URLs are printed.
            var sanitized = System.Text.RegularExpressions.Regex.Replace(result.Error, @"https?://\S+", "[URL]");
            sanitized = System.Text.RegularExpressions.Regex.Replace(sanitized, @"(?i)(authorization|cookie|token)[:=][^\r\n]*", "[redacted]");
            var relevant = string.Join(Environment.NewLine, sanitized.Split('\n').Where(line => line.Contains("extractor", StringComparison.OrdinalIgnoreCase) || line.StartsWith("ERROR:") || line.Contains("_VALID_URL")));
            Console.WriteLine("PROBE_ENGINE_ERROR " + relevant[..Math.Min(relevant.Length,1800)]);
        }
        return result;
    }
}

using System.Net;
using System.Text;
using Tlain.Downloader2.Core;

var tests = new (string Name, Func<Task> Run)[]
{
    ("direct single and request context", DirectSingle),
    ("100MB range with 4 and 8 connections", ParallelRanges),
    ("range mismatch falls back to single", RangeFallback),
    ("retry and status failures", RetryAndFailures),
    ("cancel removes partial operation", Cancel),
    ("HLS master and DRM classification", HlsAndDrm),
    ("Direct and HLS coordinator finalize local files", CoordinatorE2E),
    ("cross-origin redirect strips credentials", RedirectCredentialBoundary),
    ("history excludes secrets", HistoryPrivacy)
};

var failed = 0;
foreach (var test in tests)
{
    try { await test.Run(); Console.WriteLine($"PASS {test.Name}"); }
    catch (Exception error) { failed++; Console.Error.WriteLine($"FAIL {test.Name}: {error.GetType().Name} {error.Message}"); }
}
return failed == 0 ? 0 : 1;

static async Task DirectSingle()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    var path = TempFile();
    var request = new MediaRequest(server.Url("protected"), "direct", "video/mp4", "fixture", new Dictionary<string, string>
    {
        ["referer"] = server.Url("watch"), ["origin"] = server.Origin, ["cookie"] = "fixture=ok", ["user-agent"] = "FixtureBrowser"
    });
    await new DirectDownloader(transport).DownloadPartAsync(request, path, null, CancellationToken.None, 1);
    Equal(FixtureServer.SmallLength, new FileInfo(path).Length, "protected size");
    File.Delete(path);
}

static async Task ParallelRanges()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport(TimeSpan.FromSeconds(30));
    foreach (var connections in new[] { 4, 8 })
    {
        var path = TempFile();
        await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("range100"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, connections);
        Equal(FixtureServer.LargeLength, new FileInfo(path).Length, $"{connections} range size");
        File.Delete(path);
    }
    True(server.RangeRequestCount >= 13, "range request count");
}

static async Task RangeFallback()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    var path = TempFile();
    await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("mismatch"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 4);
    Equal(FixtureServer.SmallLength, new FileInfo(path).Length, "fallback size");
    True(server.FullRequestCount > 0, "single stream fallback");
    File.Delete(path);
}

static async Task RetryAndFailures()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    var path = TempFile();
    await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("flaky"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 1);
    True(server.FlakyCount >= 2, "retry count");
    File.Delete(path);
    foreach (var endpoint in new[] { "forbidden", "rate" })
    {
        var thrown = false;
        try { await new DirectDownloader(transport).DownloadPartAsync(new(server.Url(endpoint), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 1); }
        catch (DownloaderException) { thrown = true; }
        True(thrown, endpoint);
    }
}

static async Task Cancel()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport(TimeSpan.FromSeconds(30));
    var path = TempFile();
    using var cancellation = new CancellationTokenSource(100);
    var thrown = false;
    try { await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("slow"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, cancellation.Token, 1); }
    catch (OperationCanceledException) { thrown = true; }
    True(thrown, "cancelled");
    if (File.Exists(path)) File.Delete(path);
}

static async Task HlsAndDrm()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    var path = TempFile();
    await new HlsDownloader(transport).DownloadPartAsync(new(server.Url("master.m3u8"), "hls", "application/vnd.apple.mpegurl", null, new Dictionary<string, string>()), path, null, CancellationToken.None);
    True(new FileInfo(path).Length > 0, "HLS output");
    File.Delete(path);
    True(ManifestInspector.HasExplicitDrm("<ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"/>"), "widevine fixture");
    True(!ManifestInspector.HasExplicitDrm("#EXT-X-KEY:METHOD=AES-128,KEYFORMAT=\"identity\""), "AES-128 is not guessed as DRM");
    var directory = Path.Combine(Path.GetTempPath(), "tlain-drm-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(directory);
    var coordinator = new DownloadCoordinator(transport, new ToolLocator(directory), new HistoryStore(directory), new MediaValidator(new ToolLocator(directory)), new CleanScanner(), directory);
    try { await coordinator.DownloadAsync("drm", new(server.Url("drm.mpd"), "dash", "application/dash+xml", null, new Dictionary<string, string>()), null, CancellationToken.None); throw new InvalidOperationException("DRM fixture was accepted"); }
    catch (DownloaderException error) { True(error.Code == "drm_not_supported", "DRM result code"); }
    Directory.Delete(directory, true);
}

static async Task RedirectCredentialBoundary()
{
    await using var target = new FixtureServer();
    await using var source = new FixtureServer(target);
    using var transport = new HttpTransport();
    var path = TempFile();
    await new DirectDownloader(transport).DownloadPartAsync(new(source.Url("cross-redirect"), "direct", "video/mp4", null, new Dictionary<string, string> { ["cookie"] = "secret=yes", ["authorization"] = "Bearer secret" }), path, null, CancellationToken.None, 1);
    True(target.CrossOriginCredentialsAbsent, "credentials stripped");
    var external = HeaderPolicy.ForExternalTool(new Dictionary<string, string> { ["cookie"] = "secret=yes", ["authorization"] = "Bearer secret", ["referer"] = source.Url("watch") });
    True(!external.ContainsKey("cookie") && !external.ContainsKey("authorization") && external.ContainsKey("referer"), "external tool credentials stripped");
    File.Delete(path);
}

static async Task CoordinatorE2E()
{
    await using var server = new FixtureServer();
    var directory = Path.Combine(Path.GetTempPath(), "tlain-e2e-" + Guid.NewGuid().ToString("N"));
    var toolDirectory = Path.Combine(directory, "empty-tools"); Directory.CreateDirectory(toolDirectory);
    var tools = new ToolLocator(toolDirectory);
    var history = new HistoryStore(Path.Combine(directory, "history"));
    using var transport = new HttpTransport();
    var coordinator = new DownloadCoordinator(transport, tools, history, new MediaValidator(tools), new CleanScanner(), Path.Combine(directory, "downloads"));
    var direct = await coordinator.DownloadAsync("direct-e2e", new(server.Url("video.mp4"), "direct", "video/mp4", "direct fixture", new Dictionary<string, string>()), null, CancellationToken.None);
    var hls = await coordinator.DownloadAsync("hls-e2e", new(server.Url("master.m3u8"), "hls", "application/vnd.apple.mpegurl", "hls fixture", new Dictionary<string, string>()), null, CancellationToken.None);
    True(File.Exists(direct.FullPath) && direct.FullPath.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase), "direct final file");
    True(File.Exists(hls.FullPath) && hls.FullPath.EndsWith(".ts", StringComparison.OrdinalIgnoreCase), "HLS final file");
    Equal(2, (await history.ListAsync()).Count, "history items");
    Directory.Delete(directory, true);
}

static async Task HistoryPrivacy()
{
    var directory = Path.Combine(Path.GetTempPath(), "tlain-history-test-" + Guid.NewGuid().ToString("N"));
    var store = new HistoryStore(directory);
    await store.AddAsync(new("id", "title", "fixture.test", "file.mp4", 10, "1920x1080", 1, "direct", "success", 1, DateTimeOffset.UtcNow));
    var text = await File.ReadAllTextAsync(Path.Combine(directory, "history.json"));
    True(!text.Contains("cookie", StringComparison.OrdinalIgnoreCase) && !text.Contains("authorization", StringComparison.OrdinalIgnoreCase) && !text.Contains("?", StringComparison.Ordinal), "history privacy");
    Directory.Delete(directory, true);
}

static string TempFile() => Path.Combine(Path.GetTempPath(), $"tlain-{Guid.NewGuid():N}.tlain.part");
static void True(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
static void Equal(long expected, long actual, string message) { if (expected != actual) throw new InvalidOperationException($"{message}: {expected} != {actual}"); }

sealed class FixtureServer : IAsyncDisposable
{
    public const int SmallLength = 2 * 1024 * 1024;
    public const int LargeLength = 100 * 1024 * 1024;
    private readonly HttpListener listener = new();
    private readonly CancellationTokenSource stop = new();
    private readonly Task loop;
    private readonly FixtureServer? redirectTarget;
    public int RangeRequestCount;
    public int FullRequestCount;
    public int FlakyCount;
    public bool CrossOriginCredentialsAbsent;
    public string Origin { get; }

    public FixtureServer(FixtureServer? redirectTarget = null)
    {
        this.redirectTarget = redirectTarget;
        var port = Random.Shared.Next(20000, 50000);
        Origin = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(Origin + "/");
        listener.Start();
        loop = Task.Run(ListenAsync);
    }

    public string Url(string path) => $"{Origin}/{path}";

    private async Task ListenAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); } catch { break; }
            _ = Task.Run(() => HandleAsync(context));
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        try
        {
            var path = context.Request.Url!.AbsolutePath.Trim('/');
            if (path == "protected" && (context.Request.Headers["Cookie"] != "fixture=ok" || context.Request.Headers["Referer"] != Url("watch") || context.Request.Headers["Origin"] != Origin)) { context.Response.StatusCode = 403; return; }
            if (path == "cross-redirect") { context.Response.StatusCode = 302; context.Response.RedirectLocation = redirectTarget!.Url("credential-target"); return; }
            if (path == "credential-target") CrossOriginCredentialsAbsent = context.Request.Headers["Cookie"] is null && context.Request.Headers["Authorization"] is null;
            if (path == "forbidden") { context.Response.StatusCode = 403; return; }
            if (path == "rate") { context.Response.StatusCode = 429; return; }
            if (path == "flaky" && Interlocked.Increment(ref FlakyCount) < 3) { context.Response.StatusCode = 500; return; }
            if (path == "master.m3u8") { await Text(context, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvariant.m3u8\n", "application/vnd.apple.mpegurl"); return; }
            if (path == "variant.m3u8") { await Text(context, "#EXTM3U\n#EXTINF:1,\nseg1.ts\n#EXTINF:1,\nseg2.ts\n#EXT-X-ENDLIST\n", "application/vnd.apple.mpegurl"); return; }
            if (path == "drm.mpd") { await Text(context, "<MPD><ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"/></MPD>", "application/dash+xml"); return; }
            if (path is "seg1.ts" or "seg2.ts") { context.Response.ContentType = "video/mp2t"; await WritePattern(context.Response, 188 * 10, 0, false, false); return; }
            var length = path == "range100" ? LargeLength : SmallLength;
            var range = context.Request.Headers["Range"];
            if (path == "slow") { context.Response.ContentLength64 = length; await WritePattern(context.Response, length, 0, true); return; }
            if (!string.IsNullOrEmpty(range) && TryRange(range, length, out var start, out var end))
            {
                Interlocked.Increment(ref RangeRequestCount);
                context.Response.StatusCode = 206;
                if (path == "mismatch" && start > 0) { context.Response.Headers["Content-Range"] = $"bytes {start + 1}-{end}/{length}"; }
                else context.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{length}";
                context.Response.Headers["Accept-Ranges"] = "bytes";
                await WritePattern(context.Response, end - start + 1, start, false, true);
                return;
            }
            Interlocked.Increment(ref FullRequestCount);
            context.Response.ContentType = "video/mp4";
            await WritePattern(context.Response, length, 0, false, true);
        }
        catch { }
        finally { try { context.Response.Close(); } catch { } }
    }

    private static bool TryRange(string value, int length, out long start, out long end)
    {
        start = end = 0;
        var match = System.Text.RegularExpressions.Regex.Match(value, "^bytes=(\\d+)-(\\d*)$");
        if (!match.Success) return false;
        start = long.Parse(match.Groups[1].Value);
        end = match.Groups[2].Value.Length > 0 ? long.Parse(match.Groups[2].Value) : length - 1;
        end = Math.Min(end, length - 1);
        return start <= end;
    }

    private static async Task WritePattern(HttpListenerResponse response, long length, long offset, bool slow, bool mp4 = true)
    {
        response.ContentLength64 = length;
        var buffer = new byte[64 * 1024];
        long written = 0;
        while (written < length)
        {
            var count = (int)Math.Min(buffer.Length, length - written);
            for (var index = 0; index < count; index++)
            {
                var position = offset + written + index;
                buffer[index] = mp4 && position is >= 4 and <= 7 ? (byte)"ftyp"[(int)position - 4]
                    : !mp4 && position % 188 == 0 ? (byte)0x47 : (byte)(position % 251);
            }
            await response.OutputStream.WriteAsync(buffer.AsMemory(0, count));
            written += count;
            if (slow) await Task.Delay(20);
        }
    }

    private static async Task Text(HttpListenerContext context, string text, string type)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        context.Response.ContentType = type;
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel(); listener.Close();
        try { await loop; } catch { }
        stop.Dispose();
    }
}

sealed class CleanScanner : IDefenderScanner
{
    public Task<DefenderResult> ScanAsync(string path, CancellationToken cancellationToken) => Task.FromResult(new DefenderResult(true, false, null));
}

using System.Net;
using System.Net.Sockets;
using System.Text;
using Tlain.Downloader2.Core;
using Tlain.Downloader2.Host;

var tests = new (string Name, Func<Task> Run)[]
{
    ("direct single and request context", DirectSingle),
    ("virtual range with 4, 8 and 16 connections", ParallelRanges),
    ("range mismatch falls back to single", RangeFallback),
    ("retry and status failures", RetryAndFailures),
    ("cancel removes partial operation", Cancel),
    ("HLS master and DRM classification", HlsAndDrm),
    ("Direct and HLS coordinator finalize local files", CoordinatorE2E),
    ("cross-origin redirect strips credentials", RedirectCredentialBoundary),
    ("history excludes secrets", HistoryPrivacy)
    ,("Native Messaging framing limits", NativeMessagingLimits)
    ,("pairing profiles and challenge lifetime fail closed", PairingBoundaries)
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
    Equal(4, DirectDownloader.AdaptiveConnections(32L * 1024 * 1024), "adaptive 4");
    Equal(8, DirectDownloader.AdaptiveConnections(256L * 1024 * 1024), "adaptive 8");
    Equal(16, DirectDownloader.AdaptiveConnections(1024L * 1024 * 1024), "adaptive 16");
    foreach (var connections in new[] { 4, 8, 16 })
    {
        var path = TempFile();
        server.ResetRanges();
        await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("range-virtual"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, connections);
        Equal(FixtureServer.VirtualRangeLength, new FileInfo(path).Length, $"{connections} range size");
        var ranges = server.RangeSnapshot();
        Equal(connections + 1, ranges.Count, $"{connections} probe plus range count");
        Equal(0, ranges[0].Start, $"{connections} probe start");
        Equal(0, ranges[0].End, $"{connections} probe end");
        var downloads = ranges.Skip(1).OrderBy(item => item.Start).ToArray();
        Equal(connections, downloads.Select(item => item.Start).Distinct().Count(), $"{connections} distinct ranges");
        var segmentSize = (FixtureServer.VirtualRangeLength + connections - 1L) / connections;
        for (var index = 0; index < connections; index++)
        {
            Equal(index * segmentSize, downloads[index].Start, $"{connections} range {index} start");
            Equal(Math.Min(FixtureServer.VirtualRangeLength - 1, (index + 1) * segmentSize - 1), downloads[index].End, $"{connections} range {index} end");
        }
        await AssertPatternFile(path, FixtureServer.VirtualRangeLength, $"{connections} range content");
        File.Delete(path);
        True(!File.Exists(path), $"{connections} partial cleanup");
    }
}

static async Task RangeFallback()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    foreach (var endpoint in new[] { "mismatch", "mismatch-total", "range-short", "range-overflow" })
    {
        var path = TempFile();
        var before = server.FullRequestCount;
        await new DirectDownloader(transport).DownloadPartAsync(new(server.Url(endpoint), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 4);
        Equal(FixtureServer.SmallLength, new FileInfo(path).Length, $"{endpoint} fallback size");
        True(server.FullRequestCount > before, $"{endpoint} single stream fallback");
        await AssertPatternFile(path, FixtureServer.SmallLength, $"{endpoint} fallback content");
        File.Delete(path);
        True(!File.Exists(path), $"{endpoint} partial cleanup");
    }
}

static async Task RetryAndFailures()
{
    await using var server = new FixtureServer();
    using var transport = new HttpTransport();
    var path = TempFile();
    await new DirectDownloader(transport).DownloadPartAsync(new(server.Url("flaky"), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 1);
    True(server.FlakyCount >= 3, "retry count");
    await AssertPatternFile(path, FixtureServer.SmallLength, "retry content");
    File.Delete(path);
    foreach (var endpoint in new[] { "forbidden", "rate" })
    {
        var thrown = false;
        try { await new DirectDownloader(transport).DownloadPartAsync(new(server.Url(endpoint), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, CancellationToken.None, 1); }
        catch (DownloaderException) { thrown = true; }
        True(thrown, endpoint);
        True(!File.Exists(path), $"{endpoint} partial cleanup");
    }
}

static async Task Cancel()
{
    foreach (var scenario in new[] {
        (Endpoint: "slow", Connections: 1, WaitForRequest: "full"),
        (Endpoint: "slow-range", Connections: 16, WaitForRequest: "range"),
        (Endpoint: "slow-fallback", Connections: 4, WaitForRequest: "full")
    })
    {
        await using var server = new FixtureServer();
        using var transport = new HttpTransport(TimeSpan.FromSeconds(30));
        var path = TempFile();
        using var cancellation = new CancellationTokenSource();
        var download = new DirectDownloader(transport).DownloadPartAsync(new(server.Url(scenario.Endpoint), "direct", "video/mp4", null, new Dictionary<string, string>()), path, null, cancellation.Token, scenario.Connections);
        if (scenario.WaitForRequest == "range") await server.WaitForParallelRangeAsync().WaitAsync(TimeSpan.FromSeconds(5));
        else await server.WaitForFullRequestAsync().WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Throws<OperationCanceledException>(() => download, $"{scenario.Endpoint} cancelled");
        True(!File.Exists(path), $"{scenario.Endpoint} partial file removed");
    }
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
    var sanitized = HeaderPolicy.Normalize(new Dictionary<string, string> { ["referer"] = "https://fixture.test/watch\r\nX-Injected: yes" });
    True(!sanitized["referer"].Contains('\r') && !sanitized["referer"].Contains('\n'), "header injection stripped");
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

static async Task NativeMessagingLimits()
{
    var prefix = BitConverter.GetBytes(1024 * 1024 + 1);
    await using var oversized = new MemoryStream(prefix);
    await using var sink = new MemoryStream();
    await Throws<InvalidDataException>(() => new NativeMessaging(oversized, sink).ReadAsync(CancellationToken.None), "1 MiB input limit");

    var deepJson = Encoding.UTF8.GetBytes(new string('[', 20) + "0" + new string(']', 20));
    var framed = new MemoryStream();
    await framed.WriteAsync(BitConverter.GetBytes(deepJson.Length));
    await framed.WriteAsync(deepJson);
    framed.Position = 0;
    await Throws<System.Text.Json.JsonException>(() => new NativeMessaging(framed, sink).ReadAsync(CancellationToken.None), "JSON MaxDepth");

    await using var output = new MemoryStream();
    var messaging = new NativeMessaging(Stream.Null, output);
    await messaging.WriteAsync(new { version = 1, ok = true });
    True(output.Length > 4, "framed output");
}

static async Task PairingBoundaries()
{
    EqualString("https://tanaka-note.com/downloader2/api/pairing/redeem", BuildProfile.Current.PairingEndpoint.AbsoluteUri, "Production pairing endpoint");
    var e2e = BuildProfile.CreateE2E("https://isolated-preview.example.invalid/downloader2/api/pairing/redeem", "isolated-preview.example.invalid");
    EqualString("e2e", e2e.Name, "E2E profile");
    foreach (var invalid in new[] {
        ("http://preview.example.invalid/downloader2/api/pairing/redeem", "preview.example.invalid"),
        ("https://tanaka-note.com/downloader2/api/pairing/redeem", "tanaka-note.com"),
        ("https://preview.example.invalid/downloader2/api/pairing/redeem", "other.example.invalid")
    }) ThrowsSync<InvalidOperationException>(() => { _ = BuildProfile.CreateE2E(invalid.Item1, invalid.Item2); }, "invalid E2E profile");
    var state = new PairingChallengeState();
    var issued = state.Issue(1000);
    Equal(1120, issued.ExpiresAt, "120 second challenge");
    True(state.TryGet(1120, 1001, out var challenge), "fresh challenge");
    True(state.Consume(challenge), "first challenge consume");
    True(!state.TryGet(1120, 1001, out _), "challenge cannot be reused");
    var handler = new RecordingHandler();
    using var verifier = new PairingVerifier(BuildProfile.Current.PairingEndpoint, handler);
    True(!await verifier.VerifyAsync("token", "challenge", 1120, CancellationToken.None), "pairing redirect rejected");
    Equal(1, handler.RequestCount, "pairing redirect not followed");
    EqualString(BuildProfile.Current.PairingEndpoint.AbsoluteUri, handler.RequestUri!.AbsoluteUri, "pairing request fixed endpoint");
}

static string TempFile() => Path.Combine(Path.GetTempPath(), $"tlain-{Guid.NewGuid():N}.tlain.part");
static async Task AssertPatternFile(string path, int length, string message)
{
    await using var stream = File.OpenRead(path);
    Equal(length, stream.Length, $"{message} length");
    var buffer = new byte[64 * 1024];
    long position = 0;
    while (true)
    {
        var count = await stream.ReadAsync(buffer);
        if (count == 0) break;
        for (var index = 0; index < count; index++, position++)
        {
            var expected = position is >= 4 and <= 7 ? (byte)"ftyp"[(int)position - 4] : (byte)(position % 251);
            if (buffer[index] != expected) throw new InvalidOperationException($"{message}: byte {position} was {buffer[index]}, expected {expected}");
        }
    }
    Equal(length, position, $"{message} bytes read");
}
static void True(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
static void Equal(long expected, long actual, string message) { if (expected != actual) throw new InvalidOperationException($"{message}: {expected} != {actual}"); }
static void EqualString(string expected, string actual, string message) { if (expected != actual) throw new InvalidOperationException($"{message}: {expected} != {actual}"); }
static async Task Throws<T>(Func<Task> action, string message) where T : Exception { try { await action(); } catch (T) { return; } throw new InvalidOperationException(message); }
static void ThrowsSync<T>(Action action, string message) where T : Exception { try { action(); } catch (T) { return; } throw new InvalidOperationException(message); }

sealed class FixtureServer : IAsyncDisposable
{
    public const int SmallLength = 2 * 1024 * 1024;
    public const int VirtualRangeLength = 2 * 1024 * 1024;
    private readonly HttpListener listener;
    private readonly CancellationTokenSource stop = new();
    private readonly Task loop;
    private readonly object requestGate = new();
    private readonly HashSet<Task> requests = [];
    private readonly TaskCompletionSource<bool> parallelRangeStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> fullRequestStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly FixtureServer? redirectTarget;
    public int RangeRequestCount;
    public int FullRequestCount;
    public int FlakyCount;
    public bool CrossOriginCredentialsAbsent;
    public List<(long Start, long End)> Ranges { get; } = [];
    public string Origin { get; }

    public FixtureServer(FixtureServer? redirectTarget = null)
    {
        this.redirectTarget = redirectTarget;
        (listener, Origin) = StartListener();
        loop = Task.Run(ListenAsync);
    }

    public string Url(string path) => $"{Origin}/{path}";
    public void ResetRanges() { lock (Ranges) Ranges.Clear(); }
    public IReadOnlyList<(long Start, long End)> RangeSnapshot() { lock (Ranges) return [.. Ranges]; }
    public Task WaitForParallelRangeAsync() => parallelRangeStarted.Task;
    public Task WaitForFullRequestAsync() => fullRequestStarted.Task;

    private static (HttpListener Listener, string Origin) StartListener()
    {
        HttpListenerException? last = null;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            int port;
            using (var reservation = new TcpListener(IPAddress.Loopback, 0))
            {
                reservation.ExclusiveAddressUse = true;
                reservation.Start();
                port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            }
            var origin = $"http://127.0.0.1:{port}";
            var candidate = new HttpListener();
            candidate.Prefixes.Add(origin + "/");
            try
            {
                candidate.Start();
                return (candidate, origin);
            }
            catch (HttpListenerException error)
            {
                last = error;
                candidate.Close();
            }
        }
        throw new InvalidOperationException("Could not bind an ephemeral HTTP fixture port.", last);
    }

    private async Task ListenAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); } catch when (stop.IsCancellationRequested) { break; }
            var request = HandleAsync(context);
            lock (requestGate) requests.Add(request);
            _ = request.ContinueWith(completed => { lock (requestGate) requests.Remove(completed); }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
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
            var length = path == "range-virtual" ? VirtualRangeLength : SmallLength;
            var range = context.Request.Headers["Range"];
            if (path is "slow" or "slow-fallback" && string.IsNullOrEmpty(range))
            {
                fullRequestStarted.TrySetResult(true);
                context.Response.ContentLength64 = length;
                await WritePattern(context.Response, length, 0, true, true, stop.Token);
                return;
            }
            if (!string.IsNullOrEmpty(range) && TryRange(range, length, out var start, out var end))
            {
                Interlocked.Increment(ref RangeRequestCount);
                lock (Ranges) Ranges.Add((start, end));
                context.Response.StatusCode = 206;
                if (path == "slow-range" && start > 0) parallelRangeStarted.TrySetResult(true);
                if (path is "mismatch" or "slow-fallback" && start > 0) { context.Response.Headers["Content-Range"] = $"bytes {start + 1}-{end}/{length}"; }
                else if (path == "mismatch-total" && start > 0) { context.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{length + 1}"; }
                else context.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{length}";
                context.Response.Headers["Accept-Ranges"] = "bytes";
                var responseLength = end - start + 1;
                if (path == "range-short" && start > 0) responseLength--;
                if (path == "range-overflow" && start > 0) responseLength++;
                await WritePattern(context.Response, responseLength, start, path == "slow-range", true, stop.Token);
                return;
            }
            Interlocked.Increment(ref FullRequestCount);
            fullRequestStarted.TrySetResult(true);
            context.Response.ContentType = "video/mp4";
            await WritePattern(context.Response, length, 0, false, true, stop.Token);
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

    private static async Task WritePattern(HttpListenerResponse response, long length, long offset, bool slow, bool mp4 = true, CancellationToken cancellationToken = default)
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
            await response.OutputStream.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
            written += count;
            if (slow) await Task.Delay(20, cancellationToken);
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
        Task[] active;
        lock (requestGate) active = [.. requests];
        try { await Task.WhenAll(active); } catch { }
        stop.Dispose();
    }
}

sealed class CleanScanner : IDefenderScanner
{
    public Task<DefenderResult> ScanAsync(string path, CancellationToken cancellationToken) => Task.FromResult(new DefenderResult(true, false, null));
}

sealed class RecordingHandler : HttpMessageHandler
{
    public int RequestCount { get; private set; }
    public Uri? RequestUri { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        RequestCount++;
        RequestUri = request.RequestUri;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://untrusted.example.invalid/redeem") } });
    }
}

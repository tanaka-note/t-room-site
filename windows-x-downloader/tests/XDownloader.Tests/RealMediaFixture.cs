using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using XDownloader.Core;

internal static class RealMediaFixture
{
    public static async Task VerifyAsync(string tools, string sandbox)
    {
        var process = new EngineProcess();
        var fixture = Path.Combine(sandbox,"synthetic.mp4");
        var made = await process.RunAsync(Path.Combine(tools,"ffmpeg.exe"),
            ["-v","error","-f","lavfi","-i","color=size=160x90:rate=10:duration=1","-f","lavfi","-i","sine=frequency=440:sample_rate=44100:duration=1",
             "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-movflags","+faststart",fixture],
            sandbox,TimeSpan.FromSeconds(20),null,CancellationToken.None);
        if (made.ExitCode != 0) throw new Exception("Synthetic media generation failed");
        var bytes = File.ReadAllBytes(fixture);
        using var stop = new CancellationTokenSource();
        using var server = new TcpListener(IPAddress.Loopback,0);
        server.Start();
        var port = ((IPEndPoint)server.LocalEndpoint).Port;
        var serving = Task.Run(async () =>
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    using var client = await server.AcceptTcpClientAsync(stop.Token);
                    await using var stream = client.GetStream();
                    using var reader = new StreamReader(stream,Encoding.ASCII,leaveOpen:true);
                    var request = await reader.ReadLineAsync(stop.Token);
                    while (!string.IsNullOrEmpty(await reader.ReadLineAsync(stop.Token))) { }
                    var ok = request?.StartsWith("GET /fixture.mp4 ",StringComparison.Ordinal) == true;
                    var body = ok ? bytes : [];
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 {(ok ? "200 OK" : "404 Not Found")}\r\nContent-Type: video/mp4\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"),stop.Token);
                    await stream.WriteAsync(body,stop.Token);
                }
            }
            catch (OperationCanceledException) { }
        });
        try
        {
            var info = JsonSerializer.Serialize(new
            {
                id="1231", title="ローカル合成動画", extractor="twitter", extractor_key="Twitter", webpage_url="https://x.com/user/status/123",
                duration=1,
                formats=new[] { new { format_id="fixture", ext="mp4", protocol="http", url=$"http://127.0.0.1:{port}/fixture.mp4", vcodec="h264", acodec="aac", height=90 } }
            });
            var infoFile=Path.Combine(sandbox,"fixture-info.json"); File.WriteAllText(infoFile,info);
            var runner = new FixtureInfoRunner(infoFile);
            var downloader=new Downloader(tools,runner);
            var video=MediaInfo.Parse(info)[0];
            var output=Path.Combine(sandbox,"real-media");
            var file=await downloader.DownloadAsync("https://x.com/user/status/123",video,video.Qualities[0],output,null,CancellationToken.None);
            if (!File.Exists(file) || new FileInfo(file).Length == 0 || Directory.EnumerateDirectories(output).Any())
                throw new Exception("Real media was not published cleanly");
            if (runner.ProgressEvents == 0) throw new Exception("Real yt-dlp progress was not received");
            // A full decode of this tiny fixture checks both audio and video in addition to production's ffprobe gate.
            var decoded=await process.RunAsync(Path.Combine(tools,"ffmpeg.exe"),["-v","error","-i",file,"-f","null","-"],sandbox,TimeSpan.FromSeconds(20),null,CancellationToken.None);
            if (decoded.ExitCode != 0) throw new Exception("Downloaded synthetic media does not decode");
        }
        finally { stop.Cancel(); await serving; }
    }

    private sealed class FixtureInfoRunner(string infoFile) : IEngineProcess
    {
        public int ProgressEvents { get; private set; }
        public Task<EngineResult> RunAsync(string executable,IReadOnlyList<string> arguments,string directory,TimeSpan timeout,Action<string>? output,CancellationToken token)
        {
            var actual=executable.EndsWith("yt-dlp.exe") ? arguments.Take(arguments.Count-2).Concat(new[]{"--load-info-json",infoFile}).ToArray() : arguments;
            return new EngineProcess().RunAsync(executable,actual,directory,timeout,line =>
            {
                if (line.StartsWith("XD_PROGRESS:")) ProgressEvents++;
                output?.Invoke(line);
            },token);
        }
    }
}

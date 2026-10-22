using System.Collections.Concurrent;
using System.Text.Json;
using XDownloader.Core;

internal static class QueueTests
{
    internal static async Task VerifyAsync()
    {
        var root=Path.Combine(Path.GetTempPath(),"xdownloader-queue-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        foreach (var name in new[]{"yt-dlp.exe","ffmpeg.exe","ffprobe.exe"}) File.WriteAllText(Path.Combine(root,name),"fixture");
        try
        {
            var engine=new QueueEngine();
            var queue=new DownloadQueue(new Downloader(root,engine));
            var quality=new Quality("MP4","mp4");
            var video=new VideoInfo("1231","fixture",null,[quality]);
            DownloadRequest Request(int id,string title) => new($"https://x.com/user/status/{id}",video,quality,Path.Combine(root,"saved"),title);
            var first=queue.Enqueue(Request(123,"日付なしの編集名"));
            var second=queue.Enqueue(Request(456,"20200101_変更した日付"));
            var third=queue.Enqueue(Request(789,"三本目"));
            await Until(()=>engine.Started.Count==2);
            Check(queue.Snapshot().Count(j=>j.State=="running")==2 && queue.Snapshot()[2].State=="waiting","two download slots and FIFO waiting");
            try { queue.Enqueue(Request(123,"duplicate") with { Url="https://x.com/other/status/123?tracking=1" }); throw new Exception("duplicate accepted"); }
            catch (InvalidOperationException) { }
            queue.Cancel(first);
            await Until(()=>engine.Started.Count==3);
            engine.Release("456"); engine.Release("789"); await queue.WhenIdleAsync().WaitAsync(TimeSpan.FromSeconds(10));
            var items=queue.Snapshot();
            Check(engine.Maximum==2 && items[0].State=="cancelled" && items[1].State=="completed" && items[2].State=="completed","individual cancellation starts the next job without affecting others");
            Check(Path.GetFileName(items[1].SavedPath)=="20200101_変更した日付.mp4" && Path.GetFileName(items[2].SavedPath)=="三本目.mp4","each queued title is captured without readding a date");
            Check(!Directory.EnumerateDirectories(Path.Combine(root,"saved")).Any(),"queue jobs clean isolated staging folders");
            await queue.StopAsync();

            var limited=new QueueEngine { Rejected="111" };
            var accessQueue=new DownloadQueue(new Downloader(root,limited)); accessQueue.Pause();
            accessQueue.Enqueue(Request(111,"制限")); accessQueue.Enqueue(Request(222,"取得中")); accessQueue.Enqueue(Request(333,"待ち"));
            accessQueue.Resume(); await Until(()=>accessQueue.IsPaused && accessQueue.Snapshot()[0].State=="failed");
            Check(accessQueue.Snapshot()[2].State=="waiting" && !limited.Started.Contains("333"),"rate limit pauses new jobs without automatic retry");
            limited.Release("222");
            accessQueue.Resume(); await Until(()=>limited.Started.Contains("333")); limited.Release("333");
            await accessQueue.WhenIdleAsync().WaitAsync(TimeSpan.FromSeconds(10)); await accessQueue.StopAsync();
            Check(accessQueue.Snapshot()[2].State=="completed","explicit resume releases waiting work");

            var stoppedEngine=new QueueEngine(); var stopped=new DownloadQueue(new Downloader(root,stoppedEngine));
            stopped.Enqueue(Request(444,"終了1")); stopped.Enqueue(Request(555,"終了2")); stopped.Enqueue(Request(666,"終了3"));
            await stopped.StopAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Check(stopped.Snapshot().All(j=>j.State=="cancelled") && !stoppedEngine.Started.Contains("666"),"shutdown cancels running and waiting jobs and awaits cleanup");
        }
        finally { Directory.Delete(root,true); }
    }
    private static void Check(bool result,string label) { if (!result) throw new Exception(label); Console.WriteLine("PASS QUEUE "+label); }
    private static async Task Until(Func<bool> condition)
    {
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition()) await Task.Delay(10,timeout.Token);
    }
    private sealed class QueueEngine : IEngineProcess
    {
        private int active;
        private int maximum;
        private readonly ConcurrentDictionary<string,TaskCompletionSource> releases=new();
        public ConcurrentBag<string> Started { get; }=[];
        public int Maximum => maximum;
        public string? Rejected { get; init; }
        public void Release(string id) => releases.GetOrAdd(id,_=>new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
        public async Task<EngineResult> RunAsync(string executable,IReadOnlyList<string> args,string directory,TimeSpan timeout,Action<string>? output,CancellationToken token)
        {
            if (executable.EndsWith("ffprobe.exe")) return new(0,"{\"streams\":[{\"codec_type\":\"video\"}]}","");
            var id=args[^1].Split('/')[^1];
            var current=Interlocked.Increment(ref active);
            int previous; do { previous=maximum; } while (current>previous && Interlocked.CompareExchange(ref maximum,current,previous)!=previous);
            Started.Add(id);
            try
            {
                await Task.Yield();
                if (id==Rejected) return new(1,"","HTTP 429 secret-url");
                await releases.GetOrAdd(id,_=>new(TaskCreationOptions.RunContinuationsAsynchronously)).Task.WaitAsync(token);
                var file=Path.Combine(directory,"fixture.mp4"); File.WriteAllText(file,"safe media");
                output?.Invoke("XD_FILE:"+JsonSerializer.Serialize(file)); return new(0,"","");
            }
            finally { Interlocked.Decrement(ref active); }
        }
    }
}

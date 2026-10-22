namespace XDownloader.Core;

public sealed record DownloadRequest(string Url, VideoInfo Video, Quality Quality, string Destination, string Title);
public sealed record QueuedDownload(Guid Id, string Title, string State, double? Percent, string Message, string? SavedPath, bool CanCancel);

// All requests capture their own title, quality and destination. Queue state is memory-only.
public sealed class DownloadQueue(Downloader downloader)
{
    private readonly object gate = new();
    private readonly List<Job> jobs = [];
    private readonly Queue<Job> pending = new();
    private int running;
    private bool stopped;
    private bool paused;
    public event Action? Changed;
    public bool IsPaused { get { lock (gate) return paused; } }
    public bool HasUnfinished { get { lock (gate) return jobs.Any(j => !j.Completion.Task.IsCompleted); } }
    public IReadOnlyList<QueuedDownload> Snapshot()
    {
        lock (gate) return jobs.Select(j => new QueuedDownload(j.Id, j.Request.Title, j.State, j.Percent,
            j.Message, j.SavedPath, !j.Completion.Task.IsCompleted)).ToArray();
    }

    public Guid Enqueue(DownloadRequest request)
    {
        request = request with { Url = PostUrl.Normalize(request.Url), Destination = Path.GetFullPath(request.Destination),
            Title = SaveFileName.NormalizeTitle(request.Title) };
        if (!request.Video.Qualities.Contains(request.Quality)) throw new ArgumentException("解析結果から画質を選択してください。");
        var postId = request.Url.Split("/status/", StringSplitOptions.None)[1].Split('/')[0];
        var key = postId + ":" + request.Video.Id;
        var job = new Job(request, key);
        lock (gate)
        {
            if (stopped) throw new InvalidOperationException("アプリを終了しています。");
            if (jobs.Any(j => j.Key == key && j.State is not ("failed" or "cancelled")))
                throw new InvalidOperationException("この動画は保存待ちに追加済み、または保存済みです。");
            jobs.Add(job); pending.Enqueue(job);
        }
        StartPending();
        return job.Id;
    }

    public void Pause() { lock (gate) paused = true; Changed?.Invoke(); }
    public void Resume() { lock (gate) paused = false; StartPending(); }
    public void Cancel(Guid id)
    {
        Job? job;
        lock (gate)
        {
            job = jobs.FirstOrDefault(j => j.Id == id && !j.Completion.Task.IsCompleted);
            if (job is null) return;
            if (job.State == "waiting")
            {
                job.State = "cancelled"; job.Message = "キャンセルしました。"; job.Completion.TrySetResult();
            }
        }
        job.Cancellation.Cancel();
        Changed?.Invoke();
    }

    public Task WhenIdleAsync() { lock (gate) return Task.WhenAll(jobs.Select(j => j.Completion.Task)); }
    public async Task StopAsync()
    {
        Guid[] ids;
        lock (gate) { stopped = true; ids = jobs.Select(j => j.Id).ToArray(); }
        foreach (var id in ids) Cancel(id);
        await WhenIdleAsync();
    }

    private void StartPending()
    {
        List<Job> start = [];
        lock (gate)
        {
            while (!stopped && !paused && running < 2 && pending.TryDequeue(out var job))
            {
                if (job.Completion.Task.IsCompleted) continue;
                job.State = "running"; job.Message = "ダウンロードを準備しています…";
                running++; start.Add(job);
            }
        }
        Changed?.Invoke();
        foreach (var job in start) _ = RunAsync(job);
    }

    private async Task RunAsync(Job job)
    {
        try
        {
            var request = job.Request;
            var path = await downloader.DownloadAsync(request.Url, request.Video, request.Quality, request.Destination,
                new JobProgress(value =>
                {
                    lock (gate)
                    {
                        if (job.Completion.Task.IsCompleted || job.Cancellation.IsCancellationRequested) return;
                        job.Percent = value.Percent; job.Message = value.Message;
                    }
                    Changed?.Invoke();
                }), job.Cancellation.Token, request.Title);
            lock (gate) { job.State = "completed"; job.Percent = 100; job.Message = "保存しました。"; job.SavedPath = path; }
        }
        catch (OperationCanceledException)
        { lock (gate) { job.State = "cancelled"; job.Message = "キャンセルしました。"; } }
        catch (DownloadAccessException e)
        { lock (gate) { paused = true; job.State = "failed"; job.Message = e.Message; } }
        catch (Exception e)
        {
            lock (gate)
            {
                job.State = "failed";
                job.Message = e is ArgumentException or InvalidOperationException or FileNotFoundException or TimeoutException
                    ? e.Message : e is IOException or UnauthorizedAccessException
                    ? "保存先への書き込みに失敗しました。空き容量・権限を確認してください。" : "取得に失敗しました。投稿を再解析してください。";
            }
        }
        finally
        {
            lock (gate) { running--; job.Completion.TrySetResult(); }
            StartPending();
        }
    }

    private sealed class Job(DownloadRequest request, string key)
    {
        public Guid Id { get; } = Guid.NewGuid();
        public DownloadRequest Request { get; } = request;
        public string Key { get; } = key;
        public string State { get; set; } = "waiting";
        public double? Percent { get; set; }
        public string Message { get; set; } = "順番を待っています。";
        public string? SavedPath { get; set; }
        public CancellationTokenSource Cancellation { get; } = new();
        public TaskCompletionSource Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private sealed class JobProgress(Action<DownloadProgress> action) : IProgress<DownloadProgress>
    { public void Report(DownloadProgress value) => action(value); }
}

public sealed class DownloadAccessException(string message) : InvalidOperationException(message);

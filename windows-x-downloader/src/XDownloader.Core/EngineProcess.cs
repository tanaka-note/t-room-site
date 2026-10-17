using System.Diagnostics;
using System.Text;

namespace XDownloader.Core;

public sealed record EngineResult(int ExitCode, string Output, string Error);

public interface IEngineProcess
{
    Task<EngineResult> RunAsync(string executable, IReadOnlyList<string> arguments, string workingDirectory,
        TimeSpan timeout, Action<string>? onOutput, CancellationToken cancellationToken);
}

public sealed class EngineProcess : IEngineProcess
{
    public async Task<EngineResult> RunAsync(string executable, IReadOnlyList<string> arguments, string workingDirectory,
        TimeSpan timeout, Action<string>? onOutput, CancellationToken cancellationToken)
    {
        using var deadline = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = workingDirectory
        };
        // No user config, proxy credentials, browser cookies, plugins or shell invocation.
        start.Environment["PYTHONIOENCODING"] = "utf-8";
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start };
        cancellationToken.ThrowIfCancellationRequested();
        if (!process.Start()) throw new InvalidOperationException("動画エンジンを起動できませんでした。");
        // The OS closes this job on an app crash too, terminating the engine and its descendants.
        using var job = OperatingSystem.IsWindows() ? WindowsProcessJob.Attach(process) : null;
        using var registration = linked.Token.Register(() =>
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        });
        var output = new StringBuilder();
        var error = new StringBuilder();
        async Task ReadAsync(StreamReader reader, StringBuilder target, int limit, Action<string>? callback)
        {
            while (await reader.ReadLineAsync(linked.Token) is { } line)
            {
                if (target.Length + line.Length > limit)
                {
                    try { process.Kill(true); } catch (InvalidOperationException) { }
                    throw new InvalidOperationException("動画情報が上限を超えました。この投稿には対応していません。");
                }
                target.AppendLine(line);
                callback?.Invoke(line);
            }
        }
        var readOutput = ReadAsync(process.StandardOutput, output, 16 * 1024 * 1024, onOutput);
        var readError = ReadAsync(process.StandardError, error, 256 * 1024, null);
        try
        {
            await Task.WhenAll(process.WaitForExitAsync(linked.Token), readOutput, readError);
            linked.Token.ThrowIfCancellationRequested();
            return new(process.ExitCode, output.ToString(), error.ToString());
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("処理が制限時間を超えました。通信状況を確認して再試行してください。");
        }
        finally
        {
            if (!process.HasExited)
            {
                try { process.Kill(true); } catch (InvalidOperationException) { }
            }
            // Ensure the child has released files before callers clean up a job directory.
            await process.WaitForExitAsync(CancellationToken.None);
        }
    }
}

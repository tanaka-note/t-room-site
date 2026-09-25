using System.Diagnostics;

namespace Tlain.Downloader2.Core;

public sealed record ToolInfo(string Name, string? Path, string? Version, bool Available);

public sealed class ToolLocator(string? baseDirectory = null)
{
    private readonly string toolsDirectory = Path.Combine(baseDirectory ?? AppContext.BaseDirectory, "tools");

    public string? Find(string name)
    {
        var names = OperatingSystem.IsWindows() ? new[] { $"{name}.exe", name } : new[] { name };
        foreach (var candidate in names.Select(item => Path.Combine(toolsDirectory, item))) if (File.Exists(candidate)) return candidate;
        return null;
    }

    public async Task<ToolInfo> StatusAsync(string name, CancellationToken cancellationToken = default)
    {
        var path = Find(name);
        if (path is null) return new(name, null, null, false);
        var start = new ProcessStartInfo(path) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("--version");
        using var process = Process.Start(start);
        if (process is null) return new(name, path, null, false);
        var output = await process.StandardOutput.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        var error = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        var version = (output + " " + error).Trim().Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
        return new(name, path, version, process.ExitCode == 0);
    }
}

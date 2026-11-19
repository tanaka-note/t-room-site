using System.Diagnostics;
using System.Text.Json;

internal sealed record OperationResult(bool Succeeded, string? Error);

/// <summary>Provider-originated I/O bypasses its notifications, so operations run in a separate process.</summary>
internal static class FixtureClient
{
    public static OperationResult Run(string command)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("$ErrorActionPreference='Stop'; try { " + command
            + "; @{Succeeded=$true;Error=$null}|ConvertTo-Json -Compress } catch { "
            + "@{Succeeded=$false;Error=('0x{0:X8}' -f $_.Exception.GetBaseException().HResult)}|ConvertTo-Json -Compress }");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the isolated client.");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(20000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException("The isolated client did not complete.");
        }
        if (process.ExitCode != 0 || !string.IsNullOrWhiteSpace(errors.GetAwaiter().GetResult()))
            throw new InvalidOperationException("The isolated client failed.");
        return JsonSerializer.Deserialize<OperationResult>(output.GetAwaiter().GetResult())
            ?? throw new InvalidDataException("The isolated client returned an invalid result.");
    }

    public static string PathArgument(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var parent = Directory.GetParent(fullPath) ?? throw new ArgumentException("The fixture path has no parent.");
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
        var fixtureRoot = parent;
        while (fixtureRoot.Parent is not null && !fixtureRoot.Name.StartsWith("tcloud-cfapi-", StringComparison.Ordinal))
        {
            if (fixtureRoot.LinkTarget is not null) throw new ArgumentException("The client cannot traverse links.");
            fixtureRoot = fixtureRoot.Parent;
        }
        if (!fullPath.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
            || !fixtureRoot.Name.StartsWith("tcloud-cfapi-", StringComparison.Ordinal)
            || fixtureRoot.Parent?.FullName != Path.TrimEndingDirectorySeparator(temporaryRoot)
            || fixtureRoot.LinkTarget is not null || new FileInfo(fullPath).LinkTarget is not null)
            throw new ArgumentException("The client requires an owned temporary fixture.");
        return "'" + fullPath.Replace("'", "''", StringComparison.Ordinal) + "'";
    }
}

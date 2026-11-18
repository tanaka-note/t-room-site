using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

/// <summary>Exercises reads in a real consumer process, independently of the Cloud Files provider.</summary>
internal static class HydrationProbe
{
    public static async Task<HydrationResult> ReadAsync(string path, byte[] expected)
    {
        var reads = new long[] { expected.Length - 1107, 8191, 1024 * 1024 + 3, 0 }
            .Select(offset => new ReadRange(offset, Convert.ToHexString(SHA256.HashData(expected.AsSpan((int)offset, 1000))))).ToArray();
        var plan = new ReadPlan(expected.Length, Convert.ToHexString(SHA256.HashData(expected)), reads);
        var start = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "TCloud.Sync.Tests.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add("--hydrate-fixture");
        start.ArgumentList.Add(path);
        using var child = Process.Start(start) ?? throw new IOException("Could not start the isolated read client.");
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        await child.StandardInput.WriteAsync(JsonSerializer.Serialize(plan));
        child.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await child.WaitForExitAsync(timeout.Token); }
        catch { child.Kill(entireProcessTree: true); throw; }
        _ = await error;
        if (child.ExitCode != 0) throw new IOException($"The read client exited with 0x{child.ExitCode:X8}.");
        return JsonSerializer.Deserialize<HydrationResult>(await output) ?? throw new InvalidDataException("Invalid read client result.");
    }

    public static async Task RunClientAsync(string path)
    {
        var stage = "validate";
        try
        {
            var fullPath = Path.GetFullPath(path);
            _ = FixtureClient.PathArgument(fullPath);
            if (Path.GetFileName(fullPath) != "fixture.bin") throw new ArgumentException("Only the synthetic read fixture is supported.");
            var input = await Console.In.ReadToEndAsync();
            if (input.Length > 10000) throw new InvalidDataException("Read plan too large.");
            var plan = JsonSerializer.Deserialize<ReadPlan>(input) ?? throw new InvalidDataException("Missing read plan.");
            if (plan.Length is < 2048 or > 16 * 1024 * 1024 || plan.Hash.Length != 64 || plan.Ranges.Length != 4)
                throw new InvalidDataException("Invalid read plan.");
            stage = "open-async-random";
            await using (var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096,
                FileOptions.Asynchronous | FileOptions.RandomAccess))
            {
                foreach (var range in plan.Ranges)
                {
                    if (range.Offset < 0 || range.Offset > plan.Length - 1000 || range.Hash.Length != 64)
                        throw new InvalidDataException("Invalid range.");
                    stage = "read-at-" + range.Offset;
                    stream.Position = range.Offset;
                    var bytes = new byte[1000];
                    await stream.ReadExactlyAsync(bytes);
                    if (Convert.ToHexString(SHA256.HashData(bytes)) != range.Hash) throw new InvalidDataException("Random read differs.");
                }
            }
            stage = "read-complete";
            var complete = await File.ReadAllBytesAsync(fullPath);
            if (complete.LongLength != plan.Length || Convert.ToHexString(SHA256.HashData(complete)) != plan.Hash)
                throw new InvalidDataException("Complete content differs.");
            Console.WriteLine(JsonSerializer.Serialize(new HydrationResult(true, "verified", 0)));
        }
        catch (Exception error)
        {
            // Synthetic fixture diagnostics only; never echo file contents or the input hashes.
            Console.WriteLine(JsonSerializer.Serialize(new HydrationResult(false, stage, error.HResult)));
        }
    }

    internal sealed record ReadRange(long Offset, string Hash);
    internal sealed record ReadPlan(long Length, string Hash, ReadRange[] Ranges);
}

internal sealed record HydrationResult(bool Succeeded, string Stage, int HResult);

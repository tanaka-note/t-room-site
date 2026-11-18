using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

/// <summary>Exercises reads in a real consumer process, independently of the Cloud Files provider.</summary>
internal static class HydrationProbe
{
    public static async Task<HydrationResult> ReadAsync(string path, byte[] expected)
    {
        var offsets = new long[] { expected.Length - 1107, 8191, 1024 * 1024 + 3, 0 };
        if (expected.Length > 8 * 1024 * 1024 + 1000) offsets = [.. offsets, 8 * 1024 * 1024 - 17, 8 * 1024 * 1024 + 3];
        var reads = offsets
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
        catch (OperationCanceledException)
        {
            child.Kill(entireProcessTree: true);
            using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await child.WaitForExitAsync(shutdown.Token);
            _ = await output;
            _ = await error;
            return new(false, "consumer-timeout", unchecked((int)0x800705B4));
        }
        _ = await error;
        if (child.ExitCode != 0) throw new IOException($"The read client exited with 0x{child.ExitCode:X8}.");
        return JsonSerializer.Deserialize<HydrationResult>(await output) ?? throw new InvalidDataException("Invalid read client result.");
    }

    public static async Task RunClientAsync(string path)
    {
        var stage = "validate";
        ReadPlan? validatedPlan = null;
        try
        {
            var fullPath = Path.GetFullPath(path);
            _ = FixtureClient.PathArgument(fullPath);
            if (Path.GetFileName(fullPath) != "fixture.bin") throw new ArgumentException("Only the synthetic read fixture is supported.");
            var input = await Console.In.ReadToEndAsync();
            if (input.Length > 10000) throw new InvalidDataException("Read plan too large.");
            var plan = JsonSerializer.Deserialize<ReadPlan>(input) ?? throw new InvalidDataException("Missing read plan.");
            if (plan.Length is < 2048 or > 64 * 1024 * 1024 || plan.Hash.Length != 64 || plan.Ranges.Length is not (4 or 6))
                throw new InvalidDataException("Invalid read plan.");
            validatedPlan = plan;
            stage = "open-async-random";
            await using (var stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096,
                FileOptions.Asynchronous | FileOptions.RandomAccess))
            {
                foreach (var range in plan.Ranges)
                {
                    if (range.Offset < 0 || range.Offset > plan.Length - 1000 || range.Hash.Length != 64)
                        throw new InvalidDataException("Invalid range.");
                    stage = "seek-to-" + range.Offset;
                    stream.Position = range.Offset;
                    stage = "read-at-" + range.Offset;
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
            var recovery = "not-attempted";
            var native = "not-attempted";
            if (validatedPlan is not null)
            {
                try
                {
                    using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, FileOptions.Asynchronous);
                    var head = new byte[1000];
                    var count = await RandomAccess.ReadAsync(handle, head, 0);
                    recovery = count == head.Length && Convert.ToHexString(SHA256.HashData(head)) == validatedPlan.Ranges.Single(range => range.Offset == 0).Hash
                        ? "async-native-head-verified" : "async-native-head-differs";
                }
                catch (Exception retryError) { recovery = $"async-native-head-0x{retryError.HResult:X8}"; }
                try
                {
                    var head = NativeReadProbe.ReadHead(path);
                    native = Convert.ToHexString(SHA256.HashData(head)) == validatedPlan.Ranges.Single(range => range.Offset == 0).Hash
                        ? "event-head-verified" : "event-head-differs";
                }
                catch (System.ComponentModel.Win32Exception nativeError) { native = $"event-head-error-{nativeError.NativeErrorCode}"; }
                catch (Exception nativeError) { native = $"event-head-0x{nativeError.HResult:X8}"; }
            }
            Console.WriteLine(JsonSerializer.Serialize(new HydrationResult(false, stage + "; " + recovery + "; " + native, error.HResult)));
        }
    }

    internal sealed record ReadRange(long Offset, string Hash);
    internal sealed record ReadPlan(long Length, string Hash, ReadRange[] Ranges);
}

internal sealed record HydrationResult(bool Succeeded, string Stage, int HResult);

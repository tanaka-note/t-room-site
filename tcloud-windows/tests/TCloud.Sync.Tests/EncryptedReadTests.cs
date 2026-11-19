using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class EncryptedReadTests
{
    public static async Task PinnedReads()
    {
        using var fixture = new CipherFixture();
        await using var reader = fixture.Reader();
        var tail = new byte[20];
        Check(await reader.ReadAsync(fixture.Plain.Length - 2, tail) == 2 && tail.AsSpan(0, 2).SequenceEqual(fixture.Plain.AsSpan(^2)), "EOF tail");
        var boundary = new byte[20];
        Check(await reader.ReadAsync(4090, boundary) == boundary.Length && boundary.AsSpan().SequenceEqual(fixture.Plain.AsSpan(4090, 20)), "cross-chunk random read");
        var calls = fixture.Calls;
        Check(await reader.ReadAsync(4097, new byte[1]) == 1 && fixture.Calls == calls, "verified chunk reused without another request");
        var all = new byte[fixture.Plain.Length];
        Check(await reader.ReadAsync(0, all) == all.Length && all.AsSpan().SequenceEqual(fixture.Plain), "complete original matches");
        Check(reader.EntityTag == "\"version-1\"" && fixture.PinnedRequestSeen, "later ranges carry the initial version");
        Check(await reader.ReadAsync(long.MaxValue, new byte[2]) == 0, "past EOF sends no request");
    }

    public static async Task ChangedOrDamaged()
    {
        using var changed = new CipherFixture { ChangeAfterFirst = true };
        await using (var reader = changed.Reader())
        {
            var output = new byte[5000];
            await Throws<IOException>(async () => { _ = await reader.ReadAsync(0, output); });
            Check(output.All(value => value == 0), "partial plaintext cleared after version conflict");
        }
        using var damaged = new CipherFixture { Damage = true };
        await using (var reader = damaged.Reader())
        {
            var output = new byte[5000];
            await Throws<CryptographicException>(async () => { _ = await reader.ReadAsync(0, output); });
            Check(output.All(value => value == 0), "damaged GCM chunk never exposed");
        }
        using var valid = new CipherFixture();
        await using var pinned = new EncryptedFileReader(valid.Layout, valid.Key, valid, "\"another-version\"");
        await Throws<IOException>(async () => { _ = await pinned.ReadAsync(0, new byte[10]); });
        Check(!CiphertextEntityTag.IsStrong("W/\"weak\"") && !CiphertextEntityTag.IsStrong("*"), "weak versions rejected");
        try { new EncryptedFileLayout(1, 4096, 2, 65).Validate(); throw new Exception("Invalid layout was accepted."); }
        catch (InvalidDataException) { }
    }

    public static async Task HttpRanges()
    {
        foreach (var mode in new[] { "valid", "whole-response", "wrong-range", "wrong-version", "weak-version", "short", "long", "unauthorized" })
        {
            using var client = new HttpClient(new RangeHandler(request =>
            {
                Check(request.Method == HttpMethod.Get && request.RequestUri == new Uri(WindowsPasskey.Origin + "/cloud/api/files/42/download"), "fixed authenticated endpoint");
                Check(request.Headers.GetValues("X-TCloud-Session").Single() == "fixture-context", "same session context");
                Check(request.Headers.Range?.ToString() == "bytes=8-15" && request.Headers.IfMatch.Single().Tag == "\"version-1\"", "range and pinned If-Match");
                var response = new HttpResponseMessage(mode == "whole-response" ? HttpStatusCode.OK
                    : mode == "unauthorized" ? HttpStatusCode.Unauthorized : HttpStatusCode.PartialContent)
                { Content = new ByteArrayContent(new byte[mode == "short" ? 7 : mode == "long" ? 9 : 8]) };
                response.Headers.ETag = EntityTagHeaderValue.Parse(mode == "wrong-version" ? "\"version-2\"" : mode == "weak-version" ? "W/\"version-1\"" : "\"version-1\"");
                response.Content.Headers.ContentRange = new ContentRangeHeaderValue(mode == "wrong-range" ? 7 : 8, 15, 100);
                response.Content.Headers.ContentLength = 8;
                return response;
            }));
            client.DefaultRequestHeaders.Add("X-TCloud-Session", "fixture-context");
            var source = new CloudContentSource(client, 42, 100);
            if (mode == "valid") Check((await source.ReadAsync(8, 8, "\"version-1\"", default)).Ciphertext.Length == 8, "exact ciphertext range");
            else await Throws<Exception>(async () => { _ = await source.ReadAsync(8, 8, "\"version-1\"", default); });
        }
    }

    public static async Task Cancellation()
    {
        using var fixture = new CipherFixture { WaitForCancellation = true };
        var reader = fixture.Reader();
        var pending = reader.ReadAsync(0, new byte[10]).AsTask();
        await fixture.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await reader.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        await Throws<OperationCanceledException>(async () => { _ = await pending; });
        await Throws<ObjectDisposedException>(async () => { _ = await reader.ReadAsync(0, new byte[10]); });
    }

    private sealed class RangeHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(response(request));
    }

    private sealed class CipherFixture : IEncryptedRangeSource, IDisposable
    {
        public byte[] Plain { get; } = RandomNumberGenerator.GetBytes(8195);
        public byte[] Key { get; } = RandomNumberGenerator.GetBytes(32);
        public EncryptedFileLayout Layout { get; } = new(8195, 4096, 3, 8291);
        public int Calls { get; private set; }
        public bool ChangeAfterFirst { get; init; }
        public bool Damage { get; init; }
        public bool WaitForCancellation { get; init; }
        public bool PinnedRequestSeen { get; private set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public EncryptedFileReader Reader() => new(Layout, Key, this);
        public async ValueTask<EncryptedRangeResponse> ReadAsync(long offset, int length, string? expectedEntityTag, CancellationToken cancellationToken)
        {
            Calls++;
            PinnedRequestSeen |= expectedEntityTag == "\"version-1\"";
            Started.TrySetResult();
            if (WaitForCancellation) await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            var index = checked((int)(offset / (4096 + 32)));
            var start = index * 4096;
            var cipher = EncryptedChunks.Encrypt(Key, Plain.AsSpan(start, Math.Min(4096, Plain.Length - start)), index);
            Check(cipher.Length == length && offset == (long)index * 4128, "encrypted range matches the format");
            if (Damage) cipher[^1] ^= 1;
            return new(cipher, ChangeAfterFirst && Calls > 1 ? "\"version-2\"" : "\"version-1\"", Layout.EncryptedSizeBytes);
        }
        public void Dispose() { CryptographicOperations.ZeroMemory(Plain); CryptographicOperations.ZeroMemory(Key); }
    }

    private static async Task Throws<T>(Func<Task> run) where T : Exception
    {
        try { await run(); }
        catch (T) { return; }
        throw new Exception("Expected rejection did not occur.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
}

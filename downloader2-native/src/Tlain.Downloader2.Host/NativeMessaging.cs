using System.Buffers.Binary;
using System.Text.Json;

namespace Tlain.Downloader2.Host;

internal sealed class NativeMessaging(Stream input, Stream output)
{
    private const int MaxMessageBytes = 1024 * 1024;
    private readonly SemaphoreSlim outputGate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var prefix = new byte[4];
        var count = await ReadExactAsync(input, prefix, cancellationToken).ConfigureAwait(false);
        if (count == 0) return null;
        if (count != 4) throw new InvalidDataException("Native Messaging length prefix is incomplete.");
        var length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
        if (length is <= 0 or > MaxMessageBytes) throw new InvalidDataException("Native Messaging message size is invalid.");
        var payload = new byte[length];
        if (await ReadExactAsync(input, payload, cancellationToken).ConfigureAwait(false) != length) throw new InvalidDataException("Native Messaging message is incomplete.");
        return JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 16 });
    }

    public async Task WriteAsync(object message, CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        if (payload.Length > MaxMessageBytes) throw new InvalidDataException("Native Messaging response is too large.");
        var prefix = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(prefix, payload.Length);
        await outputGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
            await output.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally { outputGate.Release(); }
    }

    private static async Task<int> ReadExactAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (count == 0) break;
            offset += count;
        }
        return offset;
    }
}

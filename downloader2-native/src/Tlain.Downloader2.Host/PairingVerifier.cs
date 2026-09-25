using System.Net.Http.Json;
using System.Text.Json;

namespace Tlain.Downloader2.Host;

internal sealed class PairingVerifier : IDisposable
{
    private readonly Uri endpoint;
    private readonly HttpClient client;

    public PairingVerifier() : this(BuildProfile.Current.PairingEndpoint, new SocketsHttpHandler { AllowAutoRedirect = false }) { }

    internal PairingVerifier(Uri endpoint, HttpMessageHandler handler)
    {
        this.endpoint = endpoint;
        client = new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(10) };
    }

    public async Task<bool> VerifyAsync(string token, string deviceChallenge, long expiresAt, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await client.PostAsJsonAsync(endpoint, new { token, deviceChallenge }, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return false;
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(stream, new JsonDocumentOptions { MaxDepth = 8 }, cancellationToken).ConfigureAwait(false);
            var root = document.RootElement;
            return root.TryGetProperty("valid", out var valid) && valid.ValueKind == JsonValueKind.True &&
                root.TryGetProperty("expiresAt", out var expiry) && expiry.TryGetInt64(out var verifiedExpiry) && verifiedExpiry == expiresAt;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
        catch (HttpRequestException) { return false; }
        catch (JsonException) { return false; }
    }

    public void Dispose() => client.Dispose();
}

using System.Net;
using System.Net.Http.Headers;

namespace Tlain.Downloader2.Core;

public sealed class HttpTransport : IDisposable
{
    private readonly HttpClient client;

    public HttpTransport(TimeSpan? timeout = null, HttpMessageHandler? handler = null)
    {
        handler ??= new SocketsHttpHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.All, ConnectTimeout = TimeSpan.FromSeconds(15) };
        client = new HttpClient(handler, disposeHandler: true) { Timeout = timeout ?? TimeSpan.FromSeconds(100) };
    }

    public async Task<HttpResponseMessage> SendAsync(Uri uri, HttpMethod method, IReadOnlyDictionary<string, string> headers, Uri credentialOrigin, RangeHeaderValue? range, CancellationToken cancellationToken)
    {
        var current = uri;
        for (var redirects = 0; redirects <= 8; redirects++)
        {
            using var request = new HttpRequestMessage(method, current);
            HeaderPolicy.Apply(request, headers, credentialOrigin);
            request.Headers.Range = range;
            var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (!IsRedirect(response.StatusCode) || response.Headers.Location is null) return response;
            var next = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(current, response.Headers.Location);
            response.Dispose();
            current = HeaderPolicy.RequireHttpUri(next.AbsoluteUri);
        }
        throw new DownloaderException("redirect_limit", "リダイレクト回数が上限を超えました。");
    }

    private static bool IsRedirect(HttpStatusCode status) => status is HttpStatusCode.Moved or HttpStatusCode.Redirect or HttpStatusCode.RedirectMethod or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;
    public void Dispose() => client.Dispose();
}

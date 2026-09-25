using System.Reflection;
using System.Globalization;

namespace Tlain.Downloader2.Host;

internal sealed record BuildProfile(string Name, Uri PairingEndpoint)
{
    private const string ProductionEndpoint = "https://tanaka-note.com/downloader2/api/pairing/redeem";

    public static BuildProfile Current { get; } = Load();

    internal static BuildProfile CreateE2E(string endpointValue, string allowedHostsValue)
    {
        if (!Uri.TryCreate(endpointValue, UriKind.Absolute, out var endpoint) || endpoint.Scheme != Uri.UriSchemeHttps ||
            !string.IsNullOrEmpty(endpoint.UserInfo) || endpoint.PathAndQuery != "/downloader2/api/pairing/redeem")
            throw new InvalidOperationException("E2E pairing endpoint must be an exact HTTPS /downloader2/api/pairing/redeem URL.");
        var allowedHosts = allowedHostsValue.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(host => new IdnMapping().GetAscii(host).ToLowerInvariant()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (endpoint.IdnHost.Equals("tanaka-note.com", StringComparison.OrdinalIgnoreCase) || !allowedHosts.Contains(endpoint.IdnHost))
            throw new InvalidOperationException("E2E pairing endpoint must use a non-Production host in the explicit build allowlist.");
        return new("e2e", endpoint);
    }

    private static BuildProfile Load()
    {
#if DOWNLOADER2_E2E
        var metadata = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
            .ToDictionary(item => item.Key, item => item.Value ?? "", StringComparer.Ordinal);
        return CreateE2E(metadata.GetValueOrDefault("Downloader2PairingEndpoint", ""), metadata.GetValueOrDefault("Downloader2PairingAllowedHosts", ""));
#else
        return new("production", new Uri(ProductionEndpoint));
#endif
    }
}

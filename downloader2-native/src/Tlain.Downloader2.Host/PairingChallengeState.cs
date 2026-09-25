using System.Security.Cryptography;

namespace Tlain.Downloader2.Host;

internal sealed class PairingChallengeState
{
    private string? challenge;
    private long expiresAt;

    public (string Challenge, long ExpiresAt) Issue(long now)
    {
        challenge = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        expiresAt = now + 120;
        return (challenge, expiresAt);
    }

    public bool TryGet(long tokenExpiresAt, long now, out string current)
    {
        current = challenge ?? "";
        return challenge is not null && expiresAt >= now && tokenExpiresAt >= now && tokenExpiresAt <= now + 120;
    }

    public bool Consume(string expected)
    {
        if (challenge is null || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(challenge), System.Text.Encoding.UTF8.GetBytes(expected))) return false;
        challenge = null;
        expiresAt = 0;
        return true;
    }
}

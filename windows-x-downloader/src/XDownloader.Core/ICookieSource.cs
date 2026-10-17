namespace XDownloader.Core;

/// <summary>A per-operation credential file. Only its random local path reaches the engine argument list.</summary>
public interface ICookieLease : IDisposable
{
    string FilePath { get; }
}

public interface ICookieSource
{
    ICookieLease? Acquire();
}

namespace Tlain.Downloader2.Host;

internal static class Program
{
    public static async Task<int> Main()
    {
        try
        {
            using var input = Console.OpenStandardInput();
            using var output = Console.OpenStandardOutput();
            await new HostApplication(new NativeMessaging(input, output)).RunAsync(CancellationToken.None).ConfigureAwait(false);
            return 0;
        }
        catch { return 1; }
    }
}

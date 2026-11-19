using System.ComponentModel;
using System.Security.Cryptography;
using System.Text.Json;

namespace TCloud.Sync.Windows;

public enum WindowsSyncState
{
    Checking,Current,ConnectionPending,DestinationUnavailable,AuthorizationRevoked,InitialRegistrationIncomplete,StateInvalid,Stopped
}
public sealed record WindowsSyncStatus(WindowsSyncState State,DateTimeOffset? LastCompletedAt);

/// <summary>Runs under the signed-in Windows account. Transient failures never invoke a passkey or discard local state.</summary>
public sealed class WindowsSyncLoop(WindowsCatalogSynchronizer catalog,Action verifyDestination,
    Func<LocalSyncSnapshot,CancellationToken,Task> reconcile,IProgress<WindowsSyncStatus>? progress=null,
    TimeSpan? pollInterval=null,TimeSpan? retryInterval=null)
{
    private readonly TimeSpan poll=Validate(pollInterval??TimeSpan.FromSeconds(30));
    private readonly TimeSpan retry=Validate(retryInterval??TimeSpan.FromSeconds(2));
    private int running;
    private DateTimeOffset? lastCompleted;
    public async Task<WindowsSyncState> RunAsync(CancellationToken token)
    {
        if(Interlocked.Exchange(ref running,1)!=0)throw new InvalidOperationException("同期処理は既に実行中です。");
        var failures=0;
        try
        {
            while(true)
            {
                token.ThrowIfCancellationRequested();
                var destinationReady=false;
                try
                {
                    verifyDestination();destinationReady=true;
                    Report(WindowsSyncState.Checking);
                    var snapshot=await catalog.RefreshAsync(token);
                    destinationReady=false;verifyDestination();destinationReady=true;
                    await reconcile(snapshot,token);
                    lastCompleted=DateTimeOffset.UtcNow;failures=0;
                    Report(WindowsSyncState.Current);
                    await Task.Delay(poll,token);
                }
                catch(WindowsDeviceRevokedException){return Stop(WindowsSyncState.AuthorizationRevoked);}
                catch(WindowsDeviceRegistrationIncompleteException){return Stop(WindowsSyncState.InitialRegistrationIncomplete);}
                catch(OperationCanceledException)when(token.IsCancellationRequested){throw;}
                catch(Exception error)when(error is InvalidDataException or JsonException or CryptographicException or UnauthorizedAccessException)
                {return Stop(WindowsSyncState.StateInvalid);}
                catch(Exception error)when(error is IOException or HttpRequestException or Win32Exception or OperationCanceledException)
                {
                    // A catalog reset retries a fresh snapshot. A disconnected
                    // drive or transport timeout does not clear the registration,
                    // keys, saved cursor, originals, or pending local edits.
                    Report(destinationReady?WindowsSyncState.ConnectionPending:WindowsSyncState.DestinationUnavailable);
                    var milliseconds=Math.Min(60000,retry.TotalMilliseconds*Math.Pow(2,Math.Min(failures++,10)));
                    await Task.Delay(TimeSpan.FromMilliseconds(milliseconds),token);
                }
            }
        }
        catch(OperationCanceledException)when(token.IsCancellationRequested){return Stop(WindowsSyncState.Stopped);}
        finally {Volatile.Write(ref running,0);}
    }
    private void Report(WindowsSyncState state)=>progress?.Report(new(state,lastCompleted));
    private WindowsSyncState Stop(WindowsSyncState state){Report(state);return state;}
    private static TimeSpan Validate(TimeSpan interval)=>interval>=TimeSpan.FromMilliseconds(1)&&interval<=TimeSpan.FromMinutes(5)
        ?interval:throw new ArgumentOutOfRangeException(nameof(interval));
}

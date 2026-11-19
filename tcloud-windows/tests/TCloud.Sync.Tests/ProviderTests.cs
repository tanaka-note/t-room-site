using System.Security.Cryptography;
using TCloud.Sync.Core;
using TCloud.Sync.Windows;

internal static class ProviderTests
{
    public static async Task Transfer()
    {
        var outer=Path.Combine(Path.GetTempPath(),"tcloud-cfapi-"+Guid.NewGuid().ToString("N"));
        var directory=Path.Combine(outer,"mounted");Directory.CreateDirectory(directory);
        var plain=RandomNumberGenerator.GetBytes(9*1024*1024+107);var key=RandomNumberGenerator.GetBytes(32);
        CloudFilesRootRegistration? mounted=null;
        try
        {
            const int chunk=8*1024*1024;
            var first=EncryptedChunks.Encrypt(key,plain.AsSpan(0,chunk),0);
            var last=EncryptedChunks.Encrypt(key,plain.AsSpan(chunk),1);
            var ciphertext=first.Concat(last).ToArray();
            var layout=new EncryptedFileLayout(plain.Length,chunk,2,ciphertext.Length);
            var registration=new WindowsDeviceRegistration(1,Guid.NewGuid().ToString("N"),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),directory,
                VolumeInspector.ValidateDestination(directory,[]));
            mounted=CloudFilesRootRegistration.Attach(registration,[],initialize:true);
            var identity=Convert.ToHexString(SHA256.HashData(ciphertext));var fetches=0;
            using(var provider=new CloudFilesProvider(mounted,async(id,progress,token)=>
            {
                Check(id==identity,"callback uses the registered version identity");Interlocked.Increment(ref fetches);
                var complete=await OriginalStager.DownloadAsync(Path.Combine(outer,"staging"),layout,key,new CipherSource(ciphertext),progress,token);
                Check(complete.Sha256==Convert.ToHexString(SHA256.HashData(plain)),"the complete staged original matches the baseline hash");
                return complete.Body;
            }))
            {
                provider.Add("fixture.bin",plain.Length,identity);
                await provider.HydrateAsync("fixture.bin");
                var path=Path.Combine(directory,"fixture.bin");
                var read=await HydrationProbe.ReadAsync(path,plain);
                Check(read.Succeeded,$"separate consumer {read.Stage}: 0x{read.HResult:X8}; "+string.Join(",",provider.Errors.Select(e=>e.GetType().Name+":"+e.Message)));
                Check(fetches>0,"real provider fetch ran");
                var renamed=Path.Combine(directory,"renamed.bin");
                Check(FixtureClient.Run($"[System.IO.File]::Move({FixtureClient.PathArgument(path)},{FixtureClient.PathArgument(renamed)})").Succeeded,"in-root rename is allowed");
                var outside=Path.Combine(outer,"escape.bin");
                Check(!FixtureClient.Run($"[System.IO.File]::Move({FixtureClient.PathArgument(renamed)},{FixtureClient.PathArgument(outside)})").Succeeded,"move out of the managed root is refused");
                Check(!FixtureClient.Run($"[System.IO.File]::Delete({FixtureClient.PathArgument(renamed)})").Succeeded,"native original deletion is refused");
                Check(FixtureClient.Run($"[System.IO.File]::Move({FixtureClient.PathArgument(renamed)},{FixtureClient.PathArgument(path)})").Succeeded,"second in-root rename is allowed");
                Check(provider.Errors.IsEmpty,string.Join(",",provider.Errors.Select(e=>e.GetType().Name+":"+e.Message)));
            }
            Check((await HydrationProbe.ReadAsync(Path.Combine(directory,"fixture.bin"),plain)).Succeeded,"saved body needs neither the provider nor authentication");
            Check(!Directory.EnumerateFiles(Path.Combine(outer,"staging")).Any(),"the verified staging copy is released after installation; the original remains");
            mounted.UnregisterPreservingOriginals();mounted=null;
            Check(File.ReadAllBytes(Path.Combine(directory,"fixture.bin")).AsSpan().SequenceEqual(plain),"unlink leaves the original plaintext intact");
        }
        finally
        {
            mounted?.UnregisterPreservingOriginals();CryptographicOperations.ZeroMemory(plain);CryptographicOperations.ZeroMemory(key);
            Directory.Delete(outer,true);
        }
    }
    public static async Task FailedStage()
    {
        var outer=Path.Combine(Path.GetTempPath(),"tcloud-stage-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(outer);
        var key=RandomNumberGenerator.GetBytes(32);var plain=RandomNumberGenerator.GetBytes(8195);
        try
        {
            var cipher=EncryptedChunks.Encrypt(key,plain.AsSpan(0,4096),0)
                .Concat(EncryptedChunks.Encrypt(key,plain.AsSpan(4096,4096),1))
                .Concat(EncryptedChunks.Encrypt(key,plain.AsSpan(8192),2)).ToArray();
            cipher[^1]^=1;
            try {await using var unexpected=await OriginalStager.DownloadAsync(outer,new(plain.Length,4096,3,cipher.Length),key,new CipherSource(cipher));throw new InvalidOperationException("Corrupt original was exposed");}
            catch(CryptographicException) { }
            Check(!Directory.EnumerateFiles(outer).Any(),"a late authentication failure exposes no partial original and releases its staging file");
            using var cancel=new CancellationTokenSource();cancel.Cancel();
            try {await using var unexpected=await OriginalStager.DownloadLegacyAsync(outer,cipher.Length,new CipherSource(cipher),token:cancel.Token);throw new InvalidOperationException("Canceled original was exposed");}
            catch(OperationCanceledException) { }
            Check(!Directory.EnumerateFiles(outer).Any(),"cancellation never publishes a partial file");
        }
        finally {CryptographicOperations.ZeroMemory(key);CryptographicOperations.ZeroMemory(plain);Directory.Delete(outer,true);}
    }
    private sealed class CipherSource(byte[] value):IEncryptedRangeSource
    {
        public ValueTask<EncryptedRangeResponse> ReadAsync(long offset,int length,string? expectedEntityTag,CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Check(expectedEntityTag is null or "\"immutable-ciphertext\"","version pinned across chunk requests");
            return ValueTask.FromResult(new EncryptedRangeResponse(value.AsSpan((int)offset,length).ToArray(),"\"immutable-ciphertext\"",value.Length));
        }
    }
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
}

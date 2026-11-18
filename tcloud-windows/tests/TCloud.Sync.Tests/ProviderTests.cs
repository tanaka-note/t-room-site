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
            mounted=CloudFilesRootRegistration.Attach(registration,[]);
            var identity=Convert.ToHexString(SHA256.HashData(ciphertext));var fetches=0;
            using(var provider=new CloudFilesProvider(mounted,async(id,progress,token)=>
            {
                Check(id==identity,"callback uses the registered version identity");Interlocked.Increment(ref fetches);
                await using var reader=new EncryptedFileReader(layout,key,new CipherSource(ciphertext));
                var complete=new byte[plain.Length];
                Check(await reader.ReadAsync(0,complete,token)==plain.Length,"all encrypted chunks are authenticated before exposure");
                progress.Report(plain.Length);return new MemoryStream(complete,writable:false);
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
            mounted.UnregisterPreservingOriginals();mounted=null;
            Check(File.ReadAllBytes(Path.Combine(directory,"fixture.bin")).AsSpan().SequenceEqual(plain),"unlink leaves the original plaintext intact");
        }
        finally
        {
            mounted?.UnregisterPreservingOriginals();CryptographicOperations.ZeroMemory(plain);CryptographicOperations.ZeroMemory(key);
            Directory.Delete(outer,true);
        }
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

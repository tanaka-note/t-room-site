using System.Security.Cryptography;
using TCloud.Sync.Windows;

internal static class LocalSnapshotTests
{
    public static async Task Capture()
    {
        var directory=Path.Combine(Path.GetTempPath(),"tcloud-snapshot-test-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        var original=Path.Combine(directory,"saved.bin");var staging=Path.Combine(directory,"staging");
        var plain=RandomNumberGenerator.GetBytes(3*1024*1024+17);
        try
        {
            await File.WriteAllBytesAsync(original,plain);
            await using(var copy=await LocalOriginalSnapshot.CaptureAsync(original,staging))
            {
                Check(copy.Sha256==Convert.ToHexString(SHA256.HashData(plain)),"local snapshot hashes one complete save");
                var read=new byte[plain.Length];await copy.Body.ReadExactlyAsync(read);
                Check(read.AsSpan().SequenceEqual(plain),"staged bytes match the saved body");
                await File.WriteAllTextAsync(original,"new save after snapshot");
                copy.Body.Position=0;await copy.Body.ReadExactlyAsync(read);
                Check(read.AsSpan().SequenceEqual(plain),"a later save cannot mutate the upload snapshot");
            }
            await File.WriteAllBytesAsync(original,plain);
            var changed=false;
            try
            {
                await using var unexpected=await LocalOriginalSnapshot.CaptureAsync(original,staging,new InlineProgress(_=>
                {
                    if(changed)return;changed=true;
                    using var writer=new FileStream(original,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete);
                    writer.Write("changed during copy"u8);writer.Flush(flushToDisk:true);
                }));
                throw new InvalidOperationException("A racing save was accepted as a stable snapshot");
            }
            catch(IOException) { }
            Check(changed,"the synthetic writer actually ran during the snapshot");
            await File.WriteAllBytesAsync(original,plain);
            using(var existingReader=new FileStream(original,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
            {
                await using(var shared=await LocalOriginalSnapshot.CaptureAsync(original,staging))
                    Check(shared.Sha256==Convert.ToHexString(SHA256.HashData(plain)),"an existing reader does not prevent a stable shared snapshot");
                changed=false;
                try {
                    await using var shared=await LocalOriginalSnapshot.CaptureAsync(original,staging,new InlineProgress(_=>
                    {
                        if(changed)return;changed=true;
                        using var writer=new FileStream(original,FileMode.Open,FileAccess.Write,FileShare.ReadWrite|FileShare.Delete);
                        writer.Write("changed while another reader remained open"u8);writer.Flush(flushToDisk:true);
                    }));
                    throw new InvalidOperationException("A racing write through the shared-reader path was accepted");
                }catch(IOException) { }
                Check(changed,"the shared-reader path actually encountered a concurrent writer");
            }
            Check(!Directory.EnumerateFiles(staging).Any(),"failed upload preparation leaves no staged partial copy");
            Check(File.Exists(original),"snapshot preparation never deletes or rewrites the user's original");
        }
        finally {CryptographicOperations.ZeroMemory(plain);Directory.Delete(directory,true);}
    }
    private sealed class InlineProgress(Action<long> report):IProgress<long>{public void Report(long value)=>report(value);}
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
}

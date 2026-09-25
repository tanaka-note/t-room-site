using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Tlain.Downloader2.Core;

public sealed record DefenderResult(bool Available, bool MalwareDetected, string? Warning);

public interface IDefenderScanner
{
    Task<DefenderResult> ScanAsync(string path, CancellationToken cancellationToken);
}

public sealed class DefenderScanner : IDefenderScanner
{
    public async Task<DefenderResult> ScanAsync(string path, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) return new(false, false, "Windows Defenderによる追加検査は利用できません。");
        var safePath = Convert.ToBase64String(Encoding.UTF8.GetBytes(Path.GetFullPath(path)));
        var script = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + safePath + "'));$s=Get-Date;" +
            "try{Start-MpScan -ScanType CustomScan -ScanPath $p -ErrorAction Stop;" +
            "$hit=@(Get-MpThreatDetection -ErrorAction SilentlyContinue|?{$_.InitialDetectionTime -ge $s.AddSeconds(-2) -and ($_.Resources -join ' ') -like ('*'+$p+'*')});" +
            "@{available=$true;malware=($hit.Count -gt 0)}|ConvertTo-Json -Compress}catch{@{available=$false;malware=$false}|ConvertTo-Json -Compress}";
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var start = new ProcessStartInfo("powershell.exe") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded }) start.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(start);
            if (process is null) return new(false, false, "Windows Defenderによる追加検査は利用できません。");
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            _ = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            using var document = JsonDocument.Parse(output);
            var available = document.RootElement.GetProperty("available").GetBoolean();
            var malware = document.RootElement.GetProperty("malware").GetBoolean();
            return new(available, malware, available ? null : "Windows Defenderによる追加検査は利用できません。");
        }
        catch (Exception error) when (error is not OperationCanceledException) { return new(false, false, "Windows Defenderによる追加検査は利用できません。"); }
    }
}

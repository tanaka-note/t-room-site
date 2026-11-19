$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.buildId -cnotmatch '^[a-f0-9]{64}$' -or $manifest.files.Count -lt 1) { throw 'Invalid T-Cloud package manifest.' }
$payloadRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'payload'))
$appBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'TCloud\Windows\app'))
$installDirectory = [IO.Path]::GetFullPath((Join-Path $appBase $manifest.buildId))
if (-not $installDirectory.StartsWith($appBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation directory.' }
foreach ($base in @($payloadRoot, $installDirectory)) {
    $current = [IO.DirectoryInfo]::new($base)
    while ($null -ne $current) {
        if ($current.Exists -and (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Installation through a link is not supported.' }
        $current = $current.Parent
    }
}
foreach ($file in $manifest.files) {
    if ($file.path -match '(^|[/\\])\.\.?([/\\]|$)|:|^[/\\]' -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid package path.' }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $payloadRoot $file.path))
    if (-not $sourcePath.StartsWith($payloadRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escaped its root.' }
    if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Package verification failed.' }
}
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
foreach ($file in $manifest.files) {
    $targetPath = [IO.Path]::GetFullPath((Join-Path $installDirectory $file.path))
    if (-not $targetPath.StartsWith($installDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installed file path.' }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($targetPath)) -Force | Out-Null
    if (-not (Test-Path -LiteralPath $targetPath)) { Copy-Item -LiteralPath (Join-Path $payloadRoot $file.path) -Destination $targetPath }
    if ((Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw 'Installed package verification failed.' }
}
# Request a graceful exit. Pending transfers are journaled and all HDD bodies remain.
$running = Get-CimInstance Win32_Process -Filter "Name='TCloud.Sync.Host.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appBase + '\', [StringComparison]::OrdinalIgnoreCase) }
foreach ($process in $running) {
    Start-Process -FilePath $process.ExecutablePath -ArgumentList '--quit' -WindowStyle Hidden -Wait
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    while ((Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw 'T-Cloud is still finishing a transfer. Run the installer again after exiting it.' }
}
$installedHost = Join-Path $installDirectory 'TCloud.Sync.Host.exe'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'T-Cloud HDD同期.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $installedHost
$shortcut.WorkingDirectory = $installDirectory
$shortcut.Save()
if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'TCloud\Windows\device.dat')) {
    Start-Process -FilePath $installedHost -ArgumentList '--background' -WindowStyle Hidden
} else {
    # Initial enrollment requires the user's visible Windows Hello dialog.
    Start-Process -FilePath $installedHost -WindowStyle Normal
}
Write-Output 'T-Cloud HDD同期をインストールしました。'

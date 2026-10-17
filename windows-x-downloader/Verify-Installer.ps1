param([Parameter(Mandatory = $true)][string]$SetupPath)
$ErrorActionPreference = 'Stop'
$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$expectedHash = (Get-Content -LiteralPath "$SetupPath.sha256" -Raw).Split(' ')[0]
if ($expectedHash -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash -ine $expectedHash) { throw 'Setup integrity check failed.' }
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{72050252-5A9C-49C7-B73B-71A7DC8E1F45}_is1'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'X動画ダウンローダー.lnk'
# Never disturb an existing personal installation or shortcut.
if (Test-Path -LiteralPath $registryPath) { throw 'An installed app already exists. Use a clean Windows user for installer verification.' }
if (Test-Path -LiteralPath $desktopLink) { throw 'A desktop shortcut already exists. Use a clean Windows user for installer verification.' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('x-downloader-installer-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot '日本語のインストール先 with spaces'
$groupName = 'X動画ダウンローダー'
$groupDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) $groupName
if (Test-Path -LiteralPath $groupDirectory) { throw 'An app Start Menu folder already exists. Use a clean Windows user for installer verification.' }
$settingsRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'XVideoDownloader'
$settingsExisted = Test-Path -LiteralPath $settingsRoot
$preservedData = Join-Path $settingsRoot ('installer-verify-' + [guid]::NewGuid().ToString('N') + '.txt')
$preservedFile = Join-Path $installDirectory 'user-created-video.mp4'
$uninstaller = Join-Path $installDirectory 'unins000.exe'
$mutex = $null
$shell = $null

function Invoke-CheckedProcess([string]$Executable, [string[]]$Arguments, [switch]$ExpectBlocked) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(60000)) { throw "Installer verification process timed out: $([IO.Path]::GetFileName($Executable))" }
    if ($ExpectBlocked) {
        if ($process.ExitCode -eq 0) { throw 'An install/uninstall was allowed while the app mutex existed.' }
    }
    elseif ($process.ExitCode -ne 0) { throw "Installer verification process failed: $($process.ExitCode)" }
}
function Assert-File([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Expected installed file: $Path" }
}
function Assert-Shortcut([string]$Path) {
    Assert-File $Path
    $link = $shell.CreateShortcut($Path)
    if ($link.TargetPath -ine (Join-Path $installDirectory 'XDownloader.exe') -or $link.WorkingDirectory -ine $installDirectory) {
        throw "Incorrect shortcut target: $Path"
    }
}
function Remove-TestRoot {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notmatch '^x-downloader-installer-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $settingsRoot -Force | Out-Null
    [IO.File]::WriteAllText($preservedData, 'synthetic-preservation-marker')
    $setupArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', ('/DIR="{0}"' -f $installDirectory), '/TASKS=desktopicon')
    $uninstallArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    Invoke-CheckedProcess $SetupPath $setupArgs
    $shell = New-Object -ComObject WScript.Shell
    Assert-File (Join-Path $installDirectory 'XDownloader.exe')
    Assert-File (Join-Path $installDirectory 'README.md')
    Assert-File (Join-Path $installDirectory 'THIRD-PARTY.md')
    Assert-File $uninstaller
    foreach ($binary in 'yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe') {
        $installed = Join-Path $installDirectory "tools/$binary"
        Assert-File $installed
        $source = Join-Path $PSScriptRoot "tools/$binary"
        if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $source).Hash) { throw "Changed engine binary: $binary" }
    }
    Assert-Shortcut $desktopLink
    Assert-Shortcut (Join-Path $groupDirectory 'X動画ダウンローダー.lnk')
    [xml]$project = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'src/XDownloader.App/XDownloader.App.csproj') -Raw
    $expectedVersion = [string]$project.Project.PropertyGroup.Version
    if ((Get-Item -LiteralPath (Join-Path $installDirectory 'XDownloader.exe')).VersionInfo.ProductVersion -notlike "$expectedVersion*") { throw 'Installed executable version mismatch.' }
    if ((Get-ItemProperty -LiteralPath $registryPath).DisplayVersion -ne $expectedVersion) { throw 'Uninstall registry version mismatch.' }
    Write-Host 'PASS per-user installation, Japanese/spaced path, bundled tools, shortcuts and uninstall registration'

    # The shipped app runs WebView2/DPAPI checks using only isolated synthetic data.
    Invoke-CheckedProcess (Join-Path $installDirectory 'XDownloader.exe') @('--verify-package')
    Write-Host 'PASS installed executable: offline WebView2 and DPAPI lifecycle'
    [IO.File]::WriteAllText($preservedFile, 'synthetic-user-video')
    Invoke-CheckedProcess $SetupPath $setupArgs
    Assert-File $preservedFile
    Assert-File $preservedData
    if (@(Get-ChildItem -LiteralPath $installDirectory -Filter 'unins*.exe').Count -ne 1) { throw 'Reinstallation created duplicate uninstallers.' }
    Write-Host 'PASS repeat installation keeps one uninstall entry and preserves user data'

    $mutex = [Threading.Mutex]::new($false, 'Local\XVideoDownloader.Installer.v1')
    Invoke-CheckedProcess $SetupPath $setupArgs -ExpectBlocked
    Invoke-CheckedProcess $uninstaller $uninstallArgs -ExpectBlocked
    Assert-File (Join-Path $installDirectory 'XDownloader.exe')
    $mutex.Dispose(); $mutex = $null
    Write-Host 'PASS installation/uninstallation refuse to replace files while the app is running'

    Invoke-CheckedProcess $uninstaller $uninstallArgs
    if ((Test-Path -LiteralPath $registryPath) -or (Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $groupDirectory) -or
        (Test-Path -LiteralPath (Join-Path $installDirectory 'XDownloader.exe')) -or (Test-Path -LiteralPath (Join-Path $installDirectory 'tools/yt-dlp.exe'))) {
        throw 'Uninstall left installed app files, registration or shortcuts behind.'
    }
    Assert-File $preservedFile
    Assert-File $preservedData
    Write-Host 'PASS uninstall removes app/shortcuts/registration and preserves videos and app data'
}
finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
    if ((Test-Path -LiteralPath $registryPath) -and (Test-Path -LiteralPath $uninstaller)) {
        $entry = Get-ItemProperty -LiteralPath $registryPath
        if ($entry.InstallLocation.TrimEnd('\') -ine $installDirectory) { throw 'Refusing to clean an unrelated installation.' }
        Invoke-CheckedProcess $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
    }
    if (Test-Path -LiteralPath $preservedData) { Remove-Item -LiteralPath $preservedData -Force }
    if (!$settingsExisted -and (Test-Path -LiteralPath $settingsRoot) -and !(Get-ChildItem -LiteralPath $settingsRoot -Force)) { Remove-Item -LiteralPath $settingsRoot }
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    Remove-TestRoot
}

param([string]$ToolsDirectory = (Join-Path $PSScriptRoot 'tools'))
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'tools-manifest.json') -Raw | ConvertFrom-Json
$cacheDirectory = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cacheDirectory, $ToolsDirectory | Out-Null

function Get-VerifiedDownload($Entry, [string]$FileName) {
    $target = Join-Path $cacheDirectory $FileName
    if ((Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $Entry.sha256)) { return $target }
    $partial = "$target.partial"
    Write-Host "Downloading $FileName ($($Entry.version))..."
    try {
        # Fixed official release URLs and committed SHA-256 values; never execute an unverified download.
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Entry.url -OutFile $partial -UseBasicParsing -TimeoutSec 600
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $Entry.sha256) {
            throw "SHA-256 mismatch: $FileName. No executable was installed."
        }
        Move-Item -LiteralPath $partial -Destination $target -Force
        return $target
    }
    finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
}

$yt = Get-VerifiedDownload $manifest.ytDlp 'yt-dlp.exe'
$ff = Get-VerifiedDownload $manifest.ffmpeg 'ffmpeg.zip'
$extractDirectory = Join-Path $cacheDirectory "ffmpeg-$($manifest.ffmpeg.sha256.Substring(0,12))"
if (!(Test-Path -LiteralPath $extractDirectory)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($ff, $extractDirectory)
}
$binary = @(Get-ChildItem -LiteralPath $extractDirectory -Recurse -File -Filter ffmpeg.exe)
if ($binary.Count -ne 1) { throw 'Expected exactly one ffmpeg.exe in the verified archive.' }
$binaryDirectory = $binary[0].DirectoryName
Copy-Item -LiteralPath $yt -Destination (Join-Path $ToolsDirectory 'yt-dlp.exe') -Force
Get-ChildItem -LiteralPath $binaryDirectory -File | Where-Object { $_.Extension -in '.exe','.dll' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $ToolsDirectory -Force
}
$licenseDirectory = Join-Path $ToolsDirectory 'licenses'
New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null
Get-ChildItem -LiteralPath $extractDirectory -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $licenseDirectory -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools-manifest.json') -Destination $ToolsDirectory -Force
Write-Host "Verified tools prepared: $ToolsDirectory"

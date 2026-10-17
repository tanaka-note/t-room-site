param([switch]$SkipTools)
$ErrorActionPreference = 'Stop'
$outputDirectory = Join-Path $PSScriptRoot 'dist/XDownloader'
if (!$SkipTools) { & (Join-Path $PSScriptRoot 'Prepare-Tools.ps1') }
dotnet publish (Join-Path $PSScriptRoot 'src/XDownloader.App/XDownloader.App.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $outputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'tools')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tools') -Destination $outputDirectory -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md'), (Join-Path $PSScriptRoot 'THIRD-PARTY.md') -Destination $outputDirectory -Force
Write-Host "Portable app: $(Join-Path $outputDirectory 'XDownloader.exe')"

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $projectRoot -Parent
$localProperties = Join-Path $projectRoot "local.properties"
$assetLinksPath = Join-Path $workspaceRoot ".well-known\assetlinks.json"

if (-not (Test-Path $localProperties)) { throw "local.properties is missing." }
$sdkLine = Get-Content $localProperties | Where-Object { $_ -like "sdk.dir=*" } | Select-Object -First 1
if (-not $sdkLine) { throw "sdk.dir is missing from local.properties." }
$sdk = (($sdkLine -split "=", 2)[1] -replace "\\:", ":" -replace "\\", "\")
$buildTools = Get-ChildItem (Join-Path $sdk "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) { throw "Android SDK Build Tools were not found." }

Push-Location $projectRoot
try {
    & ".\gradlew.bat" lint assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "The diary TWA build failed." }
} finally {
    Pop-Location
}

$apk = Join-Path $env:LOCALAPPDATA "TRoomDiaryTwaBuild\app\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "The signed APK was not found." }
$signingOutput = & (Join-Path $buildTools.FullName "apksigner.bat") verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed." }
$digestLine = $signingOutput | Where-Object { $_ -like "Signer #1 certificate SHA-256 digest:*" } | Select-Object -First 1
$apkDigest = (($digestLine -split ":", 2)[1]).Trim().ToUpperInvariant()
$apkFingerprint = $apkDigest -replace "(..)(?!$)", '$1:'

$assetLinks = Get-Content -Raw $assetLinksPath | ConvertFrom-Json
$statement = $assetLinks | Where-Object { $_.target.package_name -eq "jp.tanaka.troom.diary.twa" } | Select-Object -First 1
if (-not $statement) { throw "assetlinks.json does not define the diary TWA package." }
$webFingerprints = @($statement.target.sha256_cert_fingerprints | ForEach-Object { $_.ToUpperInvariant() })
if ($apkFingerprint -notin $webFingerprints) { throw "The APK certificate does not match assetlinks.json." }

$badging = & (Join-Path $buildTools.FullName "aapt.exe") dump badging $apk
if ($LASTEXITCODE -ne 0) { throw "APK metadata verification failed." }
$badgingText = $badging -join "`n"
if ($badgingText -notmatch "package: name='jp\.tanaka\.troom\.diary\.twa'") { throw "Unexpected applicationId in the APK." }
$stringsXml = [xml](Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot "app\src\main\res\values\strings.xml"))
$appName = $stringsXml.resources.string | Where-Object { $_.name -eq "app_name" } | Select-Object -First 1
$expectedAppName = "$([char]0x65E5)$([char]0x8A18)"
if ([string]$appName.'#text' -ne $expectedAppName) { throw "Unexpected application label in strings.xml." }

Write-Host "Diary TWA verification succeeded."
Write-Host "APK: $apk"
Write-Host "applicationId: jp.tanaka.troom.diary.twa"
Write-Host "Digital Asset Links: certificate matches"

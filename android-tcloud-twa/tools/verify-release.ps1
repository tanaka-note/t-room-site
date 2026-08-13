$ErrorActionPreference = "Stop"

$projectRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $projectRoot -Parent
$localProperties = Join-Path $projectRoot "local.properties"
$assetLinksPath = Join-Path $workspaceRoot ".well-known\assetlinks.json"

if (-not (Test-Path $localProperties)) {
    throw "local.properties is missing. Configure the Android SDK path first."
}

$sdkLine = Get-Content $localProperties | Where-Object { $_ -like "sdk.dir=*" } | Select-Object -First 1
if (-not $sdkLine) {
    throw "sdk.dir is missing from local.properties."
}
$sdk = (($sdkLine -split "=", 2)[1] -replace "\\:", ":" -replace "\\", "\")
$buildTools = Get-ChildItem (Join-Path $sdk "build-tools") -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) {
    throw "Android SDK Build Tools were not found."
}

Push-Location $projectRoot
try {
    & ".\gradlew.bat" lint assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "The TWA build failed." }
} finally {
    Pop-Location
}

$apk = Join-Path $env:LOCALAPPDATA "TCloudTwaBuild\app\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apk)) { throw "The signed APK was not found." }

$signingOutput = & (Join-Path $buildTools.FullName "apksigner.bat") verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed." }
$digestLine = $signingOutput | Where-Object { $_ -like "Signer #1 certificate SHA-256 digest:*" } | Select-Object -First 1
$apkDigest = (($digestLine -split ":", 2)[1]).Trim().ToUpperInvariant()
$apkFingerprint = $apkDigest -replace "(..)(?!$)", '$1:'

$assetLinks = Get-Content -Raw $assetLinksPath | ConvertFrom-Json
$statement = $assetLinks | Where-Object { $_.target.package_name -eq "jp.tanaka.tcloud.twa" } | Select-Object -First 1
if (-not $statement) { throw "assetlinks.json does not define the T-Cloud TWA package." }
$webFingerprints = @($statement.target.sha256_cert_fingerprints | ForEach-Object { $_.ToUpperInvariant() })
if ($apkFingerprint -notin $webFingerprints) {
    throw "The APK certificate does not match assetlinks.json."
}

$badging = & (Join-Path $buildTools.FullName "aapt.exe") dump badging $apk
if ($LASTEXITCODE -ne 0) { throw "APK metadata verification failed." }
$badgingText = $badging -join "`n"
if ($badgingText -notmatch "package: name='jp\.tanaka\.tcloud\.twa'") { throw "Unexpected applicationId in the APK." }
if ($badgingText -notmatch "application-label:'T-Cloud'") { throw "Unexpected application label in the APK." }

Write-Host "T-Cloud TWA verification succeeded."
Write-Host "APK: $apk"
Write-Host "applicationId: jp.tanaka.tcloud.twa"
Write-Host "Digital Asset Links: certificate matches"

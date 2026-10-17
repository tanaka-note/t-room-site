param(
    [switch]$SkipTools,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist/installer')
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer/installer-tools.json') -Raw | ConvertFrom-Json
$cacheDirectory = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $cacheDirectory, $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

function Get-InstallerDependency($Entry, [string]$FileName, [string]$Publisher) {
    $target = Join-Path $cacheDirectory $FileName
    if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $Entry.sha256) {
        $partial = "$target.partial"
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Entry.url -OutFile $partial -UseBasicParsing -TimeoutSec 300
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $Entry.sha256) {
                throw "Installer dependency hash mismatch: $FileName. Review the official download before updating the manifest."
            }
            Move-Item -LiteralPath $partial -Destination $target -Force
        }
        finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch $Publisher) {
        throw "Installer dependency signature invalid: $FileName"
    }
    return $target
}

$compilerSetup = Get-InstallerDependency $manifest.innoSetup 'innosetup-7.1.0-x64.exe' '(^|, )O=Pyrsys B\.V\.(,|$)'
$bootstrapper = Get-InstallerDependency $manifest.webViewBootstrapper 'MicrosoftEdgeWebview2Setup.exe' '(^|, )O=Microsoft Corporation(,|$)'
$compilerDirectory = Join-Path $cacheDirectory "inno-$($manifest.innoSetup.version)"
$compiler = Join-Path $compilerDirectory 'ISCC.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $installArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/NOICONS', '/TASKS=', ('/DIR="{0}"' -f $compilerDirectory))
    $job = Start-Process -FilePath $compilerSetup -ArgumentList $installArgs -WindowStyle Hidden -PassThru
    if (!$job.WaitForExit(60000)) { throw 'Inno Setup compiler installation timed out.' }
    if ($job.ExitCode -ne 0) { throw "Inno Setup compiler installation failed: $($job.ExitCode)" }
}
$compilerSignature = Get-AuthenticodeSignature -LiteralPath $compiler
if ($compilerSignature.Status -ne 'Valid' -or $compilerSignature.SignerCertificate.Subject -notmatch '(^|, )O=Pyrsys B\.V\.(,|$)') {
    throw 'Unexpected Inno Setup compiler signature.'
}
$compilerVersion = & $compiler --version
if ($LASTEXITCODE -ne 0 -or "$compilerVersion" -notmatch "\b$([regex]::Escape($manifest.innoSetup.version))\b") { throw 'Unexpected compiler version.' }
[xml]$project = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'src/XDownloader.App/XDownloader.App.csproj') -Raw
$version = [string]$project.Project.PropertyGroup.Version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric three-part app version.' }
# A new staging directory prevents stale build files or personal data from entering the setup.
$distRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist'))
$stage = Join-Path $distRoot ('installer-payload-' + [guid]::NewGuid().ToString('N'))
try {
    & (Join-Path $PSScriptRoot 'Build.ps1') -SkipTools:$SkipTools -OutputDirectory $stage
    if ($LASTEXITCODE -ne 0) { throw 'App build failed.' }
    & $compiler --quiet-progress "--define=AppVersion=$version" "--define=AppSource=$stage" "--define=InstallerOutput=$OutputDirectory" "--define=WebViewBootstrapper=$bootstrapper" (Join-Path $PSScriptRoot 'installer/XDownloader.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    $setup = Join-Path $OutputDirectory "XDownloader-Setup-$version-win-x64.exe"
    $digest = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$setup.sha256", "$digest  $([IO.Path]::GetFileName($setup))`n", [Text.Encoding]::ASCII)
    Write-Host "Personal-use installer: $setup"
}
finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if (!$resolvedStage.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging cleanup path.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}

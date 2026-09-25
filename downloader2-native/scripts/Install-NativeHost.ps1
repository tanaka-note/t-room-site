param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ChromeExtensionId,
  [ValidatePattern('^[a-p]{32}$')][string]$EdgeExtensionId = '',
  [string]$HostExecutable = (Join-Path $PSScriptRoot '..\src\Tlain.Downloader2.Host\bin\Release\net10.0-windows\win-x64\publish\Tlain.Downloader2.Host.exe')
)

$ErrorActionPreference = 'Stop'
$resolvedHost = (Resolve-Path -LiteralPath $HostExecutable).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'Tlain\Downloader2'
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
$manifestPath = Join-Path $installDirectory 'com.tlain.downloader2.json'
$origins = @("chrome-extension://$ChromeExtensionId/")
if ($EdgeExtensionId) { $origins += "chrome-extension://$EdgeExtensionId/" }
$manifest = [ordered]@{
  name = 'com.tlain.downloader2'
  description = 'T-lain Downloader 2 Native Messaging Host'
  path = $resolvedHost
  type = 'stdio'
  allowed_origins = $origins
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

foreach ($keyPath in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tlain.downloader2',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.tlain.downloader2'
)) {
  New-Item -Force -Path $keyPath | Out-Null
  Set-Item -LiteralPath $keyPath -Value $manifestPath
}
Write-Output "Native Messaging HostをHKCUへ登録しました: $manifestPath"

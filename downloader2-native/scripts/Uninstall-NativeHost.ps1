$ErrorActionPreference = 'Stop'
foreach ($keyPath in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tlain.downloader2',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.tlain.downloader2'
)) {
  if (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath -Force }
}
$manifestPath = Join-Path $env:LOCALAPPDATA 'Tlain\Downloader2\com.tlain.downloader2.json'
if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
Write-Output 'Native Messaging HostのHKCU登録を解除しました。端末credentialと履歴は削除していません。'

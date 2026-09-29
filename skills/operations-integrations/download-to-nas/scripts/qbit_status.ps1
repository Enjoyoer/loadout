param(
  [string]$BaseUrl = $env:QBITTORRENT_BASE_URL,
  [string]$Filter = "all"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $localConfig = Join-Path (Split-Path -Parent $PSScriptRoot) "references/local.md"
  if (Test-Path -LiteralPath $localConfig) {
    $match = Select-String -LiteralPath $localConfig -Pattern 'qBittorrent WebUI:\s*`?(https?://[^\s`]+)' | Select-Object -First 1
    if ($match) { $BaseUrl = $match.Matches[0].Groups[1].Value }
  }
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "Pass -BaseUrl, set QBITTORRENT_BASE_URL, or record 'qBittorrent WebUI: <url>' in references/local.md."
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$user = Read-Host "qBittorrent username"
$pass = Read-Host "qBittorrent password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
try {
  Invoke-WebRequest -UseBasicParsing -WebSession $session -Method Post -Uri "$BaseUrl/api/v2/auth/login" -Body @{ username = $user; password = $plain } | Out-Null
  $items = Invoke-RestMethod -WebSession $session -Uri "$BaseUrl/api/v2/torrents/info?filter=$Filter"
  $items | Select-Object name,state,progress,size,dlspeed,eta,save_path
}
finally {
  $plain = $null
}

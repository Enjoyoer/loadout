param(
  [string]$BaseUrl = $env:QBITTORRENT_BASE_URL,
  [string]$Filter = "all"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "Pass -BaseUrl or set QBITTORRENT_BASE_URL to your private qBittorrent WebUI URL."
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

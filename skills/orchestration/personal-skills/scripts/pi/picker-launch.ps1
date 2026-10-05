param(
 [string]$AppRoot,
 [Parameter(Mandatory=$true)][string]$PreferencesScript
)
# Desktop launch guard: reapply the picker patch, then always launch Paseo.
# A normal user cannot write the per-machine install under Program Files, so a
# reapply failure after an app update warns and launches the unpatched client.
# Reapply it later from an elevated shell (see the logged command).
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$log=Join-Path $env:LOCALAPPDATA 'loadout\picker-launch.log'
function Write-GuardLog([string]$Message){
 $line="$((Get-Date).ToUniversalTime().ToString('o')) $Message"
 Write-Warning $Message
 try { New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null; Add-Content -LiteralPath $log -Value $line } catch {}
}
if(-not $AppRoot){
 $roots=@((Join-Path $env:ProgramFiles 'Paseo'),(Join-Path $env:LOCALAPPDATA 'Programs\Paseo'))
 $apps=@($roots | Where-Object {Test-Path -LiteralPath (Join-Path $_ 'Paseo.exe')})
 if($apps.Count -ne 1){throw 'Expected exactly one Paseo Desktop install; pass -AppRoot'}
 $AppRoot=$apps[0]
}
$exe=Join-Path $AppRoot 'Paseo.exe'
if(-not (Test-Path -LiteralPath $exe)){throw "Paseo.exe not found under $AppRoot"}
$bundle=Join-Path $AppRoot 'resources\app-dist'
$patch=Join-Path $PSScriptRoot 'picker-patch.py'
$reapplied=$false
try {
 & python $patch $bundle reapply --preferences-script $PreferencesScript
 $reapplied=($LASTEXITCODE -eq 0)
 if(-not $reapplied){ $reason="exit $LASTEXITCODE" }
} catch { $reason=$_.Exception.Message }
if(-not $reapplied){
 Write-GuardLog "Picker reapply failed ($reason); launching the unpatched client. Reapply from an elevated shell: python `"$patch`" `"$bundle`" reapply --preferences-script `"$PreferencesScript`""
}
Start-Process -FilePath $exe

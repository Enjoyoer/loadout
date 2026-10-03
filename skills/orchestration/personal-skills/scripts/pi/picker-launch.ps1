param(
 [Parameter(Mandatory=$true)][string]$AppRoot,
 [Parameter(Mandatory=$true)][string]$PreferencesScript
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$bundle=Join-Path $AppRoot 'resources\app-dist'
& python (Join-Path $PSScriptRoot 'picker-patch.py') $bundle reapply --preferences-script $PreferencesScript
if($LASTEXITCODE -ne 0){throw 'Picker compatibility check failed; Desktop launch stopped'}
Start-Process -FilePath (Join-Path $AppRoot 'Paseo.exe')

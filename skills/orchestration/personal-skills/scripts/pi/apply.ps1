Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$deployScript = Join-Path $PSScriptRoot 'deploy.py'
if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) { throw 'Missing Pi deploy script' }
& python $deployScript @args
if ($LASTEXITCODE -ne 0) { throw "Pi deployment failed with exit $LASTEXITCODE" }

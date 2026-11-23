# Claude Code and Codex CLI adapter for Windows.
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File cli-windows.ps1 `
#     -Tool claude|codex -Step version|stage|precheck|apply|health|rollback -Txn <dir> [-Version V] [-Previous V]
# Claude: the vendor binary at %USERPROFILE%\.local\bin\claude.exe, replaced with [IO.File]::Replace, the old
# binary kept in the transaction directory. Codex: npm install -g @openai/codex@V, rolled back by reinstalling the
# previous version. The Codex config.toml is never written; health proves its hash is unchanged.
# Exit 75 means "not now, nothing changed".
param(
    [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex')][string]$Tool,
    [Parameter(Mandatory = $true)][ValidateSet('version', 'stage', 'precheck', 'apply', 'health', 'rollback')][string]$Step,
    [string]$Txn,
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Previous
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:DISABLE_AUTOUPDATER = '1'

$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$codex = Join-Path $env:APPDATA 'npm\codex.cmd'
$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'

function Get-Version([string]$Program) {
    $lines = & $Program --version
    if ($LASTEXITCODE -ne 0) { throw "version command failed ($LASTEXITCODE)" }
    return (($lines -join "`n").Trim())
}
function Expect([string]$V) { if ($Tool -eq 'claude') { "$V (Claude Code)" } else { "codex-cli $V" } }
function Test-BusyCli {
    $p = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='codex.exe' OR Name='codex-send.exe' OR Name='node.exe'" | Where-Object {
        $_.Name -eq 'claude.exe' -or $_.Name -eq 'codex-send.exe' -or
        ($_.Name -eq 'codex.exe' -and $_.ExecutablePath -notlike '*\WindowsApps\OpenAI.Codex_*' -and $_.ExecutablePath -notlike '*\.codex\packages\app-server-daemon\*') -or
        ($_.Name -eq 'node.exe' -and $_.CommandLine -match '(?:[\\/]codex[\\/]bin[\\/]codex\.js|codex-send)')
    })
    return ($p.Count -gt 0)
}
function Install-Codex([string]$V) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $prefix = (& $npm prefix -g | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or $prefix -ine (Split-Path -Parent $codex)) { throw 'unexpected npm global prefix' }
    & $npm install -g --no-audit --no-fund "@openai/codex@$V"
    if ($LASTEXITCODE -ne 0) { throw "npm install $V failed ($LASTEXITCODE)" }
}
function Save-ConfigHash {
    $h = if (Test-Path -LiteralPath $codexConfig) { (Get-FileHash -LiteralPath $codexConfig -Algorithm SHA256).Hash } else { 'absent' }
    Set-Content -LiteralPath (Join-Path $Txn 'codex-config.sha256') -Value $h -Encoding Ascii
}
function Test-ConfigHash {
    $want = (Get-Content -LiteralPath (Join-Path $Txn 'codex-config.sha256') -Raw).Trim()
    $h = if (Test-Path -LiteralPath $codexConfig) { (Get-FileHash -LiteralPath $codexConfig -Algorithm SHA256).Hash } else { 'absent' }
    if ($h -ne $want) { throw 'Codex config.toml changed during the update' }
}

try {
    if ($Step -eq 'version') { Get-Version $(if ($Tool -eq 'claude') { $claude } else { $codex }); exit 0 }
    if (-not $Txn -or -not (Test-Path -LiteralPath $Txn -PathType Container)) { throw 'Txn must be the transaction directory' }
    $candidate = Join-Path $Txn 'claude-candidate.exe'
    $backup = Join-Path $Txn 'claude-previous.exe'
    $replaced = Join-Path $Txn 'claude-replaced.exe'
    switch ($Step) {
        'stage' {
            if (-not $Version) { throw '-Version required' }
            Save-ConfigHash
            if ($Tool -eq 'claude') {
                if ((Get-Command claude.exe -ErrorAction Stop).Source -ine $claude) { throw 'unexpected claude.exe path' }
                $base = "https://downloads.claude.ai/claude-code-releases/$Version"
                $manifest = Invoke-RestMethod -Uri "$base/manifest.json" -TimeoutSec 30
                $want = [string]$manifest.platforms.'win32-x64'.checksum
                if ($manifest.version -ne $Version -or $want -notmatch '^[0-9a-f]{64}$') { throw 'manifest does not describe this version' }
                $curl = (Get-Command curl.exe -ErrorAction Stop).Source
                & $curl --fail --location --silent --show-error --retry 2 --max-time 600 --output "$candidate.part" "$base/win32-x64/claude.exe"
                if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE)" }
                if ((Get-FileHash -LiteralPath "$candidate.part" -Algorithm SHA256).Hash -ne $want.ToUpperInvariant()) { throw 'checksum mismatch' }
                Move-Item -LiteralPath "$candidate.part" -Destination $candidate
                if ((Get-Version $candidate) -ne (Expect $Version)) { throw 'staged version mismatch' }
                Copy-Item -LiteralPath $claude -Destination $backup
                if ((Get-FileHash -LiteralPath $claude).Hash -ne (Get-FileHash -LiteralPath $backup).Hash) { throw 'backup hash mismatch' }
            } elseif ((Get-Command codex.cmd -ErrorAction Stop).Source -ine $codex) { throw 'unexpected codex.cmd path' }
        }
        'precheck' {
            if ($Tool -eq 'claude' -and (Get-Version $candidate) -ne (Expect $Version)) { throw 'staged version mismatch' }
        }
        'apply' {
            if (Test-BusyCli) { [Console]::Error.WriteLine('CLI process running; not now'); exit 75 }
            if ($Tool -eq 'claude') { [IO.File]::Replace($candidate, $claude, $replaced) } else { Install-Codex $Version }
            $bin = if ($Tool -eq 'claude') { $claude } else { $codex }
            if ((Get-Version $bin) -ne (Expect $Version)) { throw 'post-install version mismatch' }
        }
        'health' {
            Test-ConfigHash
            if ($Tool -eq 'codex') { & $codex exec --help | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'codex exec --help failed' } }
        }
        'rollback' {
            if (-not $Previous) { throw '-Previous required' }
            if ($Tool -eq 'claude') {
                if (-not (Test-Path -LiteralPath $backup)) { exit 0 }
                if ((Get-Version $claude) -ne (Expect $Previous)) { Copy-Item -LiteralPath $backup -Destination "$claude.rollback"; [IO.File]::Replace("$claude.rollback", $claude, $null) }
            } elseif ((Get-Version $codex) -ne (Expect $Previous)) {
                Install-Codex $Previous
            }
            Test-ConfigHash
        }
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

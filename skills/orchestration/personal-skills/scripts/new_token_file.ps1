# Create an owner-only token file for the Loadout launcher on Windows and write a value into it from an
# environment variable, so the value is never typed or printed. Run it as the user the Paseo daemon runs as:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File new_token_file.ps1 -Path <file> -FromEnv <VAR>
# With -EnvName <NAME> it writes the one line NAME=<value> instead of the bare value, the form of a fleet MCP
# server's envFile. It refuses an existing file and any link or junction on the path. The file is created with its ACL already
# protected (nothing inherited) and granting only the current user, by SID; that ACL is read back from the open
# handle and verified before the value is written. Any failure stops before writing and removes the empty file.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$FromEnv,
  [string]$EnvName
)
Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$value = [Environment]::GetEnvironmentVariable($FromEnv)
if (-not $value) { throw "environment variable $FromEnv is empty" }
if ($EnvName) {
  if ($EnvName -cnotmatch '^[A-Z_][A-Z0-9_]*$') { throw "-EnvName must be an uppercase env name" }
  $value = $EnvName + '=' + $value + "`n"
}
$Path = [IO.Path]::GetFullPath($Path)
# GetAttributes does not follow a link, so a dangling one counts as existing too.
$exists = $true
try { [void][IO.File]::GetAttributes($Path) }
catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $exists = $false }
if ($exists) { throw "$Path already exists; remove it first" }
$dir = [IO.Path]::GetDirectoryName($Path)
[void][IO.Directory]::CreateDirectory($dir)
for ($q = $dir; $q; $q = [IO.Path]::GetDirectoryName($q)) {
  if ([IO.File]::GetAttributes($q).HasFlag([IO.FileAttributes]::ReparsePoint)) { throw "a link or junction at $q" }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($me)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'Allow'))
$full = [Security.AccessControl.FileSystemRights]::FullControl
# CreateNew: fails if anything took the name since the check above.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $fs = [IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($Path), [IO.FileMode]::CreateNew, $full,
    [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $acl)
} else {
  $fs = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, $full, [IO.FileShare]::None, 4096,
    [IO.FileOptions]::None, $acl)
}
$written = $false
try {
  $got = if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::GetAccessControl($fs) }
         else { $fs.GetAccessControl() }
  $sid = [Security.Principal.SecurityIdentifier]
  $rules = @($got.GetAccessRules($true, $true, $sid))
  $others = @($rules.Where({ $_.IdentityReference.Value -ne $me.Value -or $_.AccessControlType -ne 'Allow' }))
  if (-not $got.AreAccessRulesProtected) { throw 'the new file inherits its ACL' }
  if ($got.GetOwner($sid).Value -ne $me.Value) { throw 'the new file is owned by another account' }
  if ($others.Count -or -not $rules.Count) { throw 'the new file grants accounts besides the current user' }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($value)
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Flush($true)
  $written = $true
} finally {
  $fs.Dispose()
  if (-not $written) { [IO.File]::Delete($Path) }
}
"created $Path, readable only by $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"

# Seed a Chrome or Edge user-data dir before the browser opens it, on Windows.
#
# A fresh profile has no cached result for Chrome's Windows blank-password check
# (CheckBlankPasswordWithPrefs), so Chrome tries LogonUser with an empty password. On an account
# with a password, Windows logs that as a failed logon (Security 4625), and enough of them in a
# short window lock the account, which also locks SSH out. Seeding the cached result in
# <dir>\Local State skips that check:
#   {"password_manager":{"os_password_blank":false,"os_password_last_changed":"9223372036854775807"}}
# os_password_last_changed is an int64 pref, which Chrome stores as a JSON string.
#
# The two keys are merged into an existing Local State; every other key is kept. The file is
# created only when it is missing, and nothing is written when both keys already hold these
# values, so the script is safe to run before every launch. A Local State that is empty, is not a
# JSON object, or has a password_manager that is not an object is left unchanged and the script
# fails. It writes a temporary file next to Local State, checks that it parses back to exactly the
# merged content, then moves it into place.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File seed_local_state.ps1 -Profile <user-data-dir>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('Profile')]
    [ValidateNotNullOrEmpty()]
    [string]$UserDataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Section = 'password_manager'
$BlankKey = 'os_password_blank'
$ChangedKey = 'os_password_last_changed'
$ChangedValue = '9223372036854775807'

# Windows PowerShell 5.1 can write a wrapped array as {"value":[...],"Count":n} while this type data is loaded.
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch { }

$FromJson = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    $FromJson['DateKind'] = 'String'
} elseif ($PSVersionTable.PSVersion.Major -ge 6) {
    throw 'PowerShell 6.0 to 7.4 turns date-like strings into dates when it reads JSON. Run this with powershell.exe (Windows PowerShell) or PowerShell 7.5 or later.'
}

function Read-JsonObject([string]$File) {
    $text = [System.IO.File]::ReadAllText($File)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "$File is empty; left unchanged."
    }
    $value = ConvertFrom-Json -InputObject $text @FromJson
    if ($value -isnot [System.Management.Automation.PSCustomObject]) {
        throw "$File does not hold a JSON object; left unchanged."
    }
    return $value
}

# The property with exactly this name, or $null. PowerShell matches member names case-insensitively,
# while Chrome's keys are case-sensitive, so a key that differs only in case stops the script.
function Get-ExactProperty($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property -and $property.Name -cne $Name) {
        throw "Local State has the key '$($property.Name)', which differs from '$Name' only in case; left unchanged."
    }
    return $property
}

function Set-ExactProperty($Object, [string]$Name, $Value) {
    $property = Get-ExactProperty $Object $Name
    if ($null -eq $property) {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    } else {
        $property.Value = $Value
    }
}

# One line per JSON node, path and value, to compare two parsed documents.
function Get-JsonShape($Node, [string]$Path) {
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        "$Path {}"
        foreach ($property in $Node.PSObject.Properties) {
            Get-JsonShape $property.Value ($Path + '/' + (ConvertTo-Json -InputObject $property.Name -Compress))
        }
    } elseif ($Node -is [System.Array]) {
        "$Path []"
        for ($i = 0; $i -lt $Node.Length; $i++) {
            Get-JsonShape $Node[$i] "$Path/$i"
        }
    } elseif ($null -eq $Node) {
        "$Path null"
    } else {
        $invariant = [System.Globalization.CultureInfo]::InvariantCulture
        if ($Node -is [double]) { $text = $Node.ToString('R', $invariant) } else { $text = [System.Convert]::ToString($Node, $invariant) }
        "$Path $($Node.GetType().FullName) $(ConvertTo-Json -InputObject $text -Compress)"
    }
}

$dir = [System.IO.Path]::GetFullPath($UserDataDir)
if ([System.IO.File]::Exists($dir)) {
    throw "$dir is a file, not a user-data dir."
}
[void][System.IO.Directory]::CreateDirectory($dir)
$path = [System.IO.Path]::Combine($dir, 'Local State')

$exists = [System.IO.File]::Exists($path)
if ($exists) {
    $state = Read-JsonObject $path
} else {
    $state = [pscustomobject]@{}
}

$sectionProperty = Get-ExactProperty $state $Section
if ($null -eq $sectionProperty) {
    Set-ExactProperty $state $Section ([pscustomobject]@{})
    $sectionProperty = Get-ExactProperty $state $Section
}
$manager = $sectionProperty.Value
if ($manager -isnot [System.Management.Automation.PSCustomObject]) {
    throw "$Section in $path is not a JSON object; left unchanged."
}

$blank = Get-ExactProperty $manager $BlankKey
$changed = Get-ExactProperty $manager $ChangedKey
if ($null -ne $blank -and $blank.Value -is [bool] -and -not $blank.Value -and
    $null -ne $changed -and $changed.Value -is [string] -and $changed.Value -ceq $ChangedValue) {
    Write-Output "Local State already seeded: $path"
    exit 0
}

Set-ExactProperty $manager $BlankKey $false
Set-ExactProperty $manager $ChangedKey $ChangedValue

$json = ConvertTo-Json -InputObject $state -Depth 100 -Compress
$temp = [System.IO.Path]::Combine($dir, 'Local State.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding $false))
    $expected = (Get-JsonShape $state '') -join "`n"
    $written = (Get-JsonShape (Read-JsonObject $temp) '') -join "`n"
    if ($written -cne $expected) {
        throw "The rewritten Local State would not keep the existing content of $path exactly; left unchanged."
    }
    if ($exists) {
        # PowerShell passes $null to a .NET string parameter as ""; NullString keeps it null (no backup file).
        [System.IO.File]::Replace($temp, $path, [System.Management.Automation.Language.NullString]::Value)
        Write-Output "Local State merged: $path"
    } else {
        [System.IO.File]::Move($temp, $path)
        Write-Output "Local State created: $path"
    }
} finally {
    if ([System.IO.File]::Exists($temp)) {
        [System.IO.File]::Delete($temp)
    }
}

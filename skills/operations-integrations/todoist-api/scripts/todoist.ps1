# Todoist API v1 PowerShell Helper
# Usage: . (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
# Then call: Invoke-TodoistGet, Invoke-TodoistPost, Invoke-TodoistDelete, etc.

$script:TodoistTokenPath = Join-Path $HOME ".codex\secrets\todoist.token"
if (-not (Test-Path -LiteralPath $script:TodoistTokenPath -PathType Leaf)) {
    throw "Todoist token file not found: $script:TodoistTokenPath"
}
$script:TodoistToken = (Get-Content -Raw -LiteralPath $script:TodoistTokenPath).Trim()
if ([string]::IsNullOrWhiteSpace($script:TodoistToken)) {
    throw "Todoist token file is empty: $script:TodoistTokenPath"
}
$script:TodoistBase = "https://api.todoist.com/api/v1"
$script:TodoistHeaders = @{Authorization="Bearer $script:TodoistToken"}
$script:TodoistPostHeaders = @{Authorization="Bearer $script:TodoistToken"; "Content-Type"="application/json"}

function Invoke-TodoistGet {
    param([string]$Endpoint, [hashtable]$Query = @{})
    $qs = ($Query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([System.Uri]::EscapeDataString($_.Value))" }) -join "&"
    $uri = "$script:TodoistBase/$Endpoint"
    if ($qs) { $uri += "?$qs" }
    Invoke-RestMethod -Uri $uri -Headers $script:TodoistHeaders -Method Get
}

function Invoke-TodoistPost {
    param([string]$Endpoint, [hashtable]$Body = @{})
    $json = if ($Body.Count -gt 0) { $Body | ConvertTo-Json -Depth 5 } else { $null }
    $params = @{
        Uri     = "$script:TodoistBase/$Endpoint"
        Headers = $script:TodoistPostHeaders
        Method  = "Post"
    }
    if ($json) { $params.Body = $json }
    Invoke-RestMethod @params
}

function Invoke-TodoistDelete {
    param([string]$Endpoint)
    Invoke-RestMethod -Uri "$script:TodoistBase/$Endpoint" -Headers $script:TodoistHeaders -Method Delete
}

# --- Convenience Functions ---

function Get-TodoistTasks {
    param([string]$Filter, [string]$ProjectId, [string]$Cursor)
    if ($Filter) {
        $q = @{query=$Filter}
        if ($Cursor) { $q.cursor = $Cursor }
        Invoke-TodoistGet "tasks/filter" $q
    } elseif ($ProjectId) {
        $q = @{project_id=$ProjectId}
        if ($Cursor) { $q.cursor = $Cursor }
        Invoke-TodoistGet "tasks" $q
    } else {
        $q = @{}
        if ($Cursor) { $q.cursor = $Cursor }
        Invoke-TodoistGet "tasks" $q
    }
}

function Get-TodoistAllTasks {
    param([string]$Filter, [string]$ProjectId)

    $all = @()
    $seen = @{}
    $cursor = $null

    do {
        $page = Get-TodoistTasks -Filter $Filter -ProjectId $ProjectId -Cursor $cursor
        $items = if ($null -ne $page.results) { @($page.results) } else { @($page) }

        foreach ($task in $items) {
            if ($task.id -and -not $seen.ContainsKey($task.id)) {
                $seen[$task.id] = $true
                $all += $task
            }
        }

        $cursor = if ($null -ne $page.next_cursor) { $page.next_cursor } else { $null }
    } while ($cursor)

    [pscustomobject]@{
        results = $all
        next_cursor = $null
        count = $all.Count
    }
}

function Find-TodoistTasksByText {
    param(
        [Parameter(Mandatory)][string]$Text,
        [string]$ProjectId
    )

    $needle = $Text.ToLowerInvariant()
    $tasks = Get-TodoistAllTasks -ProjectId $ProjectId
    $matches = @($tasks.results | Where-Object {
        $content = if ($_.content) { $_.content.ToLowerInvariant() } else { "" }
        $description = if ($_.description) { $_.description.ToLowerInvariant() } else { "" }
        $content.Contains($needle) -or $description.Contains($needle)
    })

    [pscustomobject]@{
        results = $matches
        next_cursor = $null
        count = $matches.Count
    }
}

function New-TodoistTask {
    param(
        [Parameter(Mandatory)][string]$Content,
        [string]$Description,
        [string]$DueString,
        [string]$DueDate,
        [int]$Priority,
        [string]$ProjectId,
        [string[]]$Labels
    )
    $body = @{content=$Content}
    if ($Description) { $body.description = $Description }
    if ($DueString) { $body.due_string = $DueString }
    if ($DueDate) { $body.due_date = $DueDate }
    if ($Priority) { $body.priority = $Priority }
    if ($ProjectId) { $body.project_id = $ProjectId }
    if ($Labels) { $body.labels = $Labels }
    Invoke-TodoistPost "tasks" $body
}

function Complete-TodoistTask {
    param([Parameter(Mandatory)][string]$TaskId)
    Invoke-TodoistPost "tasks/$TaskId/close"
}

function Restore-TodoistTask {
    param([Parameter(Mandatory)][string]$TaskId)
    Invoke-TodoistPost "tasks/$TaskId/reopen"
}

function Remove-TodoistTask {
    param([Parameter(Mandatory)][string]$TaskId)
    Invoke-TodoistDelete "tasks/$TaskId"
}

function Update-TodoistTask {
    param(
        [Parameter(Mandatory)][string]$TaskId,
        [string]$Content,
        [string]$Description,
        [string]$DueString,
        [int]$Priority,
        [string[]]$Labels
    )
    $body = @{}
    if ($Content) { $body.content = $Content }
    if ($Description) { $body.description = $Description }
    if ($DueString) { $body.due_string = $DueString }
    if ($Priority) { $body.priority = $Priority }
    if ($Labels) { $body.labels = $Labels }
    Invoke-TodoistPost "tasks/$TaskId" $body
}

function Add-TodoistQuickTask {
    param([Parameter(Mandatory)][string]$Text)
    Invoke-TodoistPost "tasks/quick" @{text=$Text}
}

function Get-TodoistProjects {
    Invoke-TodoistGet "projects"
}

function Get-TodoistLabels {
    Invoke-TodoistGet "labels"
}

function Get-TodoistSections {
    param([string]$ProjectId)
    $q = @{}
    if ($ProjectId) { $q.project_id = $ProjectId }
    Invoke-TodoistGet "sections" $q
}

function Get-TodoistComments {
    param([Parameter(Mandatory)][string]$TaskId)
    Invoke-TodoistGet "comments" @{task_id=$TaskId}
}

function New-TodoistComment {
    param(
        [Parameter(Mandatory)][string]$TaskId,
        [Parameter(Mandatory)][string]$Content
    )
    Invoke-TodoistPost "comments" @{task_id=$TaskId; content=$Content}
}

Write-Host "Todoist API loaded. Functions: Get-TodoistTasks, Get-TodoistAllTasks, Find-TodoistTasksByText, New-TodoistTask, Update-TodoistTask, Complete-TodoistTask, Restore-TodoistTask, Remove-TodoistTask, Add-TodoistQuickTask, Get-TodoistProjects, Get-TodoistLabels, Get-TodoistSections, Get-TodoistComments, New-TodoistComment" -ForegroundColor Green

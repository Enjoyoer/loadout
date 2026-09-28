# Todoist API reference

## Quick Reference: Raw API Calls

If you prefer or need to make raw calls without the helper script, use this table. **Every call uses the same auth pattern:**

```powershell
$tokenPath = Join-Path $HOME ".codex\secrets\todoist.token"
$token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
$h = @{Authorization="Bearer $token"}
$hp = @{Authorization="Bearer $token"; "Content-Type"="application/json"}
$base = "https://api.todoist.com/api/v1"
```

### Tasks

| Action | Method | Endpoint | Body |
|--------|--------|----------|------|
| List all tasks | GET | `$base/tasks` | - |
| Filter tasks | GET | `$base/tasks/filter?query=today` | - |
| Get one task | GET | `$base/tasks/$id` | - |
| Create task | POST | `$base/tasks` | `@{content="Title"} \| ConvertTo-Json` |
| Quick add | POST | `$base/tasks/quick` | `@{text="Call Alex tomorrow p1"} \| ConvertTo-Json` |
| Update task | POST | `$base/tasks/$id` | `@{content="New"} \| ConvertTo-Json` |
| Complete task | POST | `$base/tasks/$id/close` | - |
| Reopen task | POST | `$base/tasks/$id/reopen` | - |
| Delete task | DELETE | `$base/tasks/$id` | - |
| Completed tasks | GET | `$base/tasks/completed/by_completion_date?limit=20` | - |

### Projects / Labels / Sections / Comments

| Action | Method | Endpoint |
|--------|--------|----------|
| List projects | GET | `$base/projects` |
| Get project | GET | `$base/projects/$id` |
| Create project | POST | `$base/projects` |
| Delete project | DELETE | `$base/projects/$id` |
| List labels | GET | `$base/labels` |
| Create label | POST | `$base/labels` |
| List sections | GET | `$base/sections?project_id=$id` |
| List comments | GET | `$base/comments?task_id=$id` |
| Add comment | POST | `$base/comments` |

---

## Filter Query Syntax

The filter endpoint (`/tasks/filter?query=...`) uses the same syntax as Todoist's search bar. **URL-encode the query value.**

Use `-Filter` only for real Todoist filter expressions like due dates, priorities, labels, projects, or assignees. Do **not** use it for plain title/description text. If a user asks to find "the registration task", "the Alex task", or any other task by words in the task, use `Find-TodoistTasksByText` or list all tasks and match locally.

For title/description searches, `Find-TodoistTasksByText` pages through active tasks with `Get-TodoistAllTasks`, deduplicates by task ID, then performs a case-insensitive local match against `content` and `description`. This avoids Todoist filter error 55 and avoids duplicate matches from repeated pages.

| Filter | What It Returns |
|--------|----------------|
| `today` | Tasks due today |
| `overdue` | Overdue tasks |
| `tomorrow` | Tasks due tomorrow |
| `7 days` or `next 7 days` | Due in next 7 days |
| `no date` | Tasks with no due date |
| `p1` | Priority 1 (urgent, API priority=4) |
| `p2` | Priority 2 (high, API priority=3) |
| `#Inbox` | Tasks in the Inbox project |
| `#ProjectName` | Tasks in a specific project |
| `@labelname` | Tasks with a specific label |
| `@waiting` | Tasks labeled "waiting" |
| `assigned to: me` | Tasks assigned to the user |
| `today \| overdue` | Today OR overdue (pipe = OR) |
| `today & p1` | Today AND priority 1 (ampersand = AND) |

**URL encoding in PowerShell:**
```powershell
$filter = [System.Uri]::EscapeDataString("today | overdue")
```

---

## Task Create/Update Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `content` | string | Yes (create) | Task title |
| `description` | string | No | Task body/notes |
| `due_string` | string | No | Natural language: `"tomorrow"`, `"every Monday at 9am"` |
| `due_date` | string | No | Exact date: `"2026-04-25"` (YYYY-MM-DD) |
| `due_datetime` | string | No | Exact datetime: `"2026-04-25T14:00:00Z"` |
| `priority` | int | No | `1`=normal, `2`=medium, `3`=high, `4`=urgent |
| `project_id` | string | No | Target project (omit = Inbox) |
| `section_id` | string | No | Target section within project |
| `parent_id` | string | No | Parent task (makes this a subtask) |
| `labels` | string[] | No | Array of label names: `@("urgent","finance")` |

---

## Task Object Shape

Every task returned by the API looks like this:

```json
{
    "id": "6gH57x6jgG3xxCJw",
    "content": "Review report - Waiting on Alex",
    "description": "Check the aging report...",
    "project_id": "6frWrrVMHVfR2PRP",
    "section_id": "6frWxr6Fh2mf5c4P",
    "parent_id": "6gHJv58mqJqwr6fP",
    "priority": 2,
    "due": {
        "date": "2026-04-23",
        "string": "2026-04-23",
        "lang": "en",
        "is_recurring": false
    },
    "labels": ["waiting_on"],
    "checked": false,
    "added_at": "2026-03-31T18:40:54Z"
}
```

**Key gotchas:**
- `due` is `null` when no due date is set - check before accessing `.due.date`
- `parent_id` is `null` for top-level tasks, a string ID for subtasks
- `priority` is inverted: API `4` = Todoist UI `p1` (urgent)

---

## Common Workflows

### "Show my tasks for today"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
$r = Get-TodoistTasks -Filter "today"
$r.results | Select-Object id, content, priority, @{N='due';E={$_.due.date}} | Format-Table -AutoSize
```

### "What's in my inbox?"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
$r = Get-TodoistTasks -Filter "#Inbox"
$r.results | Sort-Object added_at -Descending | Select-Object content, priority, @{N='added';E={$_.added_at}} | Format-Table -AutoSize
```

### "Create a task"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
New-TodoistTask -Content "Review Q2 financials" -DueString "tomorrow at 2pm" -Priority 4 -Labels @("urgent","finance")
```

### "Complete task X"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
# Step 1: Find the task
$r = Find-TodoistTasksByText -Text "task name"
$r.results | Select-Object id, content
# Step 2: Complete it
Complete-TodoistTask -TaskId "THE_ID_FROM_STEP_1"
```

### "Find a task by title or description"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
$r = Find-TodoistTasksByText -Text "Renew vehicle registration"
$r.results | Select-Object id, content, parent_id, project_id, priority, @{N='due';E={if ($_.due) {$_.due.date} else {''}}} | Format-Table -AutoSize
```

### "Search all pages without creating duplicates"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
$r = Get-TodoistAllTasks
$r.results | Sort-Object added_at -Descending | Select-Object id, content, priority, @{N='due';E={if ($_.due) {$_.due.date} else {''}}}
```

### "Quick add with natural language"
```powershell
. (Join-Path $HOME ".codex\skills\todoist-api\scripts\todoist.ps1")
Add-TodoistQuickTask -Text "Call Alex tomorrow at 3pm p1 #Work @phone"
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `410 Gone` | Used deprecated `/rest/v2/` URL | Change to `/api/v1/` |
| `401 Unauthorized` | Bad or expired token | User gets new token from `https://app.todoist.com/app/settings/integrations/developer` |
| `400 Bad Request` | Malformed JSON body | Ensure `\| ConvertTo-Json` and correct field names/types |
| `403 Forbidden` | No permission on that resource | Check project sharing / ownership |
| Empty output | Normal for `close` and `delete` (204) | Success. Do not retry. |
| `curl` errors | PowerShell aliases `curl` ? `Invoke-WebRequest` | Use `Invoke-RestMethod` instead. NEVER use `curl`. |
| `$response.content` is empty | Accessed response wrong | Task-list pages use `.results`; inspect endpoint-specific response shapes for other resources |
| `INVALID_SEARCH_QUERY` / error 55 | Used `/tasks/filter` for plain text search or unsupported filter syntax | Use `Find-TodoistTasksByText -Text "words"` or `Get-TodoistTasks` then `Where-Object` locally |
| Token not working after config change | The local token file is absent or stale | Check the direct-REST credentials path used by the helper |

---

## Auth Token Management

- Store the token only in the user-owned file resolved by `Join-Path $HOME ".codex\secrets\todoist.token"`.
- The helper reads and trims that file at load time; it fails closed when the file is missing or empty.
- If the token expires, obtain a replacement from [Todoist Developer Settings](https://app.todoist.com/app/settings/integrations/developer) and replace only that local secret file. Never put the token in this skill, a repository, or chat.

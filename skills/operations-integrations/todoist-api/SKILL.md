---
name: todoist-api
description: Manage Todoist tasks and projects through the configured direct REST helper.
---

# Todoist

Use the bundled PowerShell helper for the user's Todoist account. This workflow uses API v1 at `https://api.todoist.com/api/v1` and does not require a Todoist MCP server.

## Credentials and access

The helper reads the token from the local user-owned `.codex/secrets/todoist.token` file. Never print it or put it in a repository, prompt or message. If unavailable, request local credential setup rather than asking for the value in chat.

Load `scripts/todoist.ps1` from this skill directory. Use the host-native PowerShell environment; no IDE or MCP reconfiguration is required.

## Select the operation

- `Get-TodoistTasks` retrieves one page.
- `Get-TodoistAllTasks` follows task pagination and deduplicates IDs.
- `Find-TodoistTasksByText -Text <words>` searches task titles and descriptions locally across pages. Plain text is not a Todoist filter expression.
- Use the helper's create, update, complete, restore and resource-list functions for the corresponding requested action.
- For raw endpoints, field names and filter examples, read [API reference](references/api.md). Verify uncertain non-task response shapes instead of assuming all lists share one envelope.

## Important contracts

Task IDs are strings. API priority 4 is UI p1; API priority 1 is UI p4. A task's due value can be null. Task-list responses use `.results` and `.next_cursor`; completeness requires reaching the final page.

The helper serializes request bodies and attaches authorization. For raw requests, use JSON bodies and the appropriate JSON content type. Empty successful close/delete responses are expected, not grounds to replay a mutation. If a write outcome is uncertain, inspect current state before retrying.

## Scope and completion

Read-only requests do not authorize task changes. Apply only requested changes to resolved targets; clarify an ambiguous target or materially missing field. Preserve unrelated tasks and fields, and respect user approval requirements for destructive actions.

Finish by confirming the requested result from the API or a bounded follow-up read. Report partial results and missing pages; do not turn incomplete retrieval into a claim that an item does not exist.

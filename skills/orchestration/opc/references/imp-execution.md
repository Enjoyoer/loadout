# Execution mechanics

## Task binding

Call `createTask({workingDirectory, runDirectory, owner, baseRef, delivery:'merge', browserReview})` from `scripts/task-state.mjs`; reuse its `taskPath`. Use a named publication base such as `origin/main`. Local/PR values serve direct helpers and tests. Keep runtime files outside the repository. Use the normal CLI home and host-native access without extra sandbox, translation, or gateway layers. Keep credentials out of prompts, logs, and commits; authentication stays user-controlled. Preserve work on cloud-hydration failures.

## Agent launch

Use durable Paseo children that survive PM steering. Parentage requires the same daemon; another machine's agent is a peer. Before every agent launch, inspect the provider in its target workspace and pass the unique advertised unattended full-permission `modeId`; ambiguity stops the lane. An owner-selected route maps directly to the `create_agent` `provider` and `settings`. Paseo profiles are not part of OPC; do not discover them or narrate their absence. Call the agent-scoped MCP tool with `notifyOnFinish: true`. Every background follow-up uses direct `send_agent_prompt` with that setting unless the owner explicitly requests fire-and-forget. CLI background launch and CLI wait cannot install this callback. Never substitute them through a shell or temporary adapter.

Only explicitly read-only scouts, planners, reviewers, and advisors may share the PM workspace with `workspaceId` omitted. Any possible editing requires the Worker placement below. Labels are observation metadata, never placement evidence.

## Worker placement

Use the pure request builders in `scripts/paseo-worker.mjs`, then make each MCP call yourself:

1. Inspect parent Git status and select an explicit committed base. Worktrees inherit no staged, unstaged, or untracked parent changes. If required changes are uncommitted, ask the owner to commit them, choose another base, or exclude them. Never silently copy a dirty patch or share the dirty checkout.
2. Use `buildManagedWorkspaceRequest` for the unique branch and `worktreeSlug`; call direct `create_workspace({isolation:'worktree', ...})` with that request.
3. Inspect the provider at the returned path. Pass the returned `workspaceId` to `buildManagedWorkerRequest`, call direct `create_agent` with the unchanged request, then call `validateManagedWorkerLaunch`. The request binds workspace, route, unattended mode, and notification.

Record agent ID, workspace ID, path, branch, base, and parent relationship as run evidence. Managed agents do not populate the task record's CLI `worker` slot. A failed placement stops the lane; preserve any created workspace for reconciliation. Permission requests require checking placement/settings, not accepting weaker permissions.

For a repair, use `buildManagedWorkerFollowupRequest`, call direct `send_agent_prompt`, and yield again. Only an explicit owner fire-and-forget request may disable notification.

## Worker brief

Build launch and resume prompts with `buildDelegatedBrief` from `scripts/agent-routing.mjs` to bind role and route. Supply task values and source pointers as plain text:

```text
Role: Implementation Worker. Implement and test only; OPC tasks, review, and Git delivery belong to the PM.
Outcome: Required behavior and completion criteria.
Scope: Workspace ID, managed path, unique branch, committed base, permitted changes.
Constraints: User limits, preserved behavior, unrelated work, and fixed route.
Checks: Acceptance commands and required observations.
Route: Recorded model, effort, and Fast choice.
Report: Commit owned changes; return branch, workspace ID, path, commit SHA(s), validation, remaining issues, and integration instructions.
```

Before substantial integration work, require inspection of the installed tool/API interface and the smallest real operation within scope. Fixtures alone do not prove a live path; distinguish human-authentication blockers.

## Delivery helpers

Use ordinary Git to stage owned changes, commit, push, and open the authorized PR. For manifest publication, commit source first and generated manifest separately; preserve both parents on merge.

Use `scripts/delivery.mjs` on final content, including publication manifests:

- `runTests(taskPath, {argv})` binds independent checks to head and bytes; source-mutating tests cannot produce passing receipts.
- `verifyDelivery(taskPath, {pr})` checks tests, clean publication checkout, repository/base/head, and the selected review gate. Worker compliance is reported separately.
- `mergeDelivery(taskPath, {pr})` uses `gh pr merge --merge --match-head-commit` and checks merged state/ancestry. GitHub integrates the current base; repository rules own base/check requirements.
- `reconcileMerge(taskPath)` observes an uncertain merge without resubmitting.

Retain review receipts or unavailable evidence. Delete an authorized disposable remote branch only after confirmed merge.

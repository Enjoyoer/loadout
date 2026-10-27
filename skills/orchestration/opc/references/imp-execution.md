# Execution mechanics

## Task binding

Call `createTask({workingDirectory, runDirectory, owner, baseRef, delivery:'merge', browserReview, ui})` from `scripts/task-state.mjs` (`ui: true` only for a task of read-only `ui-design` and `ui-check` lanes; the build is a `code` task); reuse `taskPath`. Use a named publication base such as `origin/main`. Keep runtime files outside the repository. Use the normal CLI home and host-native access without extra sandbox, translation, or gateway layers. Keep credentials out of prompts, logs, and commits; authentication stays user-controlled. Preserve work on cloud-hydration failures.

## Agent launch

Use Paseo children that survive PM steering. Inspect every target provider. For Pi, require availability and an empty modes list, then omit `modeId`. Other providers require the unique advertised unattended full-permission mode; ambiguity stops the lane. Paseo profiles are not part of OPC; do not discover them or narrate their absence. CLI launch and wait cannot install the `notifyOnFinish` callback; never substitute them through a shell or adapter.

Only explicitly read-only scouts, planners, reviewers, and advisors may share the PM workspace with `workspaceId` omitted. Any possible editing requires the Worker placement below.

## Worker placement

Use `scripts/paseo-worker.mjs` pure request builders; call MCP yourself:

1. Inspect parent Git status and select an explicit committed base. Worktrees inherit no staged, unstaged, or untracked parent changes. If required changes are uncommitted, ask the owner to commit them, choose another base, or exclude them. Never silently copy a dirty patch or share the dirty checkout.
2. Use `buildManagedWorkspaceRequest` for the unique branch and `worktreeSlug`; call direct `create_workspace({isolation:'worktree', ...})` with that request.
3. Inspect Codex for browser classes, otherwise Pi, at the returned path; supply verbatim catalog rows as `capabilities.models`. Pass the recorded `route` from `resolveWorkerRoute`, `task: readTask(taskPath)`, and its `taskClass`; omit `provider` and `agentSettings` to map its surface. Except browser classes, native or Pi-unserved routes need `nativeAuthorization: 'owner-explicit'`; Codex requires explicit `settings.modeId` (`full-access`, advertised unattended). Pass the returned `workspaceId` to `buildManagedWorkerRequest`, call direct `create_agent` with the unchanged request, then call `validateManagedWorkerLaunch`.

Record agent/workspace IDs, path, branch, base, and parentage. A failed placement stops the lane; preserve any created workspace for reconciliation. Permission requests require checking placement/settings, not accepting weaker permissions.

Repairs: pass `send_agent_prompt`'s advertised `inputSchema` to `buildManagedWorkerFollowupRequest`, send directly, then `validateManagedWorkerFollowup` (queued is accepted). Only owner-explicit fire-and-forget disables notification.

## Worker brief

Bind route, reason, role, task, lane, class, catalog, and testing rule with `buildDelegatedBrief`. Include outcome, workspace ID, managed path, branch, base, allowed changes, acceptance checks, and source pointers. Live checks use readbacks, canaries, or dry runs demonstrating intent. Brief only PM-named tests, including regressions for observed failures.

Codemode comes from the Pi home. Before substantial integration, inspect the installed tool/API and its smallest real operation. Fixtures alone do not prove live behavior; distinguish human-authentication blockers.

## Delivery helpers

Use Git to commit, push, and open the authorized PR. For manifest publication, commit source first and generated manifest separately; preserve both parents on merge.

Use `scripts/delivery.mjs` on final content, including publication manifests:

- `runTests(taskPath, {argv})` binds independent checks to head and bytes; source-mutating tests cannot produce passing receipts.
- `verifyDelivery(taskPath, {pr})` checks tests, clean publication checkout, repository/base/head, and the selected review gate. Worker compliance is reported separately.
- `mergeDelivery(taskPath, {pr})` uses `gh pr merge --merge --match-head-commit` and checks merged state/ancestry. GitHub integrates the current base; repository rules own base/check requirements.
- `reconcileMerge(taskPath)` observes an uncertain merge without resubmitting.

Retain review receipts or unavailable evidence. Delete an authorized disposable remote branch only after confirmed merge.

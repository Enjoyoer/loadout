# Execution mechanics

## Task binding

Call `createTask({workingDirectory, runDirectory, owner, baseRef, delivery:'merge', browserReview, ui})` from `scripts/task-state.mjs`; reuse its `taskPath`. Use a named publication base such as `origin/main`. Keep runtime files outside the repository. Use the normal CLI home and host-native access without extra sandbox, translation, or gateway layers. Keep credentials out of prompts, logs, and commits; authentication stays user-controlled. Preserve work on cloud-hydration failures.

## Agent launch

Use Paseo children that survive PM steering. Inspect every target provider. For Pi, require availability and an empty modes list, then omit `modeId`. Other providers require the unique advertised unattended full-permission mode; ambiguity stops the lane. Paseo profiles are not part of OPC; do not discover them or narrate their absence. CLI launch and wait cannot install the `notifyOnFinish` callback; never substitute them through a shell or adapter.

Only explicitly read-only scouts, planners, reviewers, and advisors may share the PM workspace with `workspaceId` omitted. Any possible editing requires the Worker placement below.

## Worker placement

Use the pure request builders in `scripts/paseo-worker.mjs`, then make each MCP call yourself:

1. Inspect parent Git status and select an explicit committed base. Worktrees inherit no staged, unstaged, or untracked parent changes. If required changes are uncommitted, ask the owner to commit them, choose another base, or exclude them. Never silently copy a dirty patch or share the dirty checkout.
2. Use `buildManagedWorkspaceRequest` for the unique branch and `worktreeSlug`; call direct `create_workspace({isolation:'worktree', ...})` with that request.
3. Inspect Pi at the returned path; supply its verbatim model catalog rows as `capabilities.models`. Pass the recorded `route` from `resolveWorkerRoute`; omit `provider` and `agentSettings` to map its surface. Native or Pi-unserved routes need `nativeAuthorization: 'owner-explicit'`. Pass the returned `workspaceId` to `buildManagedWorkerRequest`, call direct `create_agent` with the unchanged request, then call `validateManagedWorkerLaunch`.

Record agent/workspace IDs, path, branch, base, and parentage. Managed agents do not populate the task record's CLI `worker` slot. A failed placement stops the lane; preserve any created workspace for reconciliation. Permission requests require checking placement/settings, not accepting weaker permissions.

Repairs use `buildManagedWorkerFollowupRequest` with direct `send_agent_prompt`. Only an explicit owner fire-and-forget request may disable notification.

## Worker brief

Bind route, reason, role, and testing rule with `buildDelegatedBrief`. Include outcome, workspace ID, managed path, branch, base, allowed changes, acceptance checks, and source pointers. Live checks include state readbacks, canary runs, or dry runs showing exactly the intended change. Brief wanted test cases, such as a regression test for an observed failure.

Codemode comes from the Pi home. `worker.mjs` is owner-authorized native Codex plumbing.

Before substantial integration work, require inspection of the installed tool/API interface and the smallest real operation within scope. Fixtures alone do not prove a live path; distinguish human-authentication blockers.

## Delivery helpers

Use Git to commit, push, and open the authorized PR. For manifest publication, commit source first and generated manifest separately; preserve both parents on merge.

Use `scripts/delivery.mjs` on final content, including publication manifests:

- `runTests(taskPath, {argv})` binds independent checks to head and bytes; source-mutating tests cannot produce passing receipts.
- `verifyDelivery(taskPath, {pr})` checks tests, clean publication checkout, repository/base/head, and the selected review gate. Worker compliance is reported separately.
- `mergeDelivery(taskPath, {pr})` uses `gh pr merge --merge --match-head-commit` and checks merged state/ancestry. GitHub integrates the current base; repository rules own base/check requirements.
- `reconcileMerge(taskPath)` observes an uncertain merge without resubmitting.

Retain review receipts or unavailable evidence. Delete an authorized disposable remote branch only after confirmed merge.

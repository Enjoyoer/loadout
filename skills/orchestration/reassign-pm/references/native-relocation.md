# Native relocation dependency

Consult this when retained agents must change workspace. Check the installed version's public API before assuming it supports a move.

## Observed surface: Paseo 0.10.2

- `update_agent_request` changes name and labels; it has no workspace or cwd field. Runtime-settings updates do not relocate an agent either.
- `import_agent_request` accepts a destination `workspaceId` through the client API. The CLI `paseo import` exposes `--cwd`, but not `--workspace`.
- Import rejects an already-active native session. For an archived session, the server restores the same Paseo record into the requested workspace after checking realpath equivalence with its stored cwd. It retains that stored cwd. This can restore history, but does not supply a general active-agent relocation or missing-cwd repair operation.
- `archive_workspace` cascades to its agents and terminals and may remove a managed worktree. Reparenting labels does not protect an agent still in that workspace.

Evidence in the installed packages: CLI `commands/agent/import.js`; protocol `messages` schemas for `UpdateAgentRequestMessageSchema` and `ImportAgentRequestMessageSchema`; server `agent/import-sessions.js` (`importProviderSessionNow`). Recheck these when Paseo changes.

## Required native follow-up

Expose a supported client/API operation, with matching CLI/tool surface, to move an existing agent by `agentId` to `workspaceId`, optionally transferring its parent. It must:

- Preserve the Paseo ID, provider session/native handle and timeline, exact model ID, mode/thinking/features, role labels, and archived state.
- Validate the destination and cwd before mutation. Preserve valid worker worktree cwd; for a missing or renamed cwd, require an explicit supported provider-aware rebinding operation rather than an alias.
- Update workspace membership and ownership together, reject unsafe running-agent moves without interrupting mission work, and return a snapshot that can be checked.
- Be idempotent, roll back a failed move, and prevent workspace archive from racing with the transfer.

Acceptance checks: move an idle worker and watcher, including one with a distinct worktree cwd; retain IDs and history; reject a missing cwd or invalid destination without mutation; verify an authorized old-workspace archive leaves moved agents unarchived. Include exact Claude and OpenCode model-ID round trips.

Until that operation or an equivalent supported contract exists, report the affected agent IDs and preserve them in place. Do not embed archive/import or storage-edit workarounds in this skill.

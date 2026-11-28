# OPN Host Adapters

How a PM starts, follows up and archives an outcome-scoped worker on each host. The main policy owns the brief, model, proof, cleanup and memory rules; this file adds only host mechanics.

## Selection

Use the first host whose operations are all callable:

1. Paseo: agent-scoped `create_agent`, `send_agent_prompt`, `get_agent_status`, and archive.
2. Codex named tasks: `codex_app__list_projects`, `codex_app__list_threads`, `codex_app__create_thread`, `codex_app__send_message_to_thread`.
3. Native subagents: `spawn_agent`, `followup_task`, `wait_agent`.

If none is callable, or the owner has not allowed delegation, work directly only within your own scope; otherwise name the missing operation as the blocker. Report an operation that is not callable by name; never call another host's operations.

## In place, never a new container

Every adapter creates the worker under the PM, in the PM's existing workspace, project or session and working directory. Never create a new workspace or project for a worker, including when following up, except an admitted `replacement` or `pace-backup`, or when the existing decision 359 code-parity rules call for managed placement. Ordinary defaults and all non-Claude classes stay in the PM's workspace.

- Paseo:
  - Always consult `node ../opc/scripts/route.mjs --class <class>` (or `resolveWorkerRoute` in `../opc/scripts/route.mjs`) live before launching any fresh or replayed worker—never launch from remembered defaults or pasted route objects. Bare `route.mjs --class <class>` prints one human summary line to `stderr` and machine JSON (`route`, `reason`, `provider`, `model`, `effort`, `fast`, `host`, `nextFallback`, `proofRequired`) to `stdout` without creating files or consuming parity turns.
  - Non-Claude classes (`research`, `review`, `review-security`, `watcher`, `smoke`, `sites`), `opn-browser` (the named OPN native Codex browser exception, owner 412a), and ordinary on-pace or Fable read-only defaults (`plan`, `ui-design`, `ui-check` under decision 390a) stay in the PM's workspace. The resolver handoff is required: in one process, call `resolveWorkerRoute({taskClass, catalog, lane})` for the worker's lane, pass its `route` unchanged with the same `lane` and `taskClass` and the Pi catalog as `capabilities` (for `opn-browser`, resolve with the native Codex catalog and pass native Codex `inspect_provider` with its `list_models` rows as `models`) to `buildInPlaceWorkerRequest` from `../opc/scripts/paseo-worker.mjs`, and call `create_agent` with the returned `request` unchanged. Omit `provider` and `agentSettings`; any passed must equal the route's own mapping, thinking included. A pasted, cloned, other-lane, or stale route, or one that needs managed placement, is refused.
  - Default `code` workers (and `plan`/`ui-design`/`ui-check` only when positive fresh Devin-ready or positive fresh Fable cannot-serve evidence applies) on a Git checkout: call `resolveWorkerRoute` with exact bound `{task, lane, target}` and fresh `proof` / `unavailable` (or `readRemoteAgyTarget` for an armed remote; missing/stale proof fails closed without inventing Sol or silently substituting Opus). For an admitted `replacement`, `pace-backup`, `cursor-overflow`, `devin-first`, or decision 359 code-parity lane, call `recordWorkerRoute` and launch via OPC's `create_workspace` and `buildManagedWorkerRequest` ([Worker placement](../../opc/references/imp-execution.md#worker-placement "runtime")), including its `agy-opc` error backstop. Never alter recorded lanes, owner-named routes, reviews, non-Claude classes, excluded launchers, or PMs.
  - On Pi, use `tools.mcp__paseo__send_agent_prompt` / `tools.mcp__paseo__create_agent` via codemode (`exposure: codemode`) with `notifyOnFinish: true`; these tools are available.
  - `paseo send` never notifies on finish; without `PASEO_AGENT_ID`, default steer becomes interrupt. Queue a one-shot check-back in the same step as any CLI send to a worker. After the PM's readback verifies its result, close the worker as the main policy says: heartbeats and check-backs, then the agent, then each workspace it created that holds no unpreserved work.
- Codex named tasks: create only a thread inside the PM's existing project. The PM reads the thread's result and relays it.
- Native subagents: spawn under the caller, wait for the bounded result, and send repairs to the same subagent.

If a host can set the worker's model or thinking only partly, use what it supports and report the difference; never substitute silently.

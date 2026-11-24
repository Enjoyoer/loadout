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
  - Normal non-Claude classes (`research`, `review`, `review-security`, `watcher`, `smoke`, `sites`) and on-pace non-workspace launches: run `node ../opc/scripts/route.mjs --class <class>` from the OPN skill folder (a browser worker instead takes the map's [OPN browser exception](../../opc/references/routing.md#opn-browser-workers "runtime")), and call agent-scoped `create_agent` with no workspace argument, passing that route's provider, model ID and thinking, `labels: {"opc.service-tier": "fast"}` when Fast is on (read back with `get_agent_status`), and `notifyOnFinish: true`.
  - Default Claude-class OPN workers (`code`, `plan`, `ui-design`, `ui-check`) on a Git checkout: do not use raw `route.mjs --class` CLI output (even with `--task` and `--lane`), which omits target and evidence and prints only the plain default. Call `resolveWorkerRoute` in `../opc/scripts/route.mjs` with `{task, lane, target}` plus fresh `proof` or positive fresh `unavailable` evidence (and `readRemoteNeonTarget` for an armed remote) before choosing placement. Only for an admitted `replacement` or `pace-backup`, or when the existing decision 359 code-parity rules call for managed placement, call `recordWorkerRoute` and launch via OPC's `create_workspace` and `buildManagedWorkerRequest` ([Worker placement](../../opc/references/imp-execution.md#worker-placement "runtime")). For an ordinary default, including on-pace Fable plan or UI, call `create_agent` in the PM's workspace using the resolved route.
  - Non-managed hand launches of a default Claude-class worker while off pace (no git checkout or managed task): distinguish no-context CLI output (plain default only) from an approved launch. Verify the route before calling `create_agent` ([manual off-pace rule](../../opc/references/routing.md#antigravity-replacement "runtime")): ready fresh proof launches exact `agy-opc` Neon High (`modeId: "auto"`, `thinkingOptionId: "high"`, `features: { auto_accept: true }`, Fast off); existing positive fresh unavailable evidence on the local host launches Pi Sol medium, Fast off (`labels: {"opc.service-tier": "standard"}`); no proof without positive unavailable evidence must not launch Sol (verify first or keep the plain default). Never alter recorded lanes, owner-named routes, reviews (`review`, `review-security`), non-Claude classes, excluded launchers or PMs.
  - Follow-ups go through `send_agent_prompt` with `notifyOnFinish: true`. After the PM's readback verifies its result, close the worker as the main policy says: heartbeats and check-backs, then the agent, then each workspace it created that holds no unpreserved work.
- Codex named tasks: create only a thread inside the PM's existing project. The PM reads the thread's result and relays it.
- Native subagents: spawn under the caller, wait for the bounded result, and send repairs to the same subagent.

If a host can set the worker's model or thinking only partly, use what it supports and report the difference; never substitute silently.

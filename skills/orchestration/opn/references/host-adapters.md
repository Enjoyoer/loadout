# OPN Host Adapters

How a PM starts, follows up and archives an outcome-scoped worker on each host. The main policy owns the brief, model, proof, cleanup and memory rules; this file adds only host mechanics.

## Selection

Use the first host whose operations are all callable:

1. Paseo: agent-scoped `create_agent`, `send_agent_prompt`, `get_agent_status`, and archive.
2. Codex named tasks: `codex_app__list_projects`, `codex_app__list_threads`, `codex_app__create_thread`, `codex_app__send_message_to_thread`.
3. Native subagents: `spawn_agent`, `followup_task`, `wait_agent`.

If none is callable, or the owner has not allowed delegation, work directly only within your own scope; otherwise name the missing operation as the blocker. Report an operation that is not callable by name; never call another host's operations.

## In place, never a new container

Every adapter creates the worker under the PM, in the PM's existing workspace, project or session and working directory. Never create a new workspace or project for a worker, including when following up.

- Paseo: an agent-scoped `create_agent` with no workspace argument places the worker in the PM's workspace with a parent link. Pass the PM's own provider, model ID and thinking, and `notifyOnFinish: true`; follow-ups go through `send_agent_prompt` with `notifyOnFinish: true`. Archive the worker after the PM's readback verifies its result.
- Codex named tasks: create only a thread inside the PM's existing project. The PM reads the thread's result and relays it.
- Native subagents: spawn under the caller, wait for the bounded result, and send repairs to the same subagent.

If a host can set the worker's model or thinking only partly, use what it supports and report the difference; never substitute silently.

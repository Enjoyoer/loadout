# Recovery and cancellation

Inspect the failed component: Worker execution separately from controller/messaging health, page loading separately from authentication. A network or proxy error (`Connection error`, 502 `backend unavailable`) is retried on the same route with a continue follow-up to the same Worker; it never changes model or effort. Rate limits and real launch failures still stop the lane. Preserve existing state. A lost message or unknown/still-running launch never authorizes replacement; slow loading alone does not justify restart or another login. Never bypass a human challenge.

For managed Workers, call `cancel_agent({agentId})` on the recorded identity and confirm the owned run stopped through Paseo. Retain workspace and commits for integration or explicit abandonment under [cleanup](worktree-lifecycle.md "runtime"). Cancellation alone does not authorize archival.

An interrupted `delivery.mjs test` leaves `tests.status: 'running'` with its pid. SIGINT or SIGTERM stops the test command and records `blocked`; if the process was killed outright, `delivery.mjs reconcile <task.json>` or the next `delivery.mjs test` marks the record `failed` with reason `interrupted` once that pid is gone. A `task.json.lock` whose pid is gone is stale and is replaced; a live pid's lock is never removed.

## Direct CLI helper

`scripts/worker.mjs` is low-level direct plumbing, not an alternative OPC editing lane. It launches native Codex only with `--native-authorization owner-explicit`, recording the owner's decision for that task. `cancelWorker(taskPath)` addresses only its CLI worker slot, never managed agents. Preserve native history and avoid publishing credentials. Run native-launch tests on the PM host, not recursively inside the Worker under test.

CLI cancellation sends the normal native interrupt and reports handle exit. Codex owns descendants; OPC adds no keeper, process census, or forced-kill fallback and claims no independent descendant cleanup. The PM owns intentionally persistent services through host tools. Denied or unanswered interrupts remain incomplete. Mac normal exit/Ctrl-C were tested; Windows native interruption remains unverified because Node signals differ from console Ctrl-C and needs validation there.

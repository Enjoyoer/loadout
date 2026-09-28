# Recovery and cancellation

Inspect the failed component: Worker execution separately from controller/messaging health, page loading separately from authentication. Preserve existing state. A lost message or unknown/still-running launch never authorizes replacement; slow loading alone does not justify restart or another login. Never bypass a human challenge.

For managed Workers, call `cancel_agent({agentId})` on the recorded identity and confirm the owned run stopped through Paseo. Retain workspace and commits for integration or explicit abandonment under [cleanup](worktree-lifecycle.md "runtime"). Cancellation alone does not authorize archival.

## Direct CLI helper

`scripts/worker.mjs` is low-level direct plumbing, not an alternative OPC editing lane. `cancelWorker(taskPath)` addresses only its CLI worker slot, never managed agents. Preserve native history and avoid publishing credentials. Run native-launch tests on the PM host, not recursively inside the Worker under test.

CLI cancellation sends the normal native interrupt and reports handle exit. Codex owns descendants; OPC adds no keeper, process census, or forced-kill fallback and claims no independent descendant cleanup. The PM owns intentionally persistent services through host tools. Denied or unanswered interrupts remain incomplete. Mac normal exit/Ctrl-C were tested; Windows native interruption remains unverified because Node signals differ from console Ctrl-C and needs validation there.

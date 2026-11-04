# Workspace cleanup

Archive only once verified integration or explicit abandonment accounts for uncommitted, ignored, and uniquely committed work. Retain the canonical checkout, unpreserved work, and workspaces holding processes, locks, unfinished Git operations, credentials, browser profiles, or sole-copy data; uncertain means retain and report; age only triggers inspection.

Close an idle Worker (`get_agent_status`) in one pass: `paseo schedule delete` its heartbeats (`<PASEO_HOME>/schedules/*.json` targeting it) and schedules, or move them to the PM; `archive_agent`; then `paseo workspace archive <id> [--host ssh://<alias>]` its workspace and each it created, on any host (recorded IDs, `paseo.parent-agent-id` labels), except pinned or local project workspaces and any with another live agent. Verify removal; never delete recursively, `git worktree remove`, or prune.

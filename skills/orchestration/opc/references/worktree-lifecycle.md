# Workspace cleanup

Archive only once verified integration or explicit abandonment accounts for uncommitted, untracked, ignored, and uniquely committed work. Retain the canonical checkout, unpreserved work, and workspaces holding processes, locks, unfinished Git operations, credentials, browser profiles, or sole-copy data; uncertain means retain and report; age only triggers inspection.

Close an idle Worker: `paseo schedule delete [--host]` its heartbeats (`<PASEO_HOME>/schedules/*.json` targeting it) and check-backs, or move them to the PM; `archive_agent`; once the checks above pass, `paseo workspace archive <id> [--host ssh://<alias>]` its workspace and each it created (recorded IDs, `paseo.parent-agent-id` labels), except pinned or local project workspaces and any with another unarchived agent. Verify removal; never delete recursively, `git worktree remove`, or prune.

# Workspace cleanup

The PM archives only after integration is verified or explicit abandonment accounts for staged, unstaged, untracked, ignored, and uniquely committed work. Retain the canonical checkout and all unpreserved work. Retain a workspace with any active agent/process, lock, unfinished Git operation, credential, browser profile, or sole-copy data. Uncertainty means retain and report; age only triggers inspection.

At cleanup, call `get_agent_status({agentId})` once more to confirm no active Worker turn, then `archive_workspace({workspaceId})`. `archiveManagedWorkerWorkspace` requires disposition and evidence. Paseo archives agents/terminals and removes its worktree after the last active workspace reference is archived. Verify removal from active Paseo inventory and Git worktrees. Use Paseo archival, not recursive deletion, manual `git worktree remove`, or metadata pruning.

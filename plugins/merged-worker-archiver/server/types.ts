// Minimal structural views of the Paseo 0.9.1 workspace and agent snapshots
// (WorkspaceDescriptorPayload / AgentSnapshotPayload). Only the fields the decision
// logic reads are listed, so tests can build fixtures without the full payloads.

export interface WorkspaceView {
  id: string;
  name: string;
  projectId?: string;
  projectDisplayName?: string;
  projectRootPath?: string;
  workspaceKind: string;
  workspaceDirectory?: string;
  /** Present only for a Paseo-owned worktree (the basename of its root). */
  worktreeSlug?: string;
  status: string;
  archivingAt?: string | null;
  activityAt: string | null;
  statusEnteredAt?: string | null;
  /** 0.12 and later. */
  createdAt?: string;
  /** 0.12 and later. */
  lastUserMessageAt?: string | null;
  /** 0.12 and later: a workspace setup script's state. */
  setupStatus?: string | null;
  pinnedAt?: string | null;
  labels?: ReadonlyArray<string>;
  background?: boolean;
  scripts?: ReadonlyArray<{ scriptName: string; lifecycle: string }>;
  gitRuntime?: { currentBranch?: string | null; isPaseoOwnedWorktree?: boolean } | null;
}

export interface AgentView {
  id: string;
  workspaceId?: string | null;
  status: string;
  title?: string | null;
  labels?: Record<string, string>;
  pendingPermissions?: ReadonlyArray<unknown>;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastUserMessageAt?: string | null;
  archivedAt?: string | null;
}

/** A live terminal as `list_terminals` reports it. */
export interface TerminalView {
  id: string;
  workspaceId?: string | null;
  cwd?: string;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  /** Raw stdout. runCommand always sets it; git paths are bytes, and `stdout` decodes them lossily. */
  stdoutBytes?: Buffer;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

/** Runs `git`, `gh` or the `paseo` CLI without a shell. Implementations must never throw. */
export type CommandRunner = (
  command: "git" | "gh" | "paseo",
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

/** Absolute, realpath-normalized git common dir for a directory, or null (not git or error). */
export type CommonDirResolver = (directory: string) => Promise<string | null>;

export interface FileSystem {
  isDirectory(path: string): Promise<boolean | null>;
  exists(path: string): Promise<boolean>;
  /** True only for an existing real directory (not a symlink or junction) with no entries; anything else, or any error, is false. */
  isEmptyDirectory(path: string): Promise<boolean>;
  /** Canonical absolute path (symlinks resolved), or null on any error. */
  realpath(path: string): Promise<string | null>;
  readText(path: string): Promise<string | null>;
}

/** `notify` reports an agentless worktree to its PM once; only workspace cleanup decides it. */
export type DecisionAction = "archive" | "skip" | "notify";

/** Which workspace cleanup rule decided (absent for the worker paths). */
export type CleanupPath = "stale-record" | "agentless-worktree";

export interface Decision {
  workspaceId: string;
  workspaceName: string;
  agentIds: string[];
  branch: string | null;
  base: string | null;
  action: DecisionAction;
  reason: string;
  /** False for workspaces that are never candidates (non-worktree kinds). */
  candidate: boolean;
  /** Set when workspace cleanup decided. */
  cleanup?: CleanupPath;
  /** Workspace cleanup: the latest activity used for the stale test (ISO), when known. */
  lastActivityAt?: string | null;
  /** Workspace cleanup, notify only: `<sha7> <date> <subject>` of HEAD, or null when git cannot tell. */
  lastCommit?: string | null;
}

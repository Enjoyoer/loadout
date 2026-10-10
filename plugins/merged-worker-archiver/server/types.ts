// Minimal structural views of the Paseo 0.9.1 workspace and agent snapshots
// (WorkspaceDescriptorPayload / AgentSnapshotPayload). Only the fields the decision
// logic reads are listed, so tests can build fixtures without the full payloads.

export interface WorkspaceView {
  id: string;
  name: string;
  projectId?: string;
  workspaceKind: string;
  workspaceDirectory?: string;
  status: string;
  archivingAt?: string | null;
  activityAt: string | null;
  statusEnteredAt?: string | null;
  scripts?: ReadonlyArray<{ scriptName: string; lifecycle: string }>;
  gitRuntime?: { currentBranch?: string | null } | null;
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
  updatedAt?: string;
  lastUserMessageAt?: string | null;
  archivedAt?: string | null;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

/** Runs `git` or `gh` without a shell. Implementations must never throw. */
export type CommandRunner = (
  command: "git" | "gh",
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

/** Absolute, realpath-normalized git common dir for a directory, or null (not git or error). */
export type CommonDirResolver = (directory: string) => Promise<string | null>;

export interface FileSystem {
  isDirectory(path: string): Promise<boolean | null>;
  exists(path: string): Promise<boolean>;
  /** True only for an existing directory with no entries; anything else, or any error, is false. */
  isEmptyDirectory(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
}

export type DecisionAction = "archive" | "skip";

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
}

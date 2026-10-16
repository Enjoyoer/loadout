import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArchiverConfig } from "./config.ts";
import { checkMerged, type MergeCheckDeps } from "./merge-check.ts";
import { paseoHome } from "./vendor/daemon-target.ts";
import type { AgentView, Decision, FileSystem, WorkspaceView } from "./types.ts";

export interface EvaluateDeps {
  merge: Omit<MergeCheckDeps, "timeoutMs" | "useGh">;
  fs: FileSystem;
  now: () => number;
  /** Host-native roots; injectable for isolated verification. */
  cleanupRoots?: readonly string[];
}

function isDescendant(root: string, directory: string): boolean {
  const child = relative(root, directory);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function isDisposableDirectory(directory: string, deps: EvaluateDeps): Promise<boolean> {
  if (!isAbsolute(directory)) return false;
  const roots = deps.cleanupRoots ?? [
    join(resolve(paseoHome()), "worktrees"),
    join(homedir(), ".cache", "fleet-scratch"),
  ];
  for (const root of roots) {
    if (!isDescendant(root, directory)) continue;
    const [realRoot, realDirectory] = await Promise.all([deps.fs.realpath(root), deps.fs.realpath(directory)]);
    if (realRoot && realDirectory && isDescendant(realRoot, realDirectory)) return true;
  }
  return false;
}

const ELIGIBLE_AGENT_STATUSES = new Set(["idle", "closed"]);
const BLOCKING_WORKSPACE_STATUSES = new Set(["running", "needs_input", "failed"]);
const PM_TITLE = /(^|[^A-Za-z])PM([^A-Za-z]|$)/;

export function isPmAgent(agent: AgentView): boolean {
  const role = agent.labels?.role?.trim().toLowerCase();
  if (role === "pm") return true;
  return typeof agent.title === "string" && PM_TITLE.test(agent.title);
}

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest;
}

/** Pure agent/workspace gates. Returns a skip reason, or null when git may be consulted. */
export function preGitSkipReason(
  workspace: WorkspaceView,
  agents: readonly AgentView[],
  config: ArchiverConfig,
  now: number,
  emptyDisposable = false,
): string | null {
  if (workspace.archivingAt) return "already-archiving";
  if (!workspace.workspaceDirectory) return "no-directory";
  if (agents.some(isPmAgent)) return "pm-agent";
  if (!emptyDisposable && agents.length === 0 && !config.allowAgentlessWorkspaces) return "no-agents";

  for (const agent of agents) {
    const short = agent.id.slice(0, 8);
    if (agent.status === "running" || agent.status === "initializing") return `agent-${agent.status}(${short})`;
    if (!ELIGIBLE_AGENT_STATUSES.has(agent.status)) return `agent-status-${agent.status}(${short})`;
    if ((agent.pendingPermissions?.length ?? 0) > 0) return `pending-permission(${short})`;
    if (agent.requiresAttention && agent.attentionReason !== "finished") {
      return `attention-${agent.attentionReason ?? "unknown"}(${short})`;
    }
  }

  if (BLOCKING_WORKSPACE_STATUSES.has(workspace.status)) return `workspace-${workspace.status}`;
  const runningScript = workspace.scripts?.find((script) => script.lifecycle === "running");
  if (runningScript) return `script-running(${runningScript.scriptName})`;

  const lastActivity = latestTimestamp([
    workspace.activityAt,
    workspace.statusEnteredAt,
    ...agents.flatMap((agent) => [agent.updatedAt, agent.lastUserMessageAt, agent.attentionTimestamp]),
  ]);
  if (lastActivity === null) return "ambiguous(no activity timestamp)";
  const graceMs = config.graceMinutes * 60_000;
  const idleMs = now - lastActivity;
  if (idleMs < graceMs) {
    const remaining = Math.ceil((graceMs - idleMs) / 60_000);
    return `grace-period(idle=${Math.max(0, Math.floor(idleMs / 60_000))}m, remaining=${remaining}m)`;
  }
  return null;
}

/**
 * Decide one workspace. `agents` must be the complete set of non-archived agents whose
 * workspaceId is this workspace.
 */
export async function evaluateWorkspace(
  workspace: WorkspaceView,
  agents: readonly AgentView[],
  config: ArchiverConfig,
  deps: EvaluateDeps,
): Promise<Decision> {
  // Pre-git skips report the branch Paseo last observed; git-checked decisions report
  // the branch git itself resolved.
  const observedBranch = workspace.gitRuntime?.currentBranch ?? null;
  const decision = (action: Decision["action"], reason: string, branch: string | null = observedBranch, base: string | null = null, candidate = true): Decision => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentIds: agents.map((agent) => agent.id),
    branch,
    base,
    action,
    reason,
    candidate,
  });

  // Keep the existing worktree merge/cleanliness gates: its official archive may
  // remove the worktree directory. This exception cleans up non-worktree records.
  const emptyDisposable = workspace.workspaceKind !== "worktree"
    && Boolean(workspace.workspaceDirectory)
    && await isDisposableDirectory(workspace.workspaceDirectory!, deps);
  if (workspace.workspaceKind !== "worktree" && !emptyDisposable) return decision("skip", `not-worktree(${workspace.workspaceKind})`, observedBranch, null, false);
  if (emptyDisposable && agents.length > 0) return decision("skip", "non-archived-agents");

  const preSkip = preGitSkipReason(workspace, agents, config, deps.now(), emptyDisposable);
  if (preSkip) return decision("skip", preSkip);

  const directory = workspace.workspaceDirectory!;
  const isDirectory = await deps.fs.isDirectory(directory);
  if (isDirectory === false) return decision("skip", "path-missing(left to Paseo)");
  if (isDirectory === null) return decision("skip", "ambiguous(path not statable)");

  if (emptyDisposable) return decision("archive", "empty-disposable-workspace");

  const merge = await checkMerged(directory, {
    ...deps.merge,
    timeoutMs: config.commandTimeoutSeconds * 1000,
    useGh: config.useGh,
  });
  if (!merge.merged) return decision("skip", merge.reason, merge.branch ?? observedBranch, merge.base);
  return decision("archive", merge.reason, merge.branch, merge.base);
}

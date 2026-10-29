import type { ArchiverConfig } from "./config.ts";
import type { EvaluateDeps } from "./evaluate.ts";
import { checkMerged } from "./merge-check.ts";
import type { AgentView, Decision, WorkspaceView } from "./types.ts";

// Workspace cleanup: agentless workspaces that the worker paths leave alone (every non-worktree
// workspace outside the disposable roots, and worktrees with no live agents). Full sweeps only.
//
// - A stale non-worktree workspace (project checkout, local checkout, directory) is archived as a
//   record. Paseo's workspace archive removes a directory only for a Paseo-owned worktree, so for
//   these it deletes no files and leaves the project listed (see README, "Workspace cleanup").
// - A stale agentless worktree is archived only when the plugin's merge test says merged, which also
//   requires a clean tree; ignored files count as the no-PR path counts them (regenerable output is clean,
//   a sensitive name or a quoted path is not). Otherwise it is kept and reported to its PM once.
//
// Stale means no activity for at least staleWorkspaceMinutes, where activity is the latest of the
// timestamps Paseo exposes for the workspace and for every agent it ever held (archived included),
// leaving out the ones an agent's archive stamps, plus each agent's newest delivered message
// (Paseo's receipts), an archived agent's last turn (up to 12 h after its newest input), and a
// worktree's HEAD committer date: see lastActivity() and evaluateCleanup().

/** Merge-test results that mean "unmerged or dirty": kept, and the PM is told once. */
const NOTIFY_REASONS = [
  "dirty(",
  "not-merged(",
  "unmerged-commits(",
  "no-branch-commits",
  "no-base(",
  "branch-is-base",
  "detached-head",
  "operation-in-progress(",
  "submodule(",
  "pr-head-mismatch(",
  "pr-base-mismatch(",
];

export interface NotifiedEntry {
  at: string;
  agentId: string;
  status: "sending" | "sent" | "unconfirmed";
  /** The peer daemon (`ssh://<alias>`) the PM lives on; absent for a PM on this daemon. */
  host?: string;
}

export interface CleanupContext {
  config: ArchiverConfig;
  deps: EvaluateDeps;
  /** Non-archived agents of this workspace, background workspaces included. */
  agents: readonly AgentView[];
  /** Every agent this workspace ever held, archived ones included. */
  history: readonly AgentView[];
  /** Live terminals that belong to this workspace. */
  terminals: number;
  /**
   * Newest delivered message per agent id (receipts recent enough to matter), or null when the
   * receipts could not be read: archive times then count instead.
   */
  deliveries: ReadonlyMap<string, number> | null;
  /** Worktrees already reported, or null when that state could not be read (no new report is decided). */
  notified: ReadonlyMap<string, NotifiedEntry> | null;
}

/** The worker paths' decisions that hand a workspace to workspace cleanup. */
export function isCleanupEntry(decision: Decision): boolean {
  return decision.action === "skip" && (decision.reason.startsWith("not-worktree(") || decision.reason === "no-agents");
}

function parse(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** An archived agent counts as active this long after its newest input, at most until its archive. */
export const LAST_TURN_ALLOWANCE_MS = 12 * 60 * 60_000;

/**
 * Latest activity Paseo exposes for a workspace: its creation, status entry, activity and last user
 * message times, and for every agent it ever held (archived included) creation, update, last user
 * message and attention times, and its newest delivered message (`deliveries`, from Paseo's
 * receipts, which also covers messages from other agents).
 *
 * Archiving is not activity: an agent's archive stamps its archivedAt and its updatedAt with the
 * same moment, and a long-lived Paseo session stamps the workspace's statusEnteredAt with it when the
 * last busy agent leaves. So an archived agent's updatedAt counts only when it is earlier than its
 * archivedAt, statusEnteredAt only when it is earlier than the newest archivedAt, and a delivery is
 * capped at the archivedAt. But the work an agent did after its newest input leaves no trace, so an
 * archived agent counts as active until min(archivedAt, newest input + LAST_TURN_ALLOWANCE_MS), where
 * its inputs are its creation, last user message and newest delivery. When the receipts could not be
 * read (`deliveries` null), an archived agent counts as active until its archivedAt.
 *
 * Scripts and terminals expose no times; a running one blocks cleanup instead. The workspace
 * record's own updatedAt is not exposed. Null when there is none.
 */
export function lastActivity(workspace: WorkspaceView, history: readonly AgentView[], deliveries: ReadonlyMap<string, number> | null): number | null {
  let newestArchive: number | null = null;
  for (const agent of history) {
    const archivedAt = parse(agent.archivedAt);
    if (archivedAt !== null && (newestArchive === null || archivedAt > newestArchive)) newestArchive = archivedAt;
  }
  const statusEnteredAt = parse(workspace.statusEnteredAt);
  const values: Array<number | null> = [
    parse(workspace.createdAt),
    statusEnteredAt !== null && (newestArchive === null || statusEnteredAt < newestArchive) ? statusEnteredAt : null,
    parse(workspace.activityAt),
    parse(workspace.lastUserMessageAt),
  ];
  for (const agent of history) {
    const createdAt = parse(agent.createdAt);
    const lastUserMessageAt = parse(agent.lastUserMessageAt);
    values.push(createdAt, lastUserMessageAt, parse(agent.attentionTimestamp));
    const updatedAt = parse(agent.updatedAt);
    const archivedAt = parse(agent.archivedAt);
    // An archived agent whose archive time cannot be read is not capped (counts as more recent).
    const uncapped = !agent.archivedAt || archivedAt === null;
    if (updatedAt !== null && (uncapped || updatedAt < archivedAt)) values.push(updatedAt);
    const delivered = deliveries?.get(agent.id) ?? null;
    if (delivered !== null) values.push(uncapped ? delivered : Math.min(delivered, archivedAt));
    if (!agent.archivedAt) continue;
    if (deliveries === null) {
      values.push(archivedAt);
      continue;
    }
    const inputs = [createdAt, lastUserMessageAt, delivered].filter((value): value is number => value !== null);
    if (inputs.length === 0) continue;
    const lastTurnEnd = Math.max(...inputs) + LAST_TURN_ALLOWANCE_MS;
    values.push(uncapped ? lastTurnEnd : Math.min(archivedAt, lastTurnEnd));
  }
  let latest: number | null = null;
  for (const value of values) {
    if (value !== null && (latest === null || value > latest)) latest = value;
  }
  return latest;
}

function hasNoArchiveWorkspaceLabel(workspace: WorkspaceView): boolean {
  return (workspace.labels ?? []).some((label) => label.split(/[=:]/, 1)[0]!.trim().toLowerCase() === "noarchive");
}

/**
 * A worktree's HEAD commit: `<sha7> <committer date> <subject>` for the report, and the committer
 * date as activity (work committed after the last message). Null when git cannot tell.
 */
async function headCommit(directory: string, ctx: CleanupContext): Promise<{ line: string; at: number } | null> {
  const result = await ctx.deps.merge.run("git", ["log", "-1", "--format=%h %cI %s"], directory, ctx.config.commandTimeoutSeconds * 1000);
  const line = result.code === 0 ? result.stdout.trim().split("\n")[0]?.trim() ?? "" : "";
  const at = parse(/^\S+ (\S+)/.exec(line)?.[1]);
  return line && at !== null ? { line: line.slice(0, 200), at } : null;
}

/** Decide one agentless workspace that isCleanupEntry() handed over. */
export async function evaluateCleanup(workspace: WorkspaceView, ctx: CleanupContext): Promise<Decision> {
  const worktree = workspace.workspaceKind === "worktree";
  const cleanup = worktree ? "agentless-worktree" : "stale-record";
  let lastActivityAt: string | null = null;
  const decision = (action: Decision["action"], reason: string, extra: Partial<Decision> = {}): Decision => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    agentIds: ctx.agents.map((agent) => agent.id),
    branch: workspace.gitRuntime?.currentBranch ?? null,
    base: null,
    action,
    reason,
    // Skips stay quiet (logNonCandidates); only archive and notify decisions are logged by default.
    candidate: action !== "skip",
    cleanup,
    lastActivityAt,
    ...extra,
  });

  if (workspace.archivingAt) return decision("skip", "already-archiving");
  if (ctx.agents.length > 0) return decision("skip", `agents(${ctx.agents.length})`);
  if (!workspace.workspaceDirectory) return decision("skip", "no-directory");
  if (workspace.pinnedAt) return decision("skip", "pinned");
  if (hasNoArchiveWorkspaceLabel(workspace)) return decision("skip", "noarchive-label");
  if (workspace.status !== "done") return decision("skip", `workspace-${workspace.status}`);
  if (workspace.setupStatus === "running") return decision("skip", "setup-running");
  const runningScript = workspace.scripts?.find((script) => script.lifecycle !== "stopped");
  if (runningScript) return decision("skip", `script-${runningScript.lifecycle}(${runningScript.scriptName})`);
  if (ctx.terminals > 0) return decision("skip", `terminals(${ctx.terminals})`);

  const directory = workspace.workspaceDirectory;
  const isDirectory = await ctx.deps.fs.isDirectory(directory);
  if (isDirectory === false) return decision("skip", "path-missing(left to Paseo)");
  if (isDirectory === null) return decision("skip", "ambiguous(path not statable)");

  // A worktree's HEAD committer date is activity too; a worktree whose HEAD git cannot read is skipped.
  const head = worktree ? await headCommit(directory, ctx) : null;
  if (worktree && !head) return decision("skip", "ambiguous(HEAD commit unreadable)");
  const paseoLatest = lastActivity(workspace, ctx.history, ctx.deliveries);
  const latest = head && (paseoLatest === null || head.at > paseoLatest) ? head.at : paseoLatest;
  if (latest === null) return decision("skip", "ambiguous(no activity timestamp)");
  lastActivityAt = new Date(latest).toISOString();
  const idleMinutes = Math.floor((ctx.deps.now() - latest) / 60_000);
  if (idleMinutes < ctx.config.staleWorkspaceMinutes) {
    return decision("skip", `recent(idle=${Math.max(0, idleMinutes)}m, stale after ${ctx.config.staleWorkspaceMinutes}m)`);
  }
  const idle = `idle=${formatAge(idleMinutes * 60_000)}`;

  if (!worktree) {
    // Paseo removes a directory on archive only for a Paseo-owned worktree; a record that claims one is left alone.
    if (workspace.worktreeSlug || workspace.gitRuntime?.isPaseoOwnedWorktree === true) return decision("skip", "paseo-owned-worktree-record");
    return decision("archive", `stale-record(${idle})`);
  }

  // Regenerable ignored output (__pycache__, node_modules, ...) is clean here, as on the no-PR path.
  const merge = await checkMerged(directory, {
    ...ctx.deps.merge,
    timeoutMs: ctx.config.commandTimeoutSeconds * 1000,
    useGh: ctx.config.useGh,
  }, { allowRegenerable: true });
  const facts = { branch: merge.branch ?? workspace.gitRuntime?.currentBranch ?? null, base: merge.base };
  if (merge.merged) return decision("archive", `stale-agentless-merged(${idle}; ${merge.reason})`, facts);
  if (!NOTIFY_REASONS.some((prefix) => merge.reason.startsWith(prefix))) return decision("skip", merge.reason, facts);
  if (!ctx.notified) return decision("skip", `${merge.reason}; notify-state-unreadable`, facts);
  const earlier = ctx.notified.get(workspace.id);
  if (earlier) return decision("skip", `${merge.reason}; already-notified(${earlier.at} ${earlier.status})`, facts);
  return decision("notify", `${merge.reason}; ${idle}`, { ...facts, lastCommit: head?.line ?? null });
}

export type OwnerResolution =
  | { kind: "agent"; agentId: string; via: "parent" | "project-pm" }
  | { kind: "none"; detail: string }
  | { kind: "several"; agentIds: string[] };

const nonEmpty = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null);

function newest(history: readonly AgentView[]): AgentView | null {
  let best: AgentView | null = null;
  let bestAt = -Infinity;
  for (const agent of history) {
    const at = parse(agent.createdAt) ?? parse(agent.updatedAt) ?? -Infinity;
    if (best === null || at > bestAt) {
      best = agent;
      bestAt = at;
    }
  }
  return best;
}

/** What names a kept worktree's PM: its last agent's parent labels and the project names to match. */
export interface OwnerKeys {
  /** The last agent's `paseo.parent-agent-id` label (a full id). */
  parentId: string | null;
  /** That label, else the `parent` label (an id prefix). */
  parent: string | null;
  /** The last agent's `project` label and the workspace's project name, trimmed, as written. */
  names: string[];
}

export function ownerKeys(workspace: WorkspaceView, history: readonly AgentView[]): OwnerKeys {
  const last = newest(history);
  const parentId = nonEmpty(last?.labels?.["paseo.parent-agent-id"]);
  const names = [nonEmpty(last?.labels?.project), nonEmpty(workspace.projectDisplayName)].filter((name): name is string => name !== null);
  return { parentId, parent: parentId ?? nonEmpty(last?.labels?.parent), names: [...new Set(names)] };
}

/**
 * The PM to tell about a kept worktree: the parent named by the labels `paseo.parent-agent-id`
 * (full id) or `parent` (id prefix) of the workspace's last agent when that parent is live; else the
 * one live agent labelled role=pm whose `project` label matches (case-insensitively) the last
 * agent's `project` label or the workspace's project name. None or several: nobody is told here
 * (with none, peer daemons may be asked: see peers.ts).
 */
export function resolveOwner(workspace: WorkspaceView, history: readonly AgentView[], live: readonly AgentView[]): OwnerResolution {
  const { parent, names: projectNames } = ownerKeys(workspace, history);
  if (parent) {
    const exact = live.find((agent) => agent.id === parent);
    if (exact) return { kind: "agent", agentId: exact.id, via: "parent" };
    const byPrefix = live.filter((agent) => agent.id.startsWith(parent));
    if (byPrefix.length === 1) return { kind: "agent", agentId: byPrefix[0]!.id, via: "parent" };
  }
  const names = new Set(projectNames.map((name) => name.toLowerCase()));
  if (names.size === 0) return { kind: "none", detail: "no project name" };
  const pms = matchProjectPms(live, projectNames);
  if (pms.length === 1) return { kind: "agent", agentId: pms[0]!.id, via: "project-pm" };
  if (pms.length === 0) return { kind: "none", detail: `no live role=pm agent for project ${[...names].join("|")}${parent ? ` and parent ${parent} not live` : ""}` };
  return { kind: "several", agentIds: pms.map((agent) => agent.id) };
}

/** The live agents labelled role=pm whose `project` label matches one of `names`, both case-insensitively. */
export function matchProjectPms(live: readonly AgentView[], names: readonly string[]): AgentView[] {
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  return live.filter((agent) => {
    const project = nonEmpty(agent.labels?.project)?.toLowerCase();
    return !agent.archivedAt && agent.labels?.role?.trim().toLowerCase() === "pm" && project !== undefined && project !== null && wanted.has(project);
  });
}

/**
 * Why a PM must not be messaged now, or null when it may be: it is gone, archived, in any status other than idle
 * or closed (a message would interrupt or steer a turn, or end an error a usage-limit resume is waiting on), or has
 * a pending permission request (a message clears it). Messaging an archived agent unarchives it.
 */
export function pmBusyReason(agent: AgentView | null): string | null {
  if (!agent) return "gone";
  if (agent.archivedAt) return "archived";
  if (agent.status !== "idle" && agent.status !== "closed") return agent.status;
  if ((agent.pendingPermissions?.length ?? 0) > 0) return "pending permission";
  return null;
}

/** A duration as its two largest units: "3d 4h", "5h 12m", "7m". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${minutes}m`;
}

/** One message per PM per sweep, listing each newly kept worktree once. */
export function formatNotification(items: ReadonlyArray<{ decision: Decision; directory: string }>, staleMinutes: number, now: number): string {
  const lines = [
    `[merged-worker-archiver] ${items.length === 1 ? "This worktree workspace has" : `These ${items.length} worktree workspaces have`} no agents and no activity for at least ${formatAge(staleMinutes * 60_000)}. I will not archive ${items.length === 1 ? "it" : "them"}: the branch is not merged into its base, or the tree is not clean. Merge or clean up and archive ${items.length === 1 ? "it" : "them"}, or archive ${items.length === 1 ? "it" : "them"} if no longer needed. You get this once per worktree.`,
  ];
  items.forEach(({ decision, directory }, index) => {
    const age = decision.lastActivityAt ? formatAge(now - Date.parse(decision.lastActivityAt)) : null;
    lines.push(
      "",
      `${index + 1}. ${decision.workspaceName} (${decision.workspaceId})`,
      `   path: ${directory}`,
      `   branch: ${decision.branch ?? "(detached or unknown)"}`,
      `   last commit: ${decision.lastCommit ?? "(unknown)"}`,
      `   age: ${age ?? "unknown"} since last activity${decision.lastActivityAt ? ` (${decision.lastActivityAt})` : ""}`,
      `   why kept: ${decision.reason.replace(/; idle=[^;]*$/, "")}`,
    );
  });
  return lines.join("\n");
}

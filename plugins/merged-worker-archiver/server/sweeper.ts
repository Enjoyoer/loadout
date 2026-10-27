import { createHash } from "node:crypto";
import { evaluateCleanup, formatNotification, isCleanupEntry, resolveOwner, type NotifiedEntry } from "./cleanup.ts";
import type { ArchiverConfig } from "./config.ts";
import { evaluateWorkspace, type EvaluateDeps } from "./evaluate.ts";
import type { NotifyStateStore } from "./notify-store.ts";
import type { AgentView, CommonDirResolver, Decision, TerminalView, WorkspaceView } from "./types.ts";

// The slice of the Paseo daemon client this plugin uses (see daemon.ts).
interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
interface PageRequest {
  page?: { limit: number; cursor?: string };
}
export interface ArchiverApi {
  workspaces: {
    list(options?: PageRequest & { filter?: { includeBackground?: boolean } }): Promise<Page<WorkspaceView>>;
    archive(workspaceId: string): Promise<{ archivedAt: string | null; error: string | null }>;
  };
  agents: {
    list(options?: PageRequest & { filter?: { includeBackground?: boolean; includeArchived?: boolean } }): Promise<Page<{ agent: AgentView }>>;
    /** One agent by id, archived included; null when there is none. Read just before a PM report is sent. */
    get?(agentId: string): Promise<AgentView | null>;
  };
  projects: {
    list(): Promise<{ projects: ReadonlyArray<{ projectRootPath?: string | null }> }>;
  };
  /** Every live terminal on the daemon. Workspace cleanup only. */
  terminals?: {
    list(): Promise<{ entries: ReadonlyArray<TerminalView> }>;
  };
  /**
   * True when the daemon has background workspaces (Paseo 0.12 and later), which every workspace and
   * agent listing must then ask for; older daemons have none, and the client refuses the filter there.
   */
  supportsBackgroundWorkspaces(): boolean;
  /**
   * Prompt an agent; the daemon keeps a receipt per (agent, messageId) and never delivers one twice.
   * "steer" adds the text to a turn that started meanwhile where the provider can steer.
   */
  sendAgentMessage?(agentId: string, text: string, options: { messageId: string; activeTurnBehavior: "steer" }): Promise<unknown>;
}

export interface ApiLease {
  api: ArchiverApi;
  release(): Promise<void>;
}

export interface SweeperDeps extends EvaluateDeps {
  acquireApi(): Promise<ApiLease>;
  log(line: string): void;
  resolveCommonDir: CommonDirResolver;
  /** Worktrees already reported to their PM (workspace cleanup). */
  notifyStore: NotifyStateStore;
}

export interface SweepOptions {
  trigger: string;
  /**
   * Event-scoped sweep: evaluate these workspaces plus every worktree in the same
   * project (projectId) or the same repository (git common dir). Omit for a full sweep.
   */
  triggerWorkspaceIds?: ReadonlySet<string>;
  /** When the first coalesced event arrived (ms epoch), for the latency log. */
  eventAt?: number;
  /** Force log-only mode regardless of config.armed: nothing is archived, sent, or written. */
  forceDryRun?: boolean;
}

export interface SweepResult {
  decisions: Decision[];
  archived: string[];
  /** Candidates that passed every gate except "merged": clean, idle, own commits. */
  pendingMerge: string[];
  error: string | null;
}

export function isPendingMerge(decision: Decision): boolean {
  return decision.candidate && decision.action === "skip" && decision.reason.startsWith("not-merged(");
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/**
 * After its Nth consecutive failed archive call a workspace sits out the next
 * 2^(N-1) sweeps that find it eligible (1, 2, 4, then at most 8), so it stops taking
 * cap slots from the candidates behind it. Kept in memory only; it is always retried.
 */
const MAX_BACKOFF_EXPONENT = 3;

interface Backoff {
  failures: number;
  sweeps: number;
  skipsLeft: number;
}

async function listAll<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, label: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    all.push(...result.entries);
    if (!result.pageInfo.hasMore) return all;
    if (!result.pageInfo.nextCursor) throw new Error(`${label} pagination reported more pages without a cursor`);
    cursor = result.pageInfo.nextCursor;
  }
  // An incomplete agent list could hide a running agent: never decide on partial data.
  throw new Error(`${label} exceeded ${MAX_PAGES} pages`);
}

/** At most this many worktrees go into one PM report; the rest wait for the next full sweep. */
const MAX_REPORT_ITEMS = 20;

/**
 * Every project's root path. A missing project API, a failed call, or any project without a root path
 * throws, which aborts the sweep (nothing is archived), like an incomplete agent list.
 */
async function projectRoots(api: ArchiverApi): Promise<string[]> {
  if (typeof api.projects?.list !== "function") throw new Error("project list unavailable");
  const result = await api.projects.list();
  if (!result || !Array.isArray(result.projects)) throw new Error("project list malformed");
  const roots = result.projects.map((project) => project.projectRootPath);
  if (!roots.every((root): root is string => typeof root === "string" && root.length > 0)) throw new Error("project without a root path");
  return roots;
}

interface Snapshot {
  workspaces: WorkspaceView[];
  /** Non-archived agents per workspace. */
  agentsByWorkspace: Map<string, AgentView[]>;
  /** Every non-archived agent on the daemon. */
  liveAgents: AgentView[];
  projectRoots: string[];
  /** What workspace cleanup reads, when asked for; null when it could not be read (see cleanupError). */
  cleanup: CleanupData | null;
  cleanupError: string | null;
}

interface CleanupData {
  /** Every agent per workspace, archived included. */
  historyByWorkspace: Map<string, AgentView[]>;
  /** Live terminals per workspace. */
  terminalsByWorkspace: Map<string, number>;
}

function group<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/**
 * Live state. Background workspaces and their agents are listed whenever the daemon has them; a
 * client that cannot say whether it does aborts the sweep, as does a failed or incomplete workspace,
 * agent or project list. `withCleanup` also lists every agent with archived ones (a separate, larger
 * listing) and the terminals, which only workspace cleanup reads: if either fails or is incomplete,
 * only cleanup is left out (`cleanup` null), never the worker sweep.
 */
async function snapshot(api: ArchiverApi, withCleanup: boolean): Promise<Snapshot> {
  if (typeof api.supportsBackgroundWorkspaces !== "function") throw new Error("daemon client cannot tell whether background workspaces exist");
  const background = api.supportsBackgroundWorkspaces() === true;
  const backgroundFilter = background ? { includeBackground: true } : {};
  const page = (cursor?: string) => ({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
  const workspaces = await listAll((cursor) => api.workspaces.list({ ...(background ? { filter: backgroundFilter } : {}), ...page(cursor) }), "workspaces");
  const agentEntries = await listAll((cursor) => api.agents.list({ ...(background ? { filter: backgroundFilter } : {}), ...page(cursor) }), "agents");
  const agentsByWorkspace = new Map<string, AgentView[]>();
  const liveAgents: AgentView[] = [];
  for (const { agent } of agentEntries) {
    if (agent.archivedAt) continue;
    liveAgents.push(agent);
    if (agent.workspaceId) group(agentsByWorkspace, agent.workspaceId, agent);
  }
  const roots = await projectRoots(api);
  let cleanup: CleanupData | null = null;
  let cleanupError: string | null = null;
  if (withCleanup) {
    try {
      cleanup = await cleanupData(api, backgroundFilter, page);
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  return { workspaces, agentsByWorkspace, liveAgents, projectRoots: roots, cleanup, cleanupError };
}

async function cleanupData(
  api: ArchiverApi,
  backgroundFilter: { includeBackground?: boolean },
  page: (cursor?: string) => PageRequest,
): Promise<CleanupData> {
  const history = await listAll((cursor) => api.agents.list({ filter: { ...backgroundFilter, includeArchived: true }, ...page(cursor) }), "agent history");
  const historyByWorkspace = new Map<string, AgentView[]>();
  for (const { agent } of history) if (agent.workspaceId) group(historyByWorkspace, agent.workspaceId, agent);
  if (typeof api.terminals?.list !== "function") throw new Error("terminal list unavailable");
  const { entries } = await api.terminals.list();
  if (!Array.isArray(entries)) throw new Error("terminal list malformed");
  const terminalsByWorkspace = new Map<string, number>();
  for (const terminal of entries) {
    if (!terminal.workspaceId) throw new Error(`terminal ${terminal.id} has no workspace`);
    terminalsByWorkspace.set(terminal.workspaceId, (terminalsByWorkspace.get(terminal.workspaceId) ?? 0) + 1);
  }
  return { historyByWorkspace, terminalsByWorkspace };
}

export function formatDecision(decision: Decision, action: string, extra: Record<string, unknown> = {}): string {
  return `[merged-worker-archiver] ${JSON.stringify({
    action,
    workspaceId: decision.workspaceId,
    name: decision.workspaceName,
    agentIds: decision.agentIds,
    branch: decision.branch,
    base: decision.base,
    reason: decision.reason,
    ...(decision.cleanup ? { cleanup: decision.cleanup, lastActivityAt: decision.lastActivityAt ?? null } : {}),
    ...extra,
  })}`;
}

/**
 * The worker decision, or for a full sweep the workspace cleanup decision it hands over to. Without
 * cleanup data in the snapshot the worker decision stands.
 */
async function decide(
  workspace: WorkspaceView,
  state: Snapshot,
  config: ArchiverConfig,
  deps: EvaluateDeps,
  cleanup: { notified: ReadonlyMap<string, NotifiedEntry> | null } | null,
): Promise<Decision> {
  const agents = state.agentsByWorkspace.get(workspace.id) ?? [];
  const decision = await evaluateWorkspace(workspace, agents, config, deps, state.projectRoots);
  if (!cleanup || !state.cleanup || !isCleanupEntry(decision)) return decision;
  return evaluateCleanup(workspace, {
    config,
    deps,
    agents,
    history: state.cleanup.historyByWorkspace.get(workspace.id) ?? [],
    terminals: state.cleanup.terminalsByWorkspace.get(workspace.id) ?? 0,
    notified: cleanup.notified,
  });
}

/** The daemon refused before delivery, so the report may be sent again later. */
function isRetryableSendError(message: string): boolean {
  return /^Agent not found: /.test(message) || message === "agent messaging unavailable";
}

export class Sweeper {
  private running: Promise<SweepResult> | null = null;
  private readonly deps: SweeperDeps;
  private readonly backoffs = new Map<string, Backoff>();
  /** Workspaces an armed sweep deferred at the cap, with the number of the sweep that first deferred them. */
  private readonly waitingSince = new Map<string, number>();
  private sweepCount = 0;

  constructor(deps: SweeperDeps) {
    this.deps = deps;
  }

  private noteArchiveFailure(workspaceId: string): Backoff {
    const failures = (this.backoffs.get(workspaceId)?.failures ?? 0) + 1;
    const sweeps = 2 ** Math.min(failures - 1, MAX_BACKOFF_EXPONENT);
    const backoff = { failures, sweeps, skipsLeft: sweeps };
    this.backoffs.set(workspaceId, backoff);
    return backoff;
  }

  /** Triggers, plus every worktree sharing a trigger's projectId or git common dir. */
  private async scope(workspaces: readonly WorkspaceView[], triggerIds: ReadonlySet<string>): Promise<WorkspaceView[]> {
    const triggers = workspaces.filter((workspace) => triggerIds.has(workspace.id));
    const projectIds = new Set(triggers.map((workspace) => workspace.projectId).filter((id): id is string => Boolean(id)));
    const commonDirs = new Set<string>();
    for (const trigger of triggers) {
      if (!trigger.workspaceDirectory) continue;
      const commonDir = await this.deps.resolveCommonDir(trigger.workspaceDirectory);
      if (commonDir) commonDirs.add(commonDir);
    }
    const selected: WorkspaceView[] = [];
    for (const workspace of workspaces) {
      if (triggerIds.has(workspace.id) || (workspace.projectId && projectIds.has(workspace.projectId))) {
        selected.push(workspace);
        continue;
      }
      if (workspace.workspaceKind !== "worktree" || !workspace.workspaceDirectory || commonDirs.size === 0) continue;
      const commonDir = await this.deps.resolveCommonDir(workspace.workspaceDirectory);
      if (commonDir && commonDirs.has(commonDir)) selected.push(workspace);
    }
    return selected;
  }

  /** Serialized: a sweep requested while one runs waits for it, then runs fresh. */
  async sweep(config: ArchiverConfig, options: SweepOptions): Promise<SweepResult> {
    while (this.running) await this.running.catch(() => undefined);
    const current = this.runSweep(config, options);
    this.running = current;
    try {
      return await current;
    } finally {
      if (this.running === current) this.running = null;
    }
  }

  private async runSweep(config: ArchiverConfig, options: SweepOptions): Promise<SweepResult> {
    const dryRun = options.forceDryRun === true || config.armed !== true;
    // Workspace cleanup runs in full sweeps only and acts only when both switches are on.
    const fullSweep = !options.triggerWorkspaceIds;
    const cleanupDryRun = dryRun || config.armWorkspaceCleanup !== true;
    const log = this.deps.log;
    const sweepNumber = ++this.sweepCount;
    let lease: ApiLease;
    try {
      lease = await this.deps.acquireApi();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[merged-worker-archiver] sweep-aborted trigger=${options.trigger} reason=${JSON.stringify(`daemon-unavailable: ${message}`)}`);
      return { decisions: [], archived: [], pendingMerge: [], error: message };
    }
    const decisions: Decision[] = [];
    const archived: string[] = [];
    try {
      const state = await snapshot(lease.api, fullSweep);
      // Cleanup data that cannot be read leaves out workspace cleanup only; the worker sweep goes on.
      const cleanupRuns = fullSweep && state.cleanup !== null;
      if (fullSweep && !cleanupRuns) {
        log(`[merged-worker-archiver] cleanup-skipped reason=${JSON.stringify(state.cleanupError)} (worker sweep continues; workspace cleanup waits for the next full sweep)`);
      }
      let notified: Map<string, NotifiedEntry> | null = null;
      if (cleanupRuns) {
        try {
          notified = await this.deps.notifyStore.read();
        } catch (error) {
          log(`[merged-worker-archiver] notify-state-unreadable reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} (no PM report is sent until it is fixed or removed)`);
        }
      }
      const cleanupInput = cleanupRuns ? { notified } : null;
      const inScope = options.triggerWorkspaceIds
        ? await this.scope(state.workspaces, options.triggerWorkspaceIds)
        : state.workspaces;
      if (!options.triggerWorkspaceIds) {
        // A full sweep sees every workspace: forget back-offs and waits of workspaces that are gone.
        const listed = new Set(state.workspaces.map((workspace) => workspace.id));
        for (const workspaceId of this.backoffs.keys()) if (!listed.has(workspaceId)) this.backoffs.delete(workspaceId);
        for (const workspaceId of this.waitingSince.keys()) if (!listed.has(workspaceId)) this.waitingSince.delete(workspaceId);
      }
      // Fair order across sweeps: workspaces the cap deferred go first, longest-waiting first, then
      // the rest in listing order. Candidates ahead of a deferred one cannot hold the slots forever,
      // even when their archive calls keep failing.
      const waitRank = (workspace: WorkspaceView) => this.waitingSince.get(workspace.id) ?? Number.MAX_SAFE_INTEGER;
      const ordered = [...inScope].sort((a, b) => waitRank(a) - waitRank(b));
      let nonCandidates = 0;
      // Archive attempts (would-archive in dry-run) left this sweep; the rest wait for the next sweep.
      // Backed-off workspaces do not take a slot, so later candidates get it.
      let remaining = config.maxArchivesPerSweep;
      const deferred = new Set<string>();
      const backedOff = new Set<string>();
      const toNotify: Decision[] = [];
      for (const workspace of ordered) {
        // Dry-run attempts nothing, so only an armed sweep moves the queue; a workspace stays
        // queued, keeping its place, only while the cap keeps deferring it.
        const waitingSince = this.waitingSince.get(workspace.id);
        if (!dryRun) this.waitingSince.delete(workspace.id);
        const decision = await decide(workspace, state, config, this.deps, cleanupInput);
        decisions.push(decision);
        if (!decision.candidate) {
          nonCandidates += 1;
          if (config.logNonCandidates) log(formatDecision(decision, "skip"));
          continue;
        }
        if (decision.action === "skip") {
          log(formatDecision(decision, "skip"));
          continue;
        }
        if (decision.action === "notify") {
          toNotify.push(decision);
          continue;
        }
        if (decision.cleanup && cleanupDryRun && !dryRun) {
          // Worker archiving is armed but workspace cleanup is not: a preview that takes no armed slot.
          log(formatDecision(decision, "would-archive"));
          continue;
        }
        const backoff = this.backoffs.get(workspace.id);
        if (backoff && backoff.skipsLeft > 0) {
          backoff.skipsLeft -= 1;
          backedOff.add(workspace.id);
          const progress = `${backoff.sweeps - backoff.skipsLeft}/${backoff.sweeps}`;
          log(formatDecision({ ...decision, reason: `${decision.reason}; archive back-off sweep ${progress} after ${backoff.failures} failed archive call(s)` }, "backoff"));
          continue;
        }
        if (remaining <= 0) {
          deferred.add(workspace.id);
          if (!dryRun) this.waitingSince.set(workspace.id, waitingSince ?? sweepNumber);
          log(formatDecision({ ...decision, reason: `${decision.reason}; maxArchivesPerSweep=${config.maxArchivesPerSweep} reached` }, "deferred"));
          continue;
        }
        if (dryRun) {
          remaining -= 1;
          log(formatDecision(decision, "would-archive"));
          continue;
        }
        // Re-read live state and re-run every gate immediately before acting.
        const fresh = await snapshot(lease.api, Boolean(decision.cleanup));
        const freshWorkspace = fresh.workspaces.find((candidate) => candidate.id === workspace.id);
        if (!freshWorkspace) {
          log(formatDecision({ ...decision, reason: "recheck: workspace gone" }, "skip"));
          continue;
        }
        if (decision.cleanup && !fresh.cleanup) {
          log(formatDecision({ ...decision, reason: `recheck: cleanup data unavailable: ${fresh.cleanupError}` }, "skip"));
          continue;
        }
        const recheck = await decide(freshWorkspace, fresh, config, this.deps, decision.cleanup ? cleanupInput : null);
        if (recheck.action !== "archive" || recheck.cleanup !== decision.cleanup) {
          log(formatDecision({ ...recheck, reason: `recheck: ${recheck.reason}` }, "skip"));
          continue;
        }
        remaining -= 1;
        let failure: string;
        try {
          const result = await lease.api.workspaces.archive(workspace.id);
          if (!result.error) {
            this.backoffs.delete(workspace.id);
            archived.push(workspace.id);
            log(formatDecision(recheck, "archived"));
            continue;
          }
          failure = `archive error: ${result.error}`;
        } catch (error) {
          failure = `archive threw: ${error instanceof Error ? error.message : String(error)}`;
        }
        const { sweeps } = this.noteArchiveFailure(workspace.id);
        log(formatDecision({ ...recheck, reason: `${recheck.reason}; ${failure}; back-off ${sweeps} sweep(s)` }, "archive-failed"));
      }
      const reported = await this.report(lease.api, toNotify, state, notified, config, cleanupDryRun);
      if (cleanupRuns && notified && !cleanupDryRun) await this.pruneNotified(notified, state);
      const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
        const key = !decision.candidate
          ? "nonCandidate"
          : deferred.has(decision.workspaceId)
            ? "deferred"
            : backedOff.has(decision.workspaceId)
              ? "backoff"
              : decision.action;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const cleanup = fullSweep
        ? decisions.reduce<Record<string, number>>((acc, decision) => {
          if (!decision.cleanup) return acc;
          const key = decision.action === "skip" ? (decision.reason.includes("already-notified(") ? "alreadyNotified" : "skip") : decision.action;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {})
        : undefined;
      const pendingMerge = decisions.filter(isPendingMerge).map((decision) => decision.workspaceId);
      const latencyMs = options.eventAt === undefined ? undefined : this.deps.now() - options.eventAt;
      log(
        `[merged-worker-archiver] sweep-done ${JSON.stringify({
          trigger: options.trigger,
          mode: dryRun ? "dry-run" : "armed",
          ...(fullSweep
            ? { cleanupMode: cleanupDryRun ? "dry-run" : "armed", cleanup, reports: reported, ...(cleanupRuns ? {} : { cleanupSkipped: state.cleanupError }) }
            : {}),
          evaluated: decisions.length,
          nonCandidates,
          counts,
          archived,
          deferred: deferred.size,
          backoff: backedOff.size,
          pendingMerge,
          latencyMs,
        })}`,
      );
      return { decisions, archived, pendingMerge, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[merged-worker-archiver] sweep-aborted trigger=${options.trigger} reason=${JSON.stringify(message)}`);
      return { decisions, archived, pendingMerge: [], error: message };
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  /**
   * Tell each kept worktree's PM about it, once. Armed: live state is re-read, every gate re-run and
   * the PM resolved again, and right before each send the PM's own status is read again (only an
   * idle or closed, unarchived PM without a pending permission is sent to, with "steer"); one message
   * per PM, at most MAX_REPORT_ITEMS worktrees each. A worktree is recorded as reported before the
   * message goes out, so it is never reported twice: a refusal before delivery (the PM is gone)
   * removes the record again, any other failure keeps it as `unconfirmed`. Returns the worktrees
   * reported (or, in dry-run, that would be).
   */
  private async report(
    api: ArchiverApi,
    candidates: Decision[],
    state: Snapshot,
    notified: Map<string, NotifiedEntry> | null,
    config: ArchiverConfig,
    wouldOnly: boolean,
  ): Promise<string[]> {
    const log = this.deps.log;
    if (candidates.length === 0 || !notified) return [];
    let current = state;
    let confirmed = candidates;
    if (!wouldOnly) {
      current = await snapshot(api, true);
      if (!current.cleanup) {
        for (const candidate of candidates) {
          log(formatDecision(candidate, "notify-deferred", { why: `cleanup data unavailable, next full sweep: ${current.cleanupError}` }));
        }
        return [];
      }
      confirmed = [];
      for (const candidate of candidates) {
        const workspace = current.workspaces.find((entry) => entry.id === candidate.workspaceId);
        const recheck = workspace ? await decide(workspace, current, config, this.deps, { notified }) : null;
        if (!recheck || recheck.action !== "notify") {
          log(formatDecision({ ...(recheck ?? candidate), reason: `recheck: ${recheck ? recheck.reason : "workspace gone"}` }, "skip"));
          continue;
        }
        confirmed.push(recheck);
      }
    }
    const groups = new Map<string, Array<{ decision: Decision; directory: string; via: string }>>();
    for (const decision of confirmed) {
      const workspace = current.workspaces.find((entry) => entry.id === decision.workspaceId)!;
      const owner = resolveOwner(workspace, current.cleanup?.historyByWorkspace.get(workspace.id) ?? [], current.liveAgents);
      const directory = workspace.workspaceDirectory ?? "";
      if (owner.kind !== "agent") {
        const detail = owner.kind === "none" ? `no owner: ${owner.detail}` : `several owners: ${owner.agentIds.join(",")}`;
        log(formatDecision(decision, "notify-unrouted", { path: directory, lastCommit: decision.lastCommit ?? null, owner: detail }));
        continue;
      }
      const list = groups.get(owner.agentId) ?? [];
      list.push({ decision, directory, via: owner.via });
      groups.set(owner.agentId, list);
    }
    const reported: string[] = [];
    for (const [agentId, items] of groups) {
      const batch = items.slice(0, MAX_REPORT_ITEMS);
      for (const item of items.slice(MAX_REPORT_ITEMS)) {
        log(formatDecision(item.decision, "notify-deferred", { owner: agentId, why: `more than ${MAX_REPORT_ITEMS} worktrees for one PM; next sweep` }));
      }
      const lineFor = (item: (typeof items)[number], action: string, extra: Record<string, unknown> = {}) =>
        formatDecision(item.decision, action, { path: item.directory, lastCommit: item.decision.lastCommit ?? null, owner: agentId, via: item.via, ...extra });
      if (wouldOnly) {
        for (const item of batch) {
          log(lineFor(item, "would-notify"));
          reported.push(item.decision.workspaceId);
        }
        continue;
      }
      // Send only to a quiet PM, read again right here: the rechecks above can take tens of seconds.
      // A message to an agent in a turn interrupts or steers it, one with a pending permission request
      // clears it, and one to an archived agent unarchives it.
      let busy: string | null;
      try {
        if (typeof api.agents.get !== "function") throw new Error("agent lookup unavailable");
        const owner = await api.agents.get(agentId);
        busy = !owner
          ? "gone"
          : owner.archivedAt
            ? "archived"
            : owner.status === "running" || owner.status === "initializing"
              ? owner.status
              : (owner.pendingPermissions?.length ?? 0) > 0
                ? "pending permission"
                : null;
      } catch (error) {
        busy = `status unreadable (${error instanceof Error ? error.message : String(error)})`;
      }
      if (busy) {
        for (const item of batch) log(lineFor(item, "notify-deferred", { why: `PM ${busy}; next full sweep` }));
        continue;
      }
      const at = new Date(this.deps.now()).toISOString();
      for (const item of batch) notified.set(item.decision.workspaceId, { at, agentId, status: "sending" });
      try {
        await this.deps.notifyStore.write(notified);
      } catch (error) {
        for (const item of batch) notified.delete(item.decision.workspaceId);
        for (const item of batch) log(lineFor(item, "notify-failed", { why: `state not written, nothing sent: ${error instanceof Error ? error.message : String(error)}` }));
        continue;
      }
      const ids = batch.map((item) => item.decision.workspaceId).sort();
      const messageId = `merged-worker-archiver-report-${createHash("sha256").update(`${agentId}\n${ids.join("\n")}`).digest("hex").slice(0, 32)}`;
      const text = formatNotification(batch, config.staleWorkspaceMinutes, this.deps.now());
      let outcome: { status: NotifiedEntry["status"] | "retry"; why?: string };
      try {
        if (typeof api.sendAgentMessage !== "function") throw new Error("agent messaging unavailable");
        await api.sendAgentMessage(agentId, text, { messageId, activeTurnBehavior: "steer" });
        outcome = { status: "sent" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = isRetryableSendError(message) ? { status: "retry", why: message } : { status: "unconfirmed", why: message };
      }
      for (const item of batch) {
        if (outcome.status === "retry") notified.delete(item.decision.workspaceId);
        else notified.set(item.decision.workspaceId, { at, agentId, status: outcome.status });
      }
      try {
        await this.deps.notifyStore.write(notified);
      } catch (error) {
        log(`[merged-worker-archiver] notify-state-write-failed reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} (entries stay marked sending, never resent)`);
      }
      for (const item of batch) {
        if (outcome.status === "sent") {
          log(lineFor(item, "notified", { messageId }));
          reported.push(item.decision.workspaceId);
        } else if (outcome.status === "retry") log(lineFor(item, "notify-deferred", { why: `refused before delivery, retried next full sweep: ${outcome.why}` }));
        else log(lineFor(item, "notify-failed", { why: `delivery unknown, not resent: ${outcome.why}` }));
      }
    }
    return reported;
  }

  /** Armed workspace cleanup only: forget reported worktrees that are no longer listed. */
  private async pruneNotified(notified: Map<string, NotifiedEntry>, state: Snapshot): Promise<void> {
    const listed = new Set(state.workspaces.map((workspace) => workspace.id));
    const gone = [...notified.keys()].filter((workspaceId) => !listed.has(workspaceId));
    if (gone.length === 0) return;
    for (const workspaceId of gone) notified.delete(workspaceId);
    try {
      await this.deps.notifyStore.write(notified);
    } catch (error) {
      this.deps.log(`[merged-worker-archiver] notify-state-write-failed reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

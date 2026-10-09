import type { ArchiverConfig } from "./config.ts";
import { evaluateWorkspace, type EvaluateDeps } from "./evaluate.ts";
import type { AgentView, CommonDirResolver, Decision, WorkspaceView } from "./types.ts";

// The slice of the public PaseoApi (@getpaseo/client 0.9.1) this plugin uses.
interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
export interface ArchiverApi {
  workspaces: {
    list(options?: { page?: { limit: number; cursor?: string } }): Promise<Page<WorkspaceView>>;
    archive(workspaceId: string): Promise<{ archivedAt: string | null; error: string | null }>;
  };
  agents: {
    list(options?: { page?: { limit: number; cursor?: string } }): Promise<Page<{ agent: AgentView }>>;
  };
}

export interface ApiLease {
  api: ArchiverApi;
  release(): Promise<void>;
}

export interface SweeperDeps extends EvaluateDeps {
  acquireApi(): Promise<ApiLease>;
  log(line: string): void;
  resolveCommonDir: CommonDirResolver;
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
  /** Force log-only mode regardless of config.armed. */
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

async function snapshot(api: ArchiverApi): Promise<{ workspaces: WorkspaceView[]; agentsByWorkspace: Map<string, AgentView[]> }> {
  const workspaces = await listAll((cursor) => api.workspaces.list({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } }), "workspaces");
  const agentEntries = await listAll((cursor) => api.agents.list({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } }), "agents");
  const agentsByWorkspace = new Map<string, AgentView[]>();
  for (const { agent } of agentEntries) {
    if (!agent.workspaceId || agent.archivedAt) continue;
    const list = agentsByWorkspace.get(agent.workspaceId) ?? [];
    list.push(agent);
    agentsByWorkspace.set(agent.workspaceId, list);
  }
  return { workspaces, agentsByWorkspace };
}

export function formatDecision(decision: Decision, action: string): string {
  return `[merged-worker-archiver] ${JSON.stringify({
    action,
    workspaceId: decision.workspaceId,
    name: decision.workspaceName,
    agentIds: decision.agentIds,
    branch: decision.branch,
    base: decision.base,
    reason: decision.reason,
  })}`;
}

export class Sweeper {
  private running: Promise<SweepResult> | null = null;
  private readonly deps: SweeperDeps;

  constructor(deps: SweeperDeps) {
    this.deps = deps;
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
    const log = this.deps.log;
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
      const state = await snapshot(lease.api);
      const inScope = options.triggerWorkspaceIds
        ? await this.scope(state.workspaces, options.triggerWorkspaceIds)
        : state.workspaces;
      let nonCandidates = 0;
      // Archive attempts (would-archive in dry-run) left this sweep; the rest wait for the next sweep.
      let remaining = config.maxArchivesPerSweep;
      const deferred = new Set<string>();
      for (const workspace of inScope) {
        const agents = state.agentsByWorkspace.get(workspace.id) ?? [];
        const decision = await evaluateWorkspace(workspace, agents, config, this.deps);
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
        if (remaining <= 0) {
          deferred.add(workspace.id);
          log(formatDecision({ ...decision, reason: `${decision.reason}; maxArchivesPerSweep=${config.maxArchivesPerSweep} reached` }, "deferred"));
          continue;
        }
        if (dryRun) {
          remaining -= 1;
          log(formatDecision(decision, "would-archive"));
          continue;
        }
        // Re-read live state and re-run every gate immediately before acting.
        const fresh = await snapshot(lease.api);
        const freshWorkspace = fresh.workspaces.find((candidate) => candidate.id === workspace.id);
        if (!freshWorkspace) {
          log(formatDecision({ ...decision, reason: "recheck: workspace gone" }, "skip"));
          continue;
        }
        const recheck = await evaluateWorkspace(freshWorkspace, fresh.agentsByWorkspace.get(workspace.id) ?? [], config, this.deps);
        if (recheck.action !== "archive") {
          log(formatDecision({ ...recheck, reason: `recheck: ${recheck.reason}` }, "skip"));
          continue;
        }
        remaining -= 1;
        try {
          const result = await lease.api.workspaces.archive(workspace.id);
          if (result.error) {
            log(formatDecision({ ...recheck, reason: `${recheck.reason}; archive error: ${result.error}` }, "archive-failed"));
            continue;
          }
          archived.push(workspace.id);
          log(formatDecision(recheck, "archived"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(formatDecision({ ...recheck, reason: `${recheck.reason}; archive threw: ${message}` }, "archive-failed"));
        }
      }
      const counts = decisions.reduce<Record<string, number>>((acc, decision) => {
        const key = !decision.candidate ? "nonCandidate" : deferred.has(decision.workspaceId) ? "deferred" : decision.action;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const pendingMerge = decisions.filter(isPendingMerge).map((decision) => decision.workspaceId);
      const latencyMs = options.eventAt === undefined ? undefined : this.deps.now() - options.eventAt;
      log(
        `[merged-worker-archiver] sweep-done ${JSON.stringify({ trigger: options.trigger, mode: dryRun ? "dry-run" : "armed", evaluated: decisions.length, nonCandidates, counts, archived, deferred: deferred.size, pendingMerge, latencyMs })}`,
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
}

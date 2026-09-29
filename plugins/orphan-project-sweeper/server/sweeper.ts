import { lstat } from "node:fs/promises";
import { withDaemon, type DaemonClient } from "./daemon";

const TAG = "[orphan-project-sweeper]";

/** Delay before the one-shot startup sweep so plugin load does not race the daemon. */
export const STARTUP_SWEEP_DELAY_MS = 5_000;
/** Deferred re-check schedule after workspace.archived: 5 attempts over about 5 minutes. */
export const RECHECK_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000, 90_000, 120_000];
/** Upper bound on simultaneously tracked archive candidates. */
export const MAX_TRACKED_CANDIDATES = 64;
const WORKSPACE_PAGE_LIMIT = 200;

type ProjectRow = Awaited<ReturnType<DaemonClient["listProjects"]>>["projects"][number];

export type SkipReason =
  | "project-missing"
  | "path-still-exists"
  | "path-unverifiable"
  | "active-workspaces";

export type Verdict =
  | { kind: "delete"; projectId: string; path: string; name: string }
  | { kind: "skip"; projectId: string; path: string | null; name: string | null; reason: SkipReason; detail: string };

type PathState = { exists: true; how: string } | { exists: false } | { exists: "unknown"; error: string };

async function inspectPath(target: string): Promise<PathState> {
  try {
    const stats = await lstat(target);
    const how = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
    return { exists: true, how };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
    return { exists: "unknown", error: code ?? String(error) };
  }
}

/**
 * Count active (non-archived) workspaces per project id. The daemon's workspace
 * fetch already excludes archived workspaces; workspaces that are mid-archive
 * (archivingAt set) are still counted as active on purpose. Joins on projectId only.
 */
async function countActiveWorkspaces(client: DaemonClient): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const payload = await client.fetchWorkspaces({
      page: { limit: WORKSPACE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of payload.entries) {
      counts.set(workspace.projectId, (counts.get(workspace.projectId) ?? 0) + 1);
    }
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return counts;
}

async function judge(project: ProjectRow, activeCount: number): Promise<Verdict> {
  const base = { projectId: project.projectId, path: project.projectRootPath, name: project.projectDisplayName };
  if (activeCount > 0) {
    return { kind: "skip", ...base, reason: "active-workspaces", detail: `activeWorkspaces=${activeCount}` };
  }
  const state = await inspectPath(project.projectRootPath);
  if (state.exists === "unknown") {
    return { kind: "skip", ...base, reason: "path-unverifiable", detail: `lstat=${state.error}` };
  }
  if (state.exists) {
    return { kind: "skip", ...base, reason: "path-still-exists", detail: `on-disk=${state.how}` };
  }
  return { kind: "delete", ...base };
}

/** Fresh, live evaluation of one project against the daemon and the filesystem. */
export async function evaluateProject(client: DaemonClient, projectId: string): Promise<Verdict> {
  const { projects } = await client.listProjects();
  const project = projects.find((row) => row.projectId === projectId);
  if (!project) {
    return { kind: "skip", projectId, path: null, name: null, reason: "project-missing", detail: "not in project list" };
  }
  const counts = await countActiveWorkspaces(client);
  return judge(project, counts.get(projectId) ?? 0);
}

function quote(value: string | null): string {
  return JSON.stringify(value ?? "");
}

function describe(verdict: Verdict): string {
  const head = `projectId=${verdict.projectId} name=${quote(verdict.name)} path=${quote(verdict.path)}`;
  return verdict.kind === "delete"
    ? `${head} reason=orphaned(no-active-workspace,path-missing)`
    : `${head} reason=${verdict.reason} ${verdict.detail}`;
}

export interface SweeperLogger {
  log(line: string): void;
  error(line: string): void;
}

export class OrphanProjectSweeper {
  private readonly candidates = new Map<string, { attempts: number; timer: NodeJS.Timeout | null }>();
  private startupTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly logger: SweeperLogger) {}

  /** Serialize daemon work so a sweep and a re-check never race on the same project. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  scheduleStartupSweep(delayMs: number = STARTUP_SWEEP_DELAY_MS): void {
    if (this.stopped || this.startupTimer) return;
    this.logger.log(`${TAG} startup sweep scheduled in ${delayMs}ms`);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.exclusive(() => this.runStartupSweep()).catch((error) => {
        this.logger.error(`${TAG} startup sweep failed: ${message(error)}`);
      });
    }, delayMs);
  }

  /** Record an archive candidate. Returns promptly; all daemon work is deferred. */
  noteArchivedWorkspace(workspace: { id: string; projectId: string; cwd: string }): void {
    const prefix = `${TAG} hook=workspace.archived workspaceId=${workspace.id} projectId=${workspace.projectId} cwd=${quote(workspace.cwd)}`;
    if (this.stopped) return;
    if (this.candidates.has(workspace.projectId)) {
      this.logger.log(`${prefix} action=deduplicated (re-check already pending)`);
      return;
    }
    if (this.candidates.size >= MAX_TRACKED_CANDIDATES) {
      this.logger.log(`${prefix} action=dropped reason=candidate-cap(${MAX_TRACKED_CANDIDATES}); next startup sweep will re-check`);
      return;
    }
    this.candidates.set(workspace.projectId, { attempts: 0, timer: null });
    this.scheduleRecheck(workspace.projectId);
    this.logger.log(`${prefix} action=scheduled re-check attempt=1 in ${RECHECK_DELAYS_MS[0]}ms`);
  }

  private scheduleRecheck(projectId: string): void {
    const candidate = this.candidates.get(projectId);
    if (!candidate || this.stopped) return;
    const delay = RECHECK_DELAYS_MS[candidate.attempts] ?? RECHECK_DELAYS_MS[RECHECK_DELAYS_MS.length - 1] ?? 60_000;
    candidate.timer = setTimeout(() => {
      candidate.timer = null;
      void this.exclusive(() => this.recheck(projectId)).catch((error) => {
        this.logger.error(`${TAG} re-check crashed projectId=${projectId}: ${message(error)}`);
        this.candidates.delete(projectId);
      });
    }, delay);
  }

  private async recheck(projectId: string): Promise<void> {
    const candidate = this.candidates.get(projectId);
    if (!candidate || this.stopped) return;
    candidate.attempts += 1;
    const attempt = `attempt=${candidate.attempts}/${RECHECK_DELAYS_MS.length}`;
    let outcome: "done" | "retry";
    try {
      outcome = await withDaemon(async (client) => {
        const verdict = await evaluateProject(client, projectId);
        if (verdict.kind === "delete") {
          await this.deleteVerified(client, verdict, `re-check ${attempt}`);
          return "done";
        }
        if (verdict.reason === "project-missing") {
          this.logger.log(`${TAG} decision=skip source=re-check ${attempt} ${describe(verdict)}`);
          return "done";
        }
        this.logger.log(`${TAG} decision=skip source=re-check ${attempt} ${describe(verdict)}`);
        return "retry";
      });
    } catch (error) {
      this.logger.error(`${TAG} re-check error source=re-check ${attempt} projectId=${projectId}: ${message(error)}`);
      outcome = "retry";
    }
    if (outcome === "done" || candidate.attempts >= RECHECK_DELAYS_MS.length) {
      if (outcome === "retry") {
        this.logger.log(`${TAG} giving up projectId=${projectId} after ${candidate.attempts} re-checks; next startup sweep will re-evaluate`);
      }
      this.candidates.delete(projectId);
      return;
    }
    this.scheduleRecheck(projectId);
  }

  private async runStartupSweep(): Promise<void> {
    if (this.stopped) return;
    await withDaemon(async (client) => {
      const { projects } = await client.listProjects();
      const counts = await countActiveWorkspaces(client);
      this.logger.log(`${TAG} startup sweep begin projects=${projects.length} activeWorkspaces=${[...counts.values()].reduce((a, b) => a + b, 0)}`);
      let deleted = 0;
      for (const project of projects) {
        if (this.stopped) return;
        const verdict = await judge(project, counts.get(project.projectId) ?? 0);
        if (verdict.kind === "skip") {
          this.logger.log(`${TAG} decision=skip source=startup-sweep ${describe(verdict)}`);
          continue;
        }
        if (await this.deleteVerified(client, verdict, "startup-sweep")) deleted += 1;
      }
      this.logger.log(`${TAG} startup sweep end deleted=${deleted}`);
    });
  }

  /** Re-verify against live state immediately before deleting, then delete. */
  private async deleteVerified(client: DaemonClient, verdict: Verdict & { kind: "delete" }, source: string): Promise<boolean> {
    const fresh = await evaluateProject(client, verdict.projectId);
    if (fresh.kind !== "delete") {
      this.logger.log(`${TAG} decision=skip source=${source} (changed on re-verify) ${describe(fresh)}`);
      return false;
    }
    try {
      const result = await client.removeProject(fresh.projectId);
      this.logger.log(`${TAG} decision=delete source=${source} ${describe(fresh)} removedWorkspaceIds=${JSON.stringify(result.removedWorkspaceIds)}`);
      return true;
    } catch (error) {
      this.logger.error(`${TAG} decision=delete-failed source=${source} ${describe(fresh)} error=${quote(message(error))}`);
      return false;
    }
  }

  /** Clear every timer; in-flight work observes `stopped` and winds down. */
  stop(): void {
    this.stopped = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    for (const [projectId, candidate] of this.candidates) {
      if (candidate.timer) clearTimeout(candidate.timer);
      this.candidates.delete(projectId);
    }
    this.logger.log(`${TAG} stopped; timers cleared`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

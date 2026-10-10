import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { withDaemon, type DaemonClient } from "./daemon.ts";
import { readConfig, type SweeperConfig } from "./config.ts";

export type SweeperApi = Pick<DaemonClient, "listProjects" | "removeProject"> & {
  // This plugin uses paginated reads only, never the subscription overload.
  fetchWorkspaces(options?: Parameters<DaemonClient["fetchWorkspaces"]>[0]): ReturnType<DaemonClient["fetchWorkspaces"]>;
};

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
  | "parent-missing"
  | "mount-absent"
  | "mount-unverifiable"
  | "active-workspaces";

export type Verdict =
  | { kind: "delete"; projectId: string; path: string; name: string }
  | { kind: "skip"; projectId: string; path: string | null; name: string | null; reason: SkipReason; detail: string };

type PathState = { exists: true; how: string } | { exists: false } | { exists: "unknown"; error: string };

type EntryStats = { isDirectory(): boolean; isSymbolicLink(): boolean; dev: number };

/** The platform and filesystem calls a root is judged with. Tests inject a fake one. */
export interface SweeperHost {
  platform: NodeJS.Platform;
  lstat(target: string): Promise<EntryStats>;
  stat(target: string): Promise<EntryStats>;
  readdir(target: string): Promise<string[]>;
  readFile(target: string): Promise<string>;
  realpath(target: string): Promise<string>;
}

const nodeHost: SweeperHost = {
  platform: process.platform,
  lstat: (target) => lstat(target),
  stat: (target) => stat(target),
  readdir: (target) => readdir(target),
  readFile: (target) => readFile(target, "utf8"),
  realpath: (target) => realpath(target),
};

// Paths follow the host's platform, so a Windows host can be judged from any machine.
const pathsOf = (host: SweeperHost) => host.platform === "win32" ? path.win32 : path.posix;

async function inspectPath(target: string, host: SweeperHost): Promise<PathState> {
  try {
    const stats = await host.lstat(target);
    const how = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
    return { exists: true, how };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
    return { exists: "unknown", error: code ?? String(error) };
  }
}

/**
 * A missing root only counts as orphaned when its parent directory (and, on Windows,
 * its drive root) is present and not empty, so an unmounted or late-mounting volume deletes nothing.
 * An unmounted volume usually leaves its mount point behind as an empty directory (Linux, and custom
 * mount points on macOS). Comparing st_dev alone cannot catch that: an unmounted mount point is an
 * ordinary directory on its parent's device, and st_dev only differs while the volume is mounted.
 * A non-empty parent is necessary, not sufficient: findAbsentMount checks the mounts next.
 */
async function findMissingContainer(target: string, host: SweeperHost): Promise<ContainerProblem | null> {
  const paths = pathsOf(host);
  const parent = paths.dirname(target);
  const dirs = [parent];
  if (host.platform === "win32") dirs.unshift(paths.parse(target).root);
  const absent = (dir: string, error: string): ContainerProblem => ({ reason: "parent-missing", detail: `dir=${quote(dir)} ${error} (volume or parent absent)` });
  // On Windows only ENOENT shows the folder is gone. A denied or failed stat, or a container that is now something other
  // than a directory, says nothing about the volume.
  const unverifiable = (dir: string, error: string): ContainerProblem => ({ reason: "mount-unverifiable", detail: `dir=${quote(dir)} ${error}` });
  for (const dir of dirs) {
    let isDirectory: boolean;
    try {
      isDirectory = (await host.stat(dir)).isDirectory();
    } catch (error) {
      const code = errorCode(error);
      return host.platform === "win32" && code !== "ENOENT" ? unverifiable(dir, `stat=${code}`) : absent(dir, `stat=${code}`);
    }
    if (!isDirectory) return host.platform === "win32" ? unverifiable(dir, "stat=not-a-directory") : absent(dir, "stat=not-a-directory");
  }
  try {
    if ((await host.readdir(parent)).length === 0) return absent(parent, "empty-directory");
  } catch (error) {
    return absent(parent, `readdir=${errorCode(error)}`);
  }
  return null;
}

const FSTAB = "/etc/fstab";
const MOUNTINFO = "/proc/self/mountinfo";

type MountProblem = { reason: "mount-absent" | "mount-unverifiable"; detail: string };
type ContainerProblem = { reason: "parent-missing" | "mount-unverifiable"; detail: string };

class MountStateError extends Error {}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? message(error);

// fstab and mountinfo write a space, tab, newline or backslash in a path as a three-digit octal escape.
const unescapeMountPath = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

function isWithin(dir: string, target: string): boolean {
  const relative = path.posix.relative(dir, target);
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
}

/** Mount points the host declares in /etc/fstab. A missing fstab declares none; an unreadable one is an error. */
async function declaredMountPoints(host: SweeperHost): Promise<string[]> {
  let text: string;
  try {
    text = await host.readFile(FSTAB);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MountStateError(`${FSTAB} read=${errorCode(error)}`);
  }
  const points: string[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith("#") || fields.length < 3) continue;
    const point = unescapeMountPath(fields[1]!);
    if (fields[2] === "swap" || !path.posix.isAbsolute(point)) continue;
    points.push(path.posix.resolve(point));
  }
  return points;
}

/** Linux: every mount point in this mount namespace. An automount trigger alone does not count as mounted. */
async function mountedPoints(host: SweeperHost): Promise<Set<string>> {
  let text: string;
  try {
    text = await host.readFile(MOUNTINFO);
  } catch (error) {
    throw new MountStateError(`${MOUNTINFO} read=${errorCode(error)}`);
  }
  const points = new Set<string>();
  for (const line of text.split("\n")) {
    const [head, tail] = line.split(" - ");
    const point = head?.split(" ")[4];
    if (point && tail && tail.split(" ")[0] !== "autofs") points.add(unescapeMountPath(point));
  }
  if (points.size === 0) throw new MountStateError(`${MOUNTINFO} parse=no-mounts`);
  return points;
}

async function isMounted(point: string, mounted: Set<string> | null, host: SweeperHost): Promise<boolean> {
  let real: string;
  try {
    real = await host.realpath(point);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw new MountStateError(`mount=${quote(point)} realpath=${errorCode(error)}`);
  }
  if (mounted) return mounted.has(point) || mounted.has(real);
  // Elsewhere a mounted volume's root sits on another device than the directory that holds it; an unmounted mount point does not.
  if (real === path.posix.parse(real).root) return true;
  try {
    const [own, holder] = await Promise.all([host.stat(real), host.stat(path.posix.dirname(real))]);
    return own.dev !== holder.dev;
  } catch (error) {
    throw new MountStateError(`mount=${quote(point)} stat=${errorCode(error)}`);
  }
}

/**
 * Windows: a junction, a volume mount point or a directory symlink among the existing ancestors can put the root on a
 * volume or target that is absent, so such a root is kept. lstat reports a junction or a symlink as a symbolic link.
 * Node reports a volume mount point as a plain directory, but a mounted volume has another device id than the folder
 * that holds it. An lstat error other than ENOENT also keeps the root. A missing folder under plain folders on a
 * present drive stays a candidate.
 */
async function findReparseAncestor(target: string, host: SweeperHost): Promise<MountProblem | null> {
  let below: { dir: string; dev: number } | null = null;
  for (let dir = path.win32.dirname(target); ; dir = path.win32.dirname(dir)) {
    let stats: EntryStats | null = null;
    try {
      stats = await host.lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { reason: "mount-unverifiable", detail: `dir=${quote(dir)} lstat=${errorCode(error)}` };
    }
    if (stats?.isSymbolicLink()) return { reason: "mount-unverifiable", detail: `dir=${quote(dir)} reparse-point` };
    if (stats && !stats.isDirectory()) return { reason: "mount-unverifiable", detail: `dir=${quote(dir)} not-a-directory` };
    if (stats && below && stats.dev !== below.dev) return { reason: "mount-unverifiable", detail: `dir=${quote(below.dir)} volume-mount-point` };
    below = stats ? { dir, dev: stats.dev } : null;
    if (path.win32.dirname(dir) === dir) return null;
  }
}

/**
 * A non-empty parent is weak proof of a mount, because the directory under a mount point can hold unrelated files.
 * Windows walks the root's ancestors for reparse points (findReparseAncestor). Elsewhere every mount point /etc/fstab
 * declares over the root path must be mounted now: by /proc/self/mountinfo on Linux, by device id elsewhere. A mount
 * table that cannot be read fails closed. A POSIX mount the host does not declare (mounted by hand or by a desktop
 * session) cannot be told apart from a plain directory, so only the empty-parent check above covers it.
 */
async function findAbsentMount(target: string, host: SweeperHost): Promise<MountProblem | null> {
  if (host.platform === "win32") return findReparseAncestor(target, host);
  try {
    const paths = [path.posix.resolve(target), path.posix.join(await host.realpath(path.posix.dirname(target)), path.posix.basename(target))];
    const expected = (await declaredMountPoints(host)).filter((point) => paths.some((candidate) => isWithin(point, candidate)));
    if (expected.length === 0) return null;
    const mounted = host.platform === "linux" ? await mountedPoints(host) : null;
    for (const point of expected) {
      if (!(await isMounted(point, mounted, host))) return { reason: "mount-absent", detail: `mount=${quote(point)} declared-in=${FSTAB} not-mounted` };
    }
    return null;
  } catch (error) {
    return { reason: "mount-unverifiable", detail: error instanceof MountStateError ? error.message : `error=${quote(message(error))}` };
  }
}

/**
 * Count active (non-archived) workspaces per project id. The daemon's workspace
 * fetch already excludes archived workspaces; workspaces that are mid-archive
 * (archivingAt set) are still counted as active on purpose. Joins on projectId only.
 */
async function countActiveWorkspaces(client: SweeperApi): Promise<Map<string, number>> {
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

type VerdictBase = { projectId: string; path: string; name: string };

function verdictBase(project: ProjectRow): VerdictBase {
  return { projectId: project.projectId, path: project.projectRootPath, name: project.projectDisplayName };
}

/** The filesystem half of the verdict: a skip, or null when the root is gone, its parent is present and its mounts are too. */
async function judgeDisk(base: VerdictBase, host: SweeperHost): Promise<Verdict | null> {
  const state = await inspectPath(base.path, host);
  if (state.exists === "unknown") return { kind: "skip", ...base, reason: "path-unverifiable", detail: `lstat=${state.error}` };
  if (state.exists) return { kind: "skip", ...base, reason: "path-still-exists", detail: `on-disk=${state.how}` };
  const container = await findMissingContainer(base.path, host);
  if (container) return { kind: "skip", ...base, ...container };
  const mount = await findAbsentMount(base.path, host);
  if (mount) return { kind: "skip", ...base, ...mount };
  return null;
}

function workspaceSkip(project: ProjectRow, activeCount: number): Verdict | null {
  return activeCount > 0 ? { kind: "skip", ...verdictBase(project), reason: "active-workspaces", detail: `activeWorkspaces=${activeCount}` } : null;
}

async function judge(project: ProjectRow, activeCount: number, host: SweeperHost): Promise<Verdict> {
  return workspaceSkip(project, activeCount) ?? (await judgeDisk(verdictBase(project), host)) ?? { kind: "delete", ...verdictBase(project) };
}

/**
 * Fresh, live evaluation of one project against the daemon and the filesystem. The filesystem goes first and the
 * daemon's workspace count last; deleteVerified repeats the filesystem half right before removeProject.
 */
export async function evaluateProject(client: SweeperApi, projectId: string, host: SweeperHost = nodeHost): Promise<Verdict> {
  const { projects } = await client.listProjects();
  const project = projects.find((row) => row.projectId === projectId);
  if (!project) {
    return { kind: "skip", projectId, path: null, name: null, reason: "project-missing", detail: "not in project list" };
  }
  const disk = await judgeDisk(verdictBase(project), host);
  if (disk) return disk;
  const counts = await countActiveWorkspaces(client);
  return workspaceSkip(project, counts.get(projectId) ?? 0) ?? { kind: "delete", ...verdictBase(project) };
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

  private readonly connect: <T>(fn: (client: SweeperApi) => Promise<T>) => Promise<T>;
  private readonly loadConfig: () => Promise<SweeperConfig>;
  private readonly logger: SweeperLogger;
  private readonly host: SweeperHost;

  constructor(logger: SweeperLogger, options: {
    withDaemon?: <T>(fn: (client: SweeperApi) => Promise<T>) => Promise<T>;
    config?: () => Promise<SweeperConfig>;
    host?: SweeperHost;
  } = {}) {
    this.logger = logger;
    this.connect = options.withDaemon ?? withDaemon;
    this.loadConfig = options.config ?? (async () => readConfig());
    this.host = options.host ?? nodeHost;
  }

  /** One serialized full sweep, also used by the forced dry-run CLI. */
  sweep(options: { forceDryRun?: boolean; source?: string } = {}): Promise<void> {
    return this.exclusive(() => this.runStartupSweep(options));
  }

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
      void this.sweep().catch((error) => {
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
      const config = await this.loadConfig();
      outcome = await this.connect(async (client) => {
        const verdict = await evaluateProject(client, projectId, this.host);
        if (verdict.kind === "delete") {
          await this.deleteVerified(client, verdict, `re-check ${attempt}`, config);
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

  private async runStartupSweep(options: { forceDryRun?: boolean; source?: string }): Promise<void> {
    if (this.stopped) return;
    const config = await this.loadConfig();
    const source = options.source ?? "startup-sweep";
    const dryRun = options.forceDryRun === true || config.armed !== true;
    await this.connect(async (client) => {
      const { projects } = await client.listProjects();
      const counts = await countActiveWorkspaces(client);
      this.logger.log(`${TAG} startup sweep begin projects=${projects.length} activeWorkspaces=${[...counts.values()].reduce((a, b) => a + b, 0)}`);
      let deleted = 0;
      let wouldDelete = 0;
      for (const project of projects) {
        if (this.stopped) return;
        const verdict = await judge(project, counts.get(project.projectId) ?? 0, this.host);
        if (verdict.kind === "skip") {
          this.logger.log(`${TAG} decision=skip source=${source} ${describe(verdict)}`);
          continue;
        }
        if (deleted + wouldDelete >= config.maxDeletesPerSweep) {
          this.logger.log(`${TAG} decision=cap-reached source=${source} ${describe(verdict)} maxDeletesPerSweep=${config.maxDeletesPerSweep}`);
          continue;
        }
        if (await this.deleteVerified(client, verdict, source, config, options.forceDryRun)) {
          if (dryRun) wouldDelete += 1;
          else deleted += 1;
        }
      }
      this.logger.log(`${TAG} startup sweep end deleted=${deleted} wouldDelete=${wouldDelete}`);
    });
  }

  /**
   * Re-verify against live state immediately before deleting, then delete. project.remove.request carries only the
   * project id, so the daemon cannot refuse a row whose workspaces or path changed after this check; a true
   * compare-and-swap needs a daemon-side precondition. The re-verify ends with the daemon's workspace count, then the
   * root, parent and mount checks run once more as the last step before removeProject.
   */
  private async deleteVerified(client: SweeperApi, verdict: Verdict & { kind: "delete" }, source: string, config: SweeperConfig, forceDryRun = false): Promise<boolean> {
    const fresh = await evaluateProject(client, verdict.projectId, this.host);
    if (fresh.kind !== "delete") {
      this.logger.log(`${TAG} decision=skip source=${source} (changed on re-verify) ${describe(fresh)}`);
      return false;
    }
    if (this.stopped) return false;
    const last = await judgeDisk({ projectId: fresh.projectId, path: fresh.path, name: fresh.name }, this.host);
    if (last) {
      this.logger.log(`${TAG} decision=skip source=${source} (changed on final check) ${describe(last)}`);
      return false;
    }
    if (forceDryRun || config.armed !== true) {
      this.logger.log(`${TAG} decision=would-delete source=${source} ${describe(fresh)}`);
      return true;
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

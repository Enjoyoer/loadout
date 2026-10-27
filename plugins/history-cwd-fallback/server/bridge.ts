// Makes a missing Paseo worktree directory openable for one history load, then removes the stand-in.
//
// Paseo opens an archived agent's history by starting its provider again in the stored cwd
// (purpose "history"). When that worktree was deleted, the spawn fails with ENOENT before the
// provider runs. A plugin hook cannot change the cwd Paseo spawns in, so for that open the bridge
// puts a link at the missing path that points to an empty, read-only directory, and removes the
// link a few seconds later, once the provider has started. The provider keeps running in the empty directory, which stays valid; the
// agent's stored cwd is never changed.
//
// It links only a path strictly inside Paseo's worktrees root whose parent already exists as a real
// directory, with no symbolic link and no git work tree between the root and that parent. It never
// creates a directory there.
import { readdir, readFile, readlink } from "node:fs/promises";
import { chmod, mkdir, rename, rmdir, symlink, unlink } from "node:fs/promises"; // raw-write-ok: creates the plugin's own state and stand-in directories, creates and removes only its own link at a missing worktree cwd (recorded in the ledger first), and moves an unreadable ledger aside; expires 2027-04-30
import { homedir } from "node:os";
import path from "node:path";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { isAbsent, probe } from "./vendor/fs-probe.ts";

/** One link the bridge made: the missing cwd and the stand-in directory it points to. */
export interface LinkRecord {
  link: string;
  target: string;
}

interface Ledger {
  version: 1;
  links: LinkRecord[];
}

export interface BridgeOptions {
  /** The daemon's Paseo home; its config.json may name the worktrees root. */
  paseoHome: string;
  /** The plugin's state directory; holds the ledger and the stand-in directory. */
  stateDir: string;
  /** How long a link stays after the last history open that needed it. */
  holdMs: number;
  log: (line: string) => void;
  platform?: NodeJS.Platform;
}

const TAG = "[history-cwd-fallback]";

export class CwdBridge {
  private readonly ledgerPath: string;
  private readonly emptyDir: string;
  private readonly windows: boolean;
  private readonly pathApi: typeof path.posix;
  /** Links this run made and has not removed, by path. Timers and stop act on these, not on the ledger. */
  private readonly live = new Map<string, LinkRecord>();
  /** Each link's current lease. A history open replaces it; only the current lease's expiry may remove the link. */
  private readonly leases = new Map<string, { timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: BridgeOptions) {
    this.windows = (options.platform ?? process.platform) === "win32";
    this.pathApi = this.windows ? path.win32 : path.posix;
    this.ledgerPath = this.pathApi.join(options.stateDir, "links.json");
    this.emptyDir = this.pathApi.join(options.stateDir, "empty");
  }

  /** Before a history open: link a missing worktree cwd to the stand-in. Never throws. */
  async open(cwd: string, agentId: string): Promise<void> {
    if (this.stopped || !this.pathApi.isAbsolute(cwd)) return;
    const link = this.pathApi.resolve(cwd);
    let root: string | null;
    try {
      root = await this.worktreesRoot();
    } catch (error) {
      this.options.log(`${TAG} skipped agent=${agentId} reason=config-unreadable ${JSON.stringify(message(error))}`);
      return;
    }
    // Lexical containment first, so no other path is ever touched on disk.
    if (!root || !this.strictlyInside(root, link)) return;
    return this.serial(async () => {
      if (this.stopped) return;
      if (await probe(link)) {
        // Our own link from an earlier open: keep it for this open too. Anything else is the real cwd.
        if (this.live.has(link)) this.schedule(link);
        return;
      }
      const refusal = await this.parentProblem(root, link);
      if (refusal) {
        this.options.log(`${TAG} skipped agent=${agentId} reason=${refusal}`);
        return;
      }
      const target = await this.ensureEmptyDir();
      if (!target) {
        this.options.log(`${TAG} skipped agent=${agentId} reason=stand-in-not-empty dir=${JSON.stringify(this.emptyDir)}`);
        return;
      }
      const record: LinkRecord = { link, target };
      const ledger = await this.readLedger();
      await this.writeLedger([...ledger.links.filter((entry) => entry.link !== link), record]);
      try {
        await symlink(target, link, this.windows ? "junction" : "dir");
      } catch (error) {
        await this.writeLedger(ledger.links.filter((entry) => entry.link !== link));
        throw error;
      }
      this.live.set(link, record);
      this.schedule(link);
      this.options.log(`${TAG} linked agent=${agentId} cwd=${JSON.stringify(link)} holdSeconds=${this.options.holdMs / 1000}`);
    });
  }

  /**
   * Before any other open: throw when the cwd is one of our links, so an unarchive, a new turn or a new agent gets
   * Paseo's missing-directory refusal instead of running in the stand-in. Only paths inside the worktrees root, or
   * links this run made, are checked on disk.
   */
  async refuseStandIn(cwd: string): Promise<void> {
    if (!this.pathApi.isAbsolute(cwd)) return;
    const link = this.pathApi.resolve(cwd);
    if (!this.live.has(link)) {
      const root = await this.worktreesRoot().catch(() => null);
      if (!root || !this.strictlyInside(root, link)) return;
    }
    const at = await probe(link);
    if (at?.isSymbolicLink() && this.same(await readlink(link), this.emptyDir)) {
      throw new Error(`Working directory does not exist: ${link} (only an archived history load may use it)`);
    }
  }

  /** At start: remove any link a stopped or crashed run left behind. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      const ledger = await this.readLedger();
      const kept: LinkRecord[] = [];
      for (const record of ledger.links) if (!(await this.removeRecord(record))) kept.push(record);
      if (ledger.links.length) await this.writeLedger(kept);
    });
  }

  /** At plugin stop: remove every link this run made and every recorded one, now. */
  stop(): Promise<void> {
    this.stopped = true;
    for (const lease of this.leases.values()) clearTimeout(lease.timer);
    this.leases.clear();
    return this.serial(async () => {
      const kept: LinkRecord[] = [];
      for (const record of this.live.values()) if (!(await this.removeRecord(record))) kept.push(record);
      this.live.clear();
      const ledger = await this.readLedger();
      for (const record of ledger.links) {
        if (kept.some((entry) => entry.link === record.link)) continue;
        if (!(await this.removeRecord(record))) kept.push(record);
      }
      await this.writeLedger(kept);
    });
  }

  /** Start a new lease on the link, replacing its current one. */
  private schedule(link: string): void {
    const old = this.leases.get(link);
    if (old) clearTimeout(old.timer);
    const lease = {
      timer: setTimeout(() => {
        void this.serial(async () => {
          // An open that ran after this timer fired, ahead of this queued step, renewed the lease, and the stop
          // clears all leases: the link is then that lease's, or the stop's, to remove.
          if (this.leases.get(link) !== lease) return;
          this.leases.delete(link);
          const record = this.live.get(link);
          if (!record || !(await this.removeRecord(record))) return;
          this.live.delete(link);
          const ledger = await this.readLedger();
          await this.writeLedger(ledger.links.filter((entry) => entry.link !== link));
        });
      }, this.options.holdMs),
    };
    lease.timer.unref?.();
    this.leases.set(link, lease);
  }

  /** Remove the path only while it is still our link to our stand-in. True when nothing of ours is left there. */
  private async removeRecord(record: LinkRecord): Promise<boolean> {
    const at = await probe(record.link);
    if (!at) return true;
    if (!at.isSymbolicLink() || !this.same(await readlink(record.link), this.emptyDir)) {
      this.options.log(`${TAG} left cwd=${JSON.stringify(record.link)} reason=no-longer-our-link`);
      return true;
    }
    // Something wrote into the stand-in through the link: keep the link so that content keeps its path.
    if ((await readdir(this.emptyDir)).length) {
      this.options.log(`${TAG} left cwd=${JSON.stringify(record.link)} reason=stand-in-not-empty`);
      return false;
    }
    // A Windows junction is a directory entry, removed with rmdir; a POSIX link with unlink.
    await (this.windows ? rmdir(record.link) : unlink(record.link));
    this.options.log(`${TAG} removed cwd=${JSON.stringify(record.link)}`);
    return true;
  }

  /**
   * Why the link may not be made, or null. The parent must already exist, and every directory from the root down
   * to it must be a real directory (not a link) holding no .git entry, so a link never lands in a git work tree.
   */
  private async parentProblem(root: string, link: string): Promise<string | null> {
    const rootStat = await probe(root, { follow: true });
    if (!rootStat?.isDirectory()) return "no-worktrees-root";
    if (await probe(this.pathApi.join(root, ".git"))) return "inside-git-work-tree";
    const parts = this.pathApi.relative(root, this.pathApi.dirname(link)).split(this.pathApi.sep).filter(Boolean);
    let dir = root;
    for (const part of parts) {
      dir = this.pathApi.join(dir, part);
      const at = await probe(dir);
      if (!at) return "parent-missing";
      if (!at.isDirectory()) return "parent-not-a-plain-directory";
      if (await probe(this.pathApi.join(dir, ".git"))) return "inside-git-work-tree";
    }
    return null;
  }

  /** Paseo's worktrees root: config.json worktrees.root (absolute, ~, or relative to the Paseo home), else <home>/worktrees. */
  private async worktreesRoot(): Promise<string | null> {
    const home = this.pathApi.resolve(this.options.paseoHome);
    let text: string | null = null;
    try {
      text = await readFile(this.pathApi.join(home, "config.json"), "utf8");
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
    const configured: unknown = text === null ? undefined : (JSON.parse(text) as { worktrees?: { root?: unknown } })?.worktrees?.root;
    if (configured === undefined || configured === null) return this.pathApi.join(home, "worktrees");
    if (typeof configured !== "string") return null;
    const trimmed = configured.trim();
    if (!trimmed) return this.pathApi.join(home, "worktrees");
    const expanded = trimmed === "~" ? homedir() : trimmed.replace(/^~(?=[\\/])/, homedir());
    return this.pathApi.isAbsolute(expanded) ? this.pathApi.resolve(expanded) : this.pathApi.resolve(home, expanded);
  }

  /** Strictly below root, compared on the resolved text without touching the disk; case-insensitive on Windows. */
  private strictlyInside(root: string, target: string): boolean {
    const fold = (value: string) => (this.windows ? value.toLowerCase() : value);
    const relative = this.pathApi.relative(fold(root), fold(target));
    return relative !== "" && !relative.startsWith("..") && !this.pathApi.isAbsolute(relative);
  }

  /** The stand-in directory, or null when it is not empty. Read-only on POSIX so nothing can be written into it. */
  private async ensureEmptyDir(): Promise<string | null> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const at = await probe(this.emptyDir);
    if (!at) await mkdir(this.emptyDir, { mode: 0o500 });
    else if (!at.isDirectory()) throw new Error(`${this.emptyDir} is not a directory`);
    if (!this.windows) await chmod(this.emptyDir, 0o500);
    return (await readdir(this.emptyDir)).length ? null : this.emptyDir;
  }

  private same(linkText: string, target: string): boolean {
    const clean = (value: string) => this.pathApi.resolve(value.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
    return this.windows ? clean(linkText).toLowerCase() === clean(target).toLowerCase() : clean(linkText) === clean(target);
  }

  /** The ledger; an unreadable one is moved aside and logged, so it never blocks removing the links this run made. */
  private async readLedger(): Promise<Ledger> {
    let text: string;
    try {
      text = await readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if (isAbsent(error)) return { version: 1, links: [] };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Ledger;
      if (parsed?.version !== 1 || !Array.isArray(parsed.links)) throw new Error("not a version 1 ledger");
      return { version: 1, links: parsed.links.filter((entry) => typeof entry?.link === "string" && typeof entry?.target === "string").map(({ link, target }) => ({ link, target })) };
    } catch (error) {
      const aside = `${this.ledgerPath}.bad-${Date.now()}`;
      await rename(this.ledgerPath, aside);
      this.options.log(`${TAG} ledger-unreadable moved-to=${JSON.stringify(aside)} reason=${JSON.stringify(message(error))}`);
      return { version: 1, links: [] };
    }
  }

  private async writeLedger(links: LinkRecord[]): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomically(this.ledgerPath, { version: 1, links } satisfies Ledger, { mode: 0o600 });
  }

  /** Run one step at a time, logging and swallowing its error so a hook never fails the open. */
  private serial(step: () => Promise<void>): Promise<void> {
    const run = this.queue.then(step).catch((error: unknown) => {
      this.options.log(`${TAG} error ${JSON.stringify(message(error))}`);
    });
    this.queue = run;
    return run;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

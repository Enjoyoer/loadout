// Makes a missing working directory openable for one history load, then removes the stand-in.
//
// Paseo opens an archived agent's history by starting its provider again in the stored cwd
// (purpose "history"). When that worktree was deleted, the spawn fails with ENOENT before the
// provider runs. A plugin hook cannot change the cwd Paseo spawns in, so for that one open the
// bridge puts a link at the missing path that points to an empty, read-only directory, and
// removes the link (and any parent directory it had to create) shortly after. The provider keeps
// running in the empty directory, which stays valid; the agent's stored cwd is never changed.
import { mkdir, readFile, readlink } from "node:fs/promises";
import { chmod, rmdir, symlink, unlink } from "node:fs/promises"; // raw-write-ok: creates and removes only its own link and empty parent directories at a missing agent cwd, recorded in the ledger first; expires 2027-04-30
import path from "node:path";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { isAbsent, probe } from "./vendor/fs-probe.ts";

/** One link the bridge made: the missing cwd, the directory it points to, and the parents it created, outermost first. */
export interface LinkRecord {
  link: string;
  target: string;
  dirs: string[];
}

interface Ledger {
  version: 1;
  links: LinkRecord[];
}

export interface BridgeOptions {
  /** The plugin's state directory; holds the ledger and the empty directory. */
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
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: BridgeOptions) {
    this.ledgerPath = path.join(options.stateDir, "links.json");
    this.emptyDir = path.join(options.stateDir, "empty");
    this.windows = (options.platform ?? process.platform) === "win32";
  }

  /** Before a history open: link a missing absolute cwd to the empty directory. Never throws. */
  open(cwd: string, agentId: string): Promise<void> {
    return this.serial(async () => {
      if (this.stopped || !path.isAbsolute(cwd)) return;
      const link = path.resolve(cwd);
      const present = await probe(link);
      if (present) {
        // Our own link from an earlier open: keep it for this open too. Anything else is the real cwd.
        if (this.timers.has(link)) this.schedule(link);
        return;
      }
      const parent = await this.nearestExisting(path.dirname(link));
      if (!parent) {
        this.options.log(`${TAG} skipped agent=${agentId} reason=no-directory-ancestor`);
        return;
      }
      const target = await this.ensureEmptyDir();
      const record: LinkRecord = { link, target, dirs: parent.missing };
      const ledger = await this.readLedger();
      await this.writeLedger([...ledger.links.filter((entry) => entry.link !== link), record]);
      const created: string[] = [];
      try {
        for (const dir of record.dirs) {
          await mkdir(dir, { mode: 0o700 });
          created.push(dir);
        }
        await symlink(target, link, this.windows ? "junction" : "dir");
      } catch (error) {
        await this.undo({ ...record, dirs: created });
        throw error;
      }
      this.schedule(link);
      this.options.log(`${TAG} linked agent=${agentId} cwd=${JSON.stringify(link)} holdSeconds=${this.options.holdMs / 1000}`);
    });
  }

  /**
   * Before any other open: throw when the cwd is one of our links, so an unarchive, a new turn or a new agent in the
   * hold window gets Paseo's missing-directory refusal instead of running in the stand-in. A real cwd is not ours.
   */
  async refuseStandIn(cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) return;
    const link = path.resolve(cwd);
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
      for (const record of ledger.links) {
        if (!(await this.removeRecord(record))) kept.push(record);
      }
      if (ledger.links.length) await this.writeLedger(kept);
    });
  }

  /** At plugin stop: remove every live link now. */
  stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return this.sweep();
  }

  private schedule(link: string): void {
    const old = this.timers.get(link);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(link);
      void this.serial(async () => {
        const ledger = await this.readLedger();
        const record = ledger.links.find((entry) => entry.link === link);
        if (!record) return;
        if (await this.removeRecord(record)) await this.writeLedger(ledger.links.filter((entry) => entry !== record));
      });
    }, this.options.holdMs);
    timer.unref?.();
    this.timers.set(link, timer);
  }

  /** Remove the link if it is still ours, then the parents we created if empty. True when nothing of ours is left. */
  private async removeRecord(record: LinkRecord): Promise<boolean> {
    let clean = true;
    const at = await probe(record.link);
    if (at?.isSymbolicLink() && this.same(await readlink(record.link), record.target)) {
      // A Windows junction is a directory entry, removed with rmdir; a POSIX link with unlink.
      await (this.windows ? rmdir(record.link) : unlink(record.link));
      this.options.log(`${TAG} removed cwd=${JSON.stringify(record.link)}`);
    } else if (at) {
      this.options.log(`${TAG} left cwd=${JSON.stringify(record.link)} reason=no-longer-our-link`);
    }
    for (const dir of [...record.dirs].reverse()) {
      try {
        await rmdir(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (isAbsent(error)) continue;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          this.options.log(`${TAG} left dir=${JSON.stringify(dir)} reason=not-empty`);
          continue;
        }
        clean = false;
        this.options.log(`${TAG} remove-failed dir=${JSON.stringify(dir)} code=${code ?? "unknown"}`);
      }
    }
    return clean;
  }

  private async undo(record: LinkRecord): Promise<void> {
    if (await this.removeRecord(record)) {
      const ledger = await this.readLedger();
      await this.writeLedger(ledger.links.filter((entry) => entry.link !== record.link));
    }
  }

  /** The nearest existing ancestor, which must be a directory, and the missing directories below it, outermost first. */
  private async nearestExisting(start: string): Promise<{ missing: string[] } | null> {
    const missing: string[] = [];
    let dir = start;
    for (;;) {
      const at = await probe(dir, { follow: true });
      if (at) return at.isDirectory() ? { missing: missing.reverse() } : null;
      const up = path.dirname(dir);
      if (up === dir) return null;
      missing.push(dir);
      dir = up;
    }
  }

  /** The empty directory the links point to: a real directory, read-only on POSIX so nothing can be written into it. */
  private async ensureEmptyDir(): Promise<string> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const at = await probe(this.emptyDir);
    if (!at) await mkdir(this.emptyDir, { mode: 0o500 });
    else if (!at.isDirectory()) throw new Error(`${this.emptyDir} is not a directory`);
    if (!this.windows) await chmod(this.emptyDir, 0o500);
    return this.emptyDir;
  }

  private same(linkText: string, target: string): boolean {
    const clean = (value: string) => path.resolve(value.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
    return this.windows ? clean(linkText).toLowerCase() === clean(target).toLowerCase() : clean(linkText) === clean(target);
  }

  private async readLedger(): Promise<Ledger> {
    let text: string;
    try {
      text = await readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if (isAbsent(error)) return { version: 1, links: [] };
      throw error;
    }
    const parsed = JSON.parse(text) as Ledger;
    if (parsed?.version !== 1 || !Array.isArray(parsed.links)) throw new Error(`unreadable ledger ${this.ledgerPath}`);
    return parsed;
  }

  private async writeLedger(links: LinkRecord[]): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomically(this.ledgerPath, { version: 1, links } satisfies Ledger, { mode: 0o600 });
  }

  /** Run one step at a time, logging and swallowing its error so a hook never fails the open. */
  private serial(step: () => Promise<void>): Promise<void> {
    const run = this.queue.then(step).catch((error: unknown) => {
      this.options.log(`${TAG} error ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    });
    this.queue = run;
    return run;
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "./policy.ts";

// Durable per-child decisions at $PASEO_HOME/plugin-state/pm-native-worker-guard/state.json.
// One record per child id makes every decision idempotent across duplicate events and
// plugin reloads. Pending notices (PM was mid-turn) live on the same record.

export type Outcome = "skip" | "would-archive" | "archiving" | "archived" | "archive-failed";
export type NoticeState = "pending" | "sent" | "failed" | "dropped";

export interface HandledRecord {
  childId: string;
  parentId: string;
  provider: string;
  outcome: Outcome;
  reason: string;
  at: string;
  notice?: NoticeState;
  noticeText?: string;
}

interface State {
  version: 1;
  handled: HandledRecord[];
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
  return path.join(home, "plugin-state", PLUGIN_ID, "state.json");
}

/**
 * Single-writer store (this plugin subprocess). Reads the file once and writes through.
 * A missing file is an empty state; an unreadable or invalid file throws, so callers fail
 * closed instead of acting without their idempotency record.
 */
export class StateStore {
  private readonly filePath: string;
  private cache: State | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(filePath: string = defaultStatePath()) {
    this.filePath = filePath;
  }

  private async load(): Promise<State> {
    if (this.cache) return this.cache;
    let state: State;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<State>;
      if (parsed.version !== 1 || !Array.isArray(parsed.handled)) throw new Error(`invalid state file ${this.filePath}`);
      state = { version: 1, handled: parsed.handled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, handled: [] };
    }
    this.cache = state;
    return state;
  }

  async get(childId: string): Promise<HandledRecord | null> {
    return (await this.load()).handled.find((record) => record.childId === childId) ?? null;
  }

  async pendingFor(parentId: string): Promise<HandledRecord[]> {
    return (await this.load()).handled.filter((record) => record.parentId === parentId && record.notice === "pending");
  }

  /** Upsert by child id, keeping the newest `maxEntries`. Resolves once written. */
  async put(record: HandledRecord, maxEntries: number): Promise<void> {
    const write = this.writes.then(async () => {
      const state = await this.load();
      const handled = [...state.handled.filter((candidate) => candidate.childId !== record.childId), record].slice(-maxEntries);
      const next: State = { version: 1, handled };
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
      this.cache = next;
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}

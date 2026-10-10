import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_ID } from "./policy.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";

// Durable per-child decisions at $PASEO_HOME/plugin-state/pm-native-worker-guard/state.json.
// One record per child id makes every decision idempotent across duplicate events and
// plugin reloads. Pending notices (PM was mid-turn) live on the same record.

export type Outcome = "skip" | "would-archive" | "archiving" | "archived" | "archive-failed";
/** `sending` is written before the send; a record left there is never sent again. */
export type NoticeState = "pending" | "sending" | "sent" | "failed" | "dropped";

const OUTCOMES: Record<Outcome, true> = { skip: true, "would-archive": true, archiving: true, archived: true, "archive-failed": true };
const NOTICE_STATES: Record<NoticeState, true> = { pending: true, sending: true, sent: true, failed: true, dropped: true };

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

function isRecord(value: unknown): value is HandledRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.childId === "string" && record.childId !== "" &&
    typeof record.parentId === "string" && record.parentId !== "" &&
    typeof record.provider === "string" &&
    typeof record.outcome === "string" && Object.hasOwn(OUTCOMES, record.outcome) &&
    typeof record.reason === "string" &&
    typeof record.at === "string" && Number.isFinite(Date.parse(record.at)) &&
    (record.notice === undefined || (typeof record.notice === "string" && Object.hasOwn(NOTICE_STATES, record.notice))) &&
    (record.noticeText === undefined || typeof record.noticeText === "string");
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
  private loading: Promise<State> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(filePath: string = defaultStatePath()) {
    this.filePath = filePath;
  }

  private async read(): Promise<State> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<State>;
      if (parsed.version !== 1 || !Array.isArray(parsed.handled) || !parsed.handled.every(isRecord)) throw new Error(`invalid state file ${this.filePath}`);
      return { version: 1, handled: parsed.handled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, handled: [] };
    }
  }

  // Concurrent first reads share one read, so a slow one can never replace a cache that a
  // write has already advanced. A failed read is not kept: the next call reads again.
  private load(): Promise<State> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= this.read().then(
      (state) => (this.cache ??= state),
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
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
      await writeJsonAtomically(this.filePath, next, { mode: 0o600 });
      this.cache = next;
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}

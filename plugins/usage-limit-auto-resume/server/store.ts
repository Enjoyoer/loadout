import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isActive, type ResumeRecord } from "./model.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";

/** What a pruned record leaves behind: its source turn, so a repeated event for that turn still reads as a duplicate. */
export type TurnGuard = { agentId: string; sourceTurnId: string; persistenceSessionId: string };

type State = { version: 2; records: ResumeRecord[]; guards?: TurnGuard[] };

// Settled records (done, exhausted, opted out, superseded) only answer repeated turn events and keep recent evidence, so
// beyond this bound the oldest leave just a guard. A record that can still act, or is uncertain, is never pruned.
export const MAX_SETTLED_RECORDS = 200;
export const MAX_TURN_GUARDS = 2000;

const isSettled = (record: ResumeRecord) => !isActive(record) && record.state !== "uncertain";
const guardOf = ({ agentId, sourceTurnId, persistenceSessionId }: TurnGuard): TurnGuard => ({ agentId, sourceTurnId, persistenceSessionId });
const sameTurn = (a: TurnGuard, b: TurnGuard) => a.agentId === b.agentId && a.sourceTurnId === b.sourceTurnId && a.persistenceSessionId === b.persistenceSessionId;
const isGuard = (value: unknown): value is TurnGuard => typeof value === "object" && value !== null &&
  ["agentId", "sourceTurnId", "persistenceSessionId"].every((key) => typeof (value as Record<string, unknown>)[key] === "string" && (value as Record<string, unknown>)[key] !== "");

function retain(records: ResumeRecord[], guards: TurnGuard[] = []): { records: ResumeRecord[]; guards: TurnGuard[] } {
  const settled = records.filter(isSettled).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const dropped = settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_RECORDS));
  if (dropped.length === 0) return { records, guards };
  const added = dropped.map(guardOf);
  return {
    records: records.filter((record) => !dropped.includes(record)),
    guards: [...guards.filter((guard) => !added.some((turn) => sameTurn(turn, guard))), ...added].slice(-MAX_TURN_GUARDS),
  };
}

/** The state file exists but cannot be read or parsed. Callers fail closed and leave the file alone. */
export class StateUnreadableError extends Error {}

function defaultState(): State {
  return { version: 2, records: [] };
}

function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(env.HOME ?? process.env.HOME ?? "/tmp", ".paseo");
}

export class ResumeStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath = path.join(paseoHome(), "plugin-state", "usage-limit-auto-resume", "state.json")) {
    this.filePath = filePath;
  }

  async read(): Promise<ResumeRecord[]> {
    return (await this.load()).records;
  }

  // Only a missing file reads as empty. A corrupt, unreadable or other-version file, or one with malformed guards, throws,
  // so the next write cannot erase its records.
  private async load(): Promise<State> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const state = JSON.parse(raw) as State;
      if (state.version !== 2 || !Array.isArray(state.records)) throw new Error("invalid state");
      if (state.guards !== undefined && !(Array.isArray(state.guards) && state.guards.every(isGuard))) throw new Error("invalid guards");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
      throw new StateUnreadableError(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A record or a pruned record's guard already stands for this source turn. */
  async hasTurn(turn: TurnGuard): Promise<boolean> {
    const state = await this.load();
    return state.records.some((record) => sameTurn(record, turn)) || (state.guards ?? []).some((guard) => sameTurn(guard, turn));
  }

  // Every read-modify-write runs inside one queue, so concurrent hook handlers
  // cannot read the same state and overwrite each other's changes.
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(records: ResumeRecord[], guards: TurnGuard[] = []): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const state: State = guards.length > 0 ? { version: 2, records, guards } : { version: 2, records };
    await writeJsonAtomically(this.filePath, state, { mode: 0o600 });
  }

  async activeForAgent(agentId: string): Promise<ResumeRecord | null> {
    const records = await this.read();
    return records.find((record) => record.agentId === agentId && ["detected", "parked", "resuming", "verifying"].includes(record.state)) ?? null;
  }

  async upsert(record: ResumeRecord): Promise<void> {
    await this.exclusive(async () => {
      const { records, guards } = await this.load();
      const index = records.findIndex((candidate) => candidate.recordId === record.recordId);
      if (index < 0) records.push(record);
      else records[index] = record;
      const kept = retain(records, guards);
      await this.persist(kept.records, kept.guards);
    });
  }

  async update(recordId: string, update: (record: ResumeRecord) => ResumeRecord): Promise<ResumeRecord | null> {
    return this.exclusive(async () => {
      const { records, guards } = await this.load();
      const index = records.findIndex((candidate) => candidate.recordId === recordId);
      if (index < 0) return null;
      const next = update(records[index]!);
      records[index] = next;
      await this.persist(records, guards);
      return next;
    });
  }

  async remove(recordId: string): Promise<void> {
    await this.exclusive(async () => {
      const { records, guards } = await this.load();
      await this.persist(records.filter((record) => record.recordId !== recordId), guards);
    });
  }
}

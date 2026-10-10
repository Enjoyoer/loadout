import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { unsettledTool } from "./model.ts";
import type { Checkpoint } from "./runtime.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";

export type StateEntry = {
  key: string;
  agentId: string;
  turnId: string | null;
  lastUserMessageAt: string | null;
  createdAt: string;
  /** Original request time, retained when a late result replaces the reservation. */
  attemptedAt?: string;
  outcome: "compact-requested" | "would-compact" | "compacted" | "compaction-failed" | "compaction-unconfirmed" | "skip" | "send-failed";
  reason: string;
};
type State = { version: 1; entries: StateEntry[]; turns?: Checkpoint[] };
export type WriteJson = typeof writeJsonAtomically;

const OUTCOMES: Record<StateEntry["outcome"], true> = {
  "compact-requested": true, "would-compact": true, compacted: true, "compaction-failed": true,
  "compaction-unconfirmed": true, skip: true, "send-failed": true,
};
const isTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isOptionalString = (value: unknown) => value == null || typeof value === "string";

function isEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.key === "string" && typeof entry.agentId === "string" && isOptionalString(entry.turnId) &&
    isOptionalString(entry.lastUserMessageAt) && isTime(entry.createdAt) && (entry.attemptedAt === undefined || isTime(entry.attemptedAt)) &&
    typeof entry.outcome === "string" && Object.hasOwn(OUTCOMES, entry.outcome) && typeof entry.reason === "string";
}

// A remembered turn's timeline holds only running tool calls, each with its call id.
function isRememberedTool(item: Record<string, unknown> | null): boolean {
  return typeof item === "object" && item !== null && item.type === "tool_call" && item.status === "running" &&
    typeof item.callId === "string" && item.callId !== "";
}

function isTurn(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return typeof turn.agentId === "string" && isOptionalString(turn.turnId) && typeof turn.key === "string" &&
    Array.isArray(turn.timeline) && turn.timeline.every(isRememberedTool) &&
    isOptionalString(turn.lastUserMessageAt) && Number.isSafeInteger(turn.retryCount) && (turn.retryCount as number) >= 0 && isTime(turn.endedAt);
}

// The same home the daemon endpoint resolver uses, so state lives with the daemon it serves.
export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

// Writes from every StateStore for one file share one queue in this process. It lives on
// globalThis, so a reloaded copy of this module joins it instead of starting its own.
// Each new store takes the next generation: older stores drop every write that has not
// started, and a write one has in flight lands before any write of the newer store begins.
type Lane = { generation: number; tail: Promise<void> };
const LANES = Symbol.for("loadout.cache-aware-autocompact.state-lanes.v1");

function laneFor(filePath: string): Lane {
  const scope = globalThis as unknown as Record<symbol, Map<string, Lane> | undefined>;
  const lanes = scope[LANES] ??= new Map<string, Lane>();
  const key = path.resolve(filePath);
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, lane = { generation: 0, tail: Promise.resolve() });
  return lane;
}

export class StateStore {
  private readonly filePath: string;
  private readonly writeJson: WriteJson;
  private readonly lane: Lane;
  private readonly generation: number;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(filePath = path.join(paseoHome(), "plugin-state", "cache-aware-autocompact", "state.json"), writeJson = writeJsonAtomically) {
    this.filePath = filePath;
    this.writeJson = writeJson;
    this.lane = laneFor(filePath);
    this.generation = ++this.lane.generation;
  }
  private async readState(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8")) as State;
      if (state.version !== 1 || !Array.isArray(state.entries) || !state.entries.every(isEntry) ||
        (state.turns !== undefined && (!Array.isArray(state.turns) || !state.turns.every(isTurn)))) throw new Error("Invalid state");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
  }
  async read(): Promise<StateEntry[]> { return (await this.readState()).entries; }
  async latestTurn(agentId: string): Promise<Checkpoint | null> {
    return (await this.readState()).turns?.find((turn) => turn.agentId === agentId) ?? null;
  }
  private async write(state: State): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.writeJson(this.filePath, state, { mode: 0o600 });
  }
  // Every read-modify-write runs inside the file's queue. A failed write still rejects
  // to its caller, but the queue recovers so later writes are not poisoned. A closed or
  // superseded store drops the write instead: the newer store owns the file.
  private exclusive(task: () => Promise<void>): Promise<void> {
    const guarded = async () => {
      if (!this.closed && this.generation === this.lane.generation) await task();
    };
    const run = this.lane.tail.then(guarded, guarded);
    this.lane.tail = this.writes = run.catch(() => undefined);
    return run;
  }
  /** Drop every write that has not started, and resolve once the one in flight, if any, has settled. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
  }
  async rememberTurn(turn: Checkpoint, maxEntries: number): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      // The evaluator only inspects unsettled tools. Keep their guard state, not
      // whole transcripts, alongside the already-derived checkpoint identity. A status
      // it does not know is kept as running; a turn the reader would reject is not written.
      const durableTurn = { ...turn, timeline: turn.timeline.filter(unsettledTool).map((item) => ({ ...item, status: "running" as const, error: null })) };
      if (!isTurn(durableTurn)) throw new Error("Invalid turn");
      const turns = [...(state.turns ?? []).filter((candidate) => candidate.agentId !== turn.agentId), durableTurn].slice(-maxEntries);
      await this.write({ ...state, turns });
    });
  }
  async has(key: string): Promise<boolean> {
    return (await this.read()).some((entry) => entry.key === key);
  }
  async append(entry: StateEntry, maxEntries: number): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      const next = [...state.entries.filter((candidate) => candidate.key !== entry.key), entry].slice(-maxEntries);
      await this.write({ ...state, entries: next });
    });
  }
}

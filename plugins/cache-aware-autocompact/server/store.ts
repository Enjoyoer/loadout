import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
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

function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(env.HOME ?? "/tmp", ".paseo");
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
  private readonly lane: Lane;
  private readonly generation: number;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(filePath = path.join(home(), "plugin-state", "cache-aware-autocompact", "state.json")) {
    this.filePath = filePath;
    this.lane = laneFor(filePath);
    this.generation = ++this.lane.generation;
  }
  private async readState(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8")) as State;
      if (state.version !== 1 || !Array.isArray(state.entries)) throw new Error("Invalid state");
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
    await writeJsonAtomically(this.filePath, state, { mode: 0o600 });
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
      // The evaluator only inspects running tools. Keep their guard state, not
      // whole transcripts, alongside the already-derived checkpoint identity.
      const durableTurn = { ...turn, timeline: turn.timeline.filter((item) => item.type === "tool_call" && item.status === "running") };
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

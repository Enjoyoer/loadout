import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Checkpoint } from "./runtime.ts";

export type StateEntry = {
  key: string;
  agentId: string;
  turnId: string | null;
  lastUserMessageAt: string | null;
  createdAt: string;
  /** Original request time, retained when a late result replaces the reservation. */
  attemptedAt?: string;
  outcome: "compact-requested" | "would-compact" | "compacted" | "compaction-failed" | "skip" | "send-failed";
  reason: string;
};
type State = { version: 1; entries: StateEntry[]; turns?: Checkpoint[] };

function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(env.HOME ?? "/tmp", ".paseo");
}

export class StateStore {
  private readonly filePath: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(filePath = path.join(home(), "plugin-state", "cache-aware-autocompact", "state.json")) {
    this.filePath = filePath;
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
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
  }
  // Every read-modify-write runs inside one queue. A failed write still rejects
  // to its caller, but the queue recovers so later writes are not poisoned.
  private exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.writes.then(task, task);
    this.writes = run.catch(() => undefined);
    return run;
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

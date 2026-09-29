import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type StateEntry = {
  key: string;
  agentId: string;
  turnId: string | null;
  lastUserMessageAt: string | null;
  createdAt: string;
  outcome: "would-compact" | "compacted" | "skip" | "send-failed";
  reason: string;
};
type State = { version: 1; entries: StateEntry[] };

function home(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(env.HOME ?? "/tmp", ".paseo");
}

export class StateStore {
  private readonly filePath: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(filePath = path.join(home(), "plugin-state", "cache-aware-autocompact", "state.json")) {
    this.filePath = filePath;
  }
  async read(): Promise<StateEntry[]> {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8")) as State;
      return state.version === 1 && Array.isArray(state.entries) ? state.entries : [];
    } catch {
      return [];
    }
  }
  async has(key: string): Promise<boolean> {
    return (await this.read()).some((entry) => entry.key === key);
  }
  async append(entry: StateEntry, maxEntries: number): Promise<void> {
    this.writes = this.writes.then(async () => {
      const entries = await this.read();
      const next = [...entries.filter((candidate) => candidate.key !== entry.key), entry].slice(-maxEntries);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
    });
    await this.writes;
  }
}

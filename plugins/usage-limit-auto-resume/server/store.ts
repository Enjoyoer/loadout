import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResumeRecord } from "./model.ts";

type State = { version: 2; records: ResumeRecord[] };

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
    try {
      const raw = await readFile(this.filePath, "utf8");
      const state = JSON.parse(raw) as State;
      if (state.version !== 2 || !Array.isArray(state.records)) return defaultState().records;
      return state.records;
    } catch {
      return defaultState().records;
    }
  }

  async write(records: ResumeRecord[]): Promise<void> {
    await this.exclusive(() => this.persist(records));
  }

  // Every read-modify-write runs inside one queue, so concurrent hook handlers
  // cannot read the same state and overwrite each other's changes.
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(records: ResumeRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 2, records }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async activeForAgent(agentId: string): Promise<ResumeRecord | null> {
    const records = await this.read();
    return records.find((record) => record.agentId === agentId && ["detected", "parked", "resuming", "verifying"].includes(record.state)) ?? null;
  }

  async upsert(record: ResumeRecord): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.read();
      const index = records.findIndex((candidate) => candidate.recordId === record.recordId);
      if (index < 0) records.push(record);
      else records[index] = record;
      await this.persist(records);
    });
  }

  async update(recordId: string, update: (record: ResumeRecord) => ResumeRecord): Promise<ResumeRecord | null> {
    return this.exclusive(async () => {
      const records = await this.read();
      const index = records.findIndex((candidate) => candidate.recordId === recordId);
      if (index < 0) return null;
      const next = update(records[index]!);
      records[index] = next;
      await this.persist(records);
      return next;
    });
  }

  async remove(recordId: string): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.read();
      await this.persist(records.filter((record) => record.recordId !== recordId));
    });
  }
}

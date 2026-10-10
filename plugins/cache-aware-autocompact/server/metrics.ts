import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { paseoHome } from "./store.ts";

/**
 * Append-only usage log for measuring whether compaction saves tokens.
 * One JSON object per line; analysis happens offline.
 */
export class MetricsLog {
  private readonly filePath: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(filePath = path.join(paseoHome(), "plugin-state", "cache-aware-autocompact", "metrics.jsonl")) {
    this.filePath = filePath;
  }
  async append(record: Record<string, unknown>): Promise<void> {
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    }).catch(() => undefined);
    await this.writes;
  }
}

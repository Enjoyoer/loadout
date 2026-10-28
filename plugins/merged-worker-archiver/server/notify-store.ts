import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { NotifiedEntry } from "./cleanup.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { paseoHome } from "./vendor/daemon-target.ts";
import { isAbsent } from "./vendor/fs-probe.ts";

// Which agentless worktrees were already reported to their PM (on this daemon, or on a peer named by `host`),
// so each is reported once:
// <PASEO_HOME>/plugin-state/merged-worker-archiver/notified.json. Only a missing file reads as
// empty; an unreadable or malformed one throws, and then no report is sent that sweep.

interface State {
  version: 1;
  notified: Record<string, NotifiedEntry>;
}

const STATUSES = new Set(["sending", "sent", "unconfirmed"]);

function isEntry(value: unknown): value is NotifiedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === "string" && typeof entry.agentId === "string" && typeof entry.status === "string" && STATUSES.has(entry.status)
    && (entry.host === undefined || typeof entry.host === "string");
}

export interface NotifyStateStore {
  read(): Promise<Map<string, NotifiedEntry>>;
  write(entries: ReadonlyMap<string, NotifiedEntry>): Promise<void>;
}

export class NotifyStore implements NotifyStateStore {
  readonly filePath: string;

  constructor(filePath = path.join(paseoHome(), "plugin-state", "merged-worker-archiver", "notified.json")) {
    this.filePath = filePath;
  }

  async read(): Promise<Map<string, NotifiedEntry>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isAbsent(error)) return new Map();
      throw new Error(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = JSON.parse(raw) as Partial<State> | null;
    if (!state || state.version !== 1 || !state.notified || typeof state.notified !== "object" || Array.isArray(state.notified)) {
      throw new Error(`invalid ${this.filePath}`);
    }
    const entries = new Map<string, NotifiedEntry>();
    for (const [workspaceId, entry] of Object.entries(state.notified)) {
      if (!isEntry(entry)) throw new Error(`invalid entry ${workspaceId} in ${this.filePath}`);
      entries.set(workspaceId, entry);
    }
    return entries;
  }

  async write(entries: ReadonlyMap<string, NotifiedEntry>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const state: State = { version: 1, notified: Object.fromEntries(entries) };
    await writeJsonAtomically(this.filePath, state, { mode: 0o600 });
  }
}

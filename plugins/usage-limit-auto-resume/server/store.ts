import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ResumeAttempt, ResumeRecord, ResumeState } from "./model.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";

type State = { version: 2; records: ResumeRecord[] };

/** The state file exists but cannot be read or parsed. Callers fail closed and leave the file alone. */
export class StateUnreadableError extends Error {}

// Every ResumeState and attempt result, so typecheck fails here when model.ts adds one.
const STATES: Record<ResumeState, true> = {
  detected: true, parked: true, resuming: true, verifying: true, done: true,
  exhausted: true, "opted-out": true, superseded: true, uncertain: true,
};
const RESULTS: Record<ResumeAttempt["result"], true> = { sent: true, "send-failed": true, unknown: true, recovered: true };
const KINDS: Record<NonNullable<ResumeRecord["kind"]>, true> = { usage: true, transient: true };

const isString = (value: unknown) => typeof value === "string";
const isId = (value: unknown) => typeof value === "string" && value !== "";
const isTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isOneOf = (value: unknown, allowed: object) => typeof value === "string" && Object.hasOwn(allowed, value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const nullable = (value: unknown, check: (value: unknown) => boolean) => value == null || check(value);

function isAttempt(value: unknown): value is ResumeAttempt {
  if (typeof value !== "object" || value === null) return false;
  const attempt = value as Record<string, unknown>;
  return isTime(attempt.at) && isString(attempt.messageId) && isOneOf(attempt.result, RESULTS);
}

// Each field a sweep or a send relies on; nullable fields may be null or absent.
function isRecord(value: unknown): value is ResumeRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && optional(record.kind, (kind) => isOneOf(kind, KINDS)) &&
    optional(record.failedOutcome, (flag) => typeof flag === "boolean") && optional(record.usageFailedOutcome, (flag) => typeof flag === "boolean") &&
    optional(record.retryPrompt, isString) && optional(record.expectedUserText, isString) && optional(record.failedAssistantText, isString) &&
    nullable(record.expectedUserMessageId, isString) &&
    isId(record.recordId) && isId(record.sourceTurnId) && isId(record.agentId) && nullable(record.workspaceId, isString) &&
    isString(record.provider) && isString(record.model) && nullable(record.modeId, isString) && nullable(record.thinkingOptionId, isString) &&
    isString(record.cwd) && isId(record.persistenceSessionId) && nullable(record.nativeHandle, isString) && isString(record.configFingerprint) &&
    isTime(record.detectedAt) && nullable(record.lastUserMessageAt, isString) && isString(record.failureSignature) &&
    isTime(record.notBefore) && nullable(record.resetAt, isTime) &&
    Array.isArray(record.attempts) && record.attempts.every(isAttempt) && isOneOf(record.state, STATES) &&
    nullable(record.sentAt, isTime) && nullable(record.resumeTurnId, isString) && nullable(record.resumeStartedAt, isTime) &&
    nullable(record.resumeFinishedAt, isTime) && nullable(record.verificationDeadlineAt, isTime) &&
    isTime(record.createdAt) && isTime(record.updatedAt) && nullable(record.terminalReason, isString);
}

function defaultState(): State {
  return { version: 2, records: [] };
}

// The same home the daemon endpoint resolver uses, so state lives with the daemon it serves.
function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

export class ResumeStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath = path.join(paseoHome(), "plugin-state", "usage-limit-auto-resume", "state.json")) {
    this.filePath = filePath;
  }

  // Only a missing file reads as empty. A corrupt, unreadable or other-version file, or one with a malformed record, throws,
  // so the next write cannot erase its records and no automatic action is computed from it.
  async read(): Promise<ResumeRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const state = JSON.parse(raw) as State;
      if (state.version !== 2 || !Array.isArray(state.records)) throw new Error("invalid state");
      const invalid = state.records.findIndex((record) => !isRecord(record));
      if (invalid >= 0) throw new Error(`invalid record at index ${invalid}`);
      return state.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState().records;
      throw new StateUnreadableError(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const state: State = { version: 2, records };
    await writeJsonAtomically(this.filePath, state, { mode: 0o600 });
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

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isActive, type AgentClose, type ResumeAttempt, type ResumeRecord, type ResumeState } from "./model.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { paseoHome } from "./vendor/daemon-target.ts";

/** What a pruned record leaves behind: its source turn, so a repeated event for that turn still reads as a duplicate. */
export type TurnGuard = { agentId: string; sourceTurnId: string; persistenceSessionId: string };

// closes: the agents Paseo closed (agent.closed), one entry per agent, kept apart from records so a record created
// after the close is held by it too.
type State = { version: 2; records: ResumeRecord[]; guards?: TurnGuard[]; closes?: AgentClose[] };

// Settled records (done, exhausted, opted out, superseded) only answer repeated turn events and keep recent evidence, so
// beyond this bound the oldest leave just a guard. A record that can still act, or is uncertain, is never pruned.
export const MAX_SETTLED_RECORDS = 200;
export const MAX_TURN_GUARDS = 2000;
export const MAX_AGENT_CLOSES = 1000;

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
// attemptsDropped, when present, counts attempts trimmed from the list; absent means none.
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function isAttempt(value: unknown): value is ResumeAttempt {
  if (typeof value !== "object" || value === null) return false;
  const attempt = value as Record<string, unknown>;
  return isTime(attempt.at) && isString(attempt.messageId) && isOneOf(attempt.result, RESULTS);
}

const isQuotaHold = (value: unknown) => typeof value === "object" && value !== null &&
  isTime((value as Record<string, unknown>).until) && isString((value as Record<string, unknown>).reason);

const isRpcTimeout = (value: unknown) => typeof value === "object" && value !== null &&
  isTime((value as Record<string, unknown>).giveUpAt) && nullable((value as Record<string, unknown>).waiting, isString);

const isClose = (value: unknown): value is AgentClose => typeof value === "object" && value !== null &&
  isId((value as Record<string, unknown>).agentId) && isTime((value as Record<string, unknown>).at) && isId((value as Record<string, unknown>).daemon);

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
    isTime(record.detectedAt) && nullable(record.lastUserMessageAt, isString) && nullable(record.originUserMessageAt, isString) && isString(record.failureSignature) &&
    isTime(record.notBefore) && nullable(record.resetAt, isTime) &&
    Array.isArray(record.attempts) && record.attempts.every(isAttempt) && optional(record.attemptsDropped, isCount) && isOneOf(record.state, STATES) &&
    nullable(record.sentAt, isTime) && nullable(record.resumeTurnId, isString) && nullable(record.resumeStartedAt, isTime) &&
    nullable(record.resumeFinishedAt, isTime) && nullable(record.verificationDeadlineAt, isTime) &&
    isTime(record.createdAt) && isTime(record.updatedAt) && nullable(record.terminalReason, isString) &&
    nullable(record.quotaHold, isQuotaHold) && nullable(record.rpcTimeout, isRpcTimeout);
}

function defaultState(): State {
  return { version: 2, records: [] };
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

  // Only a missing file reads as empty. A corrupt, unreadable or other-version file, or one with a malformed record or
  // malformed guards, throws, so the next write cannot erase its records and no automatic action is computed from it.
  private async load(): Promise<State> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const state = JSON.parse(raw) as State;
      if (state.version !== 2 || !Array.isArray(state.records)) throw new Error("invalid state");
      const invalid = state.records.findIndex((record) => !isRecord(record));
      if (invalid >= 0) throw new Error(`invalid record at index ${invalid}`);
      if (state.guards !== undefined && !(Array.isArray(state.guards) && state.guards.every(isGuard))) throw new Error("invalid guards");
      if (state.closes !== undefined && !(Array.isArray(state.closes) && state.closes.every(isClose))) throw new Error("invalid agent closes");
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

  /** True when a stored record sent this message ID: the turn it started is one of the plugin's own sends. */
  async isOwnSend(agentId: string, messageId: string | null | undefined): Promise<boolean> {
    if (!messageId) return false;
    return (await this.read()).some((record) => record.agentId === agentId && record.attempts.some((attempt) => attempt.messageId === messageId));
  }

  /**
   * Marks a turn the plugin started as handled, with the same guard a pruned record leaves, so a repeated or late event
   * for it reads as a duplicate whatever happens to its record later.
   */
  async markHandled(turn: TurnGuard): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const guards = state.guards ?? [];
      if (guards.some((guard) => sameTurn(guard, turn))) return;
      await this.persist(state.records, [...guards, guardOf(turn)].slice(-MAX_TURN_GUARDS), state.closes);
    });
  }

  /** The agent's stored close, if any. */
  async closeOf(agentId: string): Promise<AgentClose | null> {
    return (await this.load()).closes?.find((close) => close.agentId === agentId) ?? null;
  }

  /**
   * Stores a close of the agent, replacing any earlier one: Paseo sends one agent.closed per close, so a later event is
   * a later close of an agent that was open again. Closes another daemon run saw are dropped; they no longer apply.
   */
  async markClosed(close: AgentClose): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const kept = (state.closes ?? []).filter((other) => other.agentId !== close.agentId && other.daemon === close.daemon);
      await this.persist(state.records, state.guards, [...kept, close].slice(-MAX_AGENT_CLOSES));
    });
  }

  /** Removes this close, unless a newer one replaced it meanwhile. */
  async clearClose(close: AgentClose): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const closes = state.closes ?? [];
      const kept = closes.filter((other) => !(other.agentId === close.agentId && other.at === close.at && other.daemon === close.daemon));
      if (kept.length !== closes.length) await this.persist(state.records, state.guards, kept);
    });
  }

  // Every read-modify-write runs inside one queue, so concurrent hook handlers
  // cannot read the same state and overwrite each other's changes.
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(records: ResumeRecord[], guards: TurnGuard[] = [], closes: AgentClose[] = []): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const state: State = { version: 2, records, ...(guards.length > 0 ? { guards } : {}), ...(closes.length > 0 ? { closes } : {}) };
    await writeJsonAtomically(this.filePath, state, { mode: 0o600 });
  }

  async activeForAgent(agentId: string): Promise<ResumeRecord | null> {
    const records = await this.read();
    return records.find((record) => record.agentId === agentId && isActive(record)) ?? null;
  }

  async upsert(record: ResumeRecord): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const { records } = state;
      const index = records.findIndex((candidate) => candidate.recordId === record.recordId);
      if (index < 0) records.push(record);
      else records[index] = record;
      const kept = retain(records, state.guards);
      await this.persist(kept.records, kept.guards, state.closes);
    });
  }

  async update(recordId: string, update: (record: ResumeRecord) => ResumeRecord): Promise<ResumeRecord | null> {
    return this.exclusive(async () => {
      const state = await this.load();
      const index = state.records.findIndex((candidate) => candidate.recordId === recordId);
      if (index < 0) return null;
      const next = update(state.records[index]!);
      state.records[index] = next;
      await this.persist(state.records, state.guards, state.closes);
      return next;
    });
  }

  /**
   * Hands one record's work to a successor in a single write. Only while `owns` still holds for the stored record is it
   * settled (`settle`, or removed when that is null) and the successor added. A successor already stored is never
   * replaced. So of two handlers for the same turn end, the later one writes nothing: it can neither reset nor
   * resurrect the successor. Returns whether the handoff happened.
   */
  async handoff(recordId: string, owns: (record: ResumeRecord) => boolean, settle: ((record: ResumeRecord) => ResumeRecord) | null, successor: ResumeRecord): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      const { records } = state;
      const index = records.findIndex((candidate) => candidate.recordId === recordId);
      if (index < 0 || !owns(records[index]!) || records.some((candidate) => candidate.recordId === successor.recordId)) return false;
      const next = settle ? records.map((record, at) => at === index ? settle(record) : record) : records.filter((_, at) => at !== index);
      const kept = retain([...next, successor], state.guards);
      await this.persist(kept.records, kept.guards, state.closes);
      return true;
    });
  }

  async remove(recordId: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      await this.persist(state.records.filter((record) => record.recordId !== recordId), state.guards, state.closes);
    });
  }
}

// PM quota fallback: the return obligation, its decisions, and its own durable store. Kept apart from resume records
// so that superseding, settling or pruning a failed-turn record can never drop the duty to switch a PM back.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { agentPool, type PoolQuota } from "./quota.ts";
import type { AgentSnapshot } from "./model.ts";
import { StateUnreadableError } from "./store.ts";
import { writeJsonAtomically } from "./vendor/atomic-json.ts";
import { paseoHome } from "./vendor/daemon-target.ts";

/** The Pi Fast setting this feature owns; fleet routing reads it on every turn. Empty and absent both mean inherit. */
export const SERVICE_TIER_LABEL = "opc.service-tier";

export type Profile = { model: string; thinkingOptionId: string | null; serviceTier: string | null };

/**
 * One PM's duty to return. `switching` is the persisted intent to move to the fallback profile, written before the
 * settings change so a crash in between is finished, not forgotten. `fallback` holds until pq shows the original pool
 * usable again (`restoreDueAt`), and only a verified restore or an explicit owner cancel removes the obligation.
 */
export type ReturnObligation = {
  version: 1;
  obligationId: string;
  agentId: string;
  source: "auto" | "enrolled";
  phase: "switching" | "fallback";
  original: Profile;
  fallback: Profile;
  restoreDueAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const tier = (value: string | null | undefined) => value == null || value.trim() === "" ? null : value.trim();

export function profileOf(agent: AgentSnapshot): Profile | null {
  const model = agent.model ?? agent.runtimeInfo?.model;
  if (typeof model !== "string" || !model) return null;
  return { model, thinkingOptionId: agent.thinkingOptionId ?? null, serviceTier: tier(agent.labels?.[SERVICE_TIER_LABEL]) };
}

/** Model, thinking and the Fast label all read back as the profile; an absent and an empty label are equal. */
export function matchesProfile(agent: AgentSnapshot, profile: Profile): boolean {
  const actual = profileOf(agent);
  return !!actual && actual.model === profile.model && actual.thinkingOptionId === profile.thinkingOptionId && actual.serviceTier === tier(profile.serviceTier);
}

/** Why an agent may not be moved to the fallback profile, or null when it may: a live Pi PM on a Claude model. */
export function fallbackIneligible(agent: AgentSnapshot, optOutLabel: string): string | null {
  if (agent.labels?.role !== "pm") return "not-pm";
  if (agent.provider !== "pi") return "not-pi";
  if (agent.archivedAt) return "archived";
  if (agent.labels?.[optOutLabel] === "true") return "opted-out";
  if (!agent.persistence?.sessionId) return "no-session";
  if (agentPool(agent.provider, agent.model) !== "claude") return "not-claude";
  return null;
}

const known = (quota: PoolQuota): quota is Extract<PoolQuota, { status: "known" }> => quota.status === "known";

/** pq positively shows every Claude account out, and does not show the fallback pool out too (no ping-pong). */
export function swapDecision(claude: PoolQuota, fallback: PoolQuota): { swap: true } | { swap: false; reason: string } {
  if (!known(claude) || !claude.exhausted) return { swap: false, reason: known(claude) ? "claude-pool-has-capacity" : `claude-quota-unknown: ${claude.reason}` };
  if (known(fallback) && fallback.exhausted) return { swap: false, reason: "fallback-pool-exhausted" };
  return { swap: true };
}

/**
 * Whether the return is due after this reading. Due once a fresh reading shows a Claude account with quota left in
 * both the five-hour and the weekly window; a fresh reading of every account out makes it not due again. Unknown or
 * stale quota proves nothing and keeps the current decision.
 */
export function restoreDue(current: boolean, claude: PoolQuota): boolean {
  if (!known(claude)) return current;
  if (claude.available > 0) return true;
  if (claude.exhausted) return false;
  return current;
}

export function newObligation(agentId: string, original: Profile, fallback: Profile, source: ReturnObligation["source"], phase: ReturnObligation["phase"], now = Date.now()): ReturnObligation {
  const at = new Date(now).toISOString();
  return {
    version: 1, obligationId: `pm-return:${createHash("sha256").update([agentId, at, randomUUID()].join("\u0000")).digest("hex").slice(0, 24)}`,
    agentId, source, phase, original, fallback, restoreDueAt: null, attempts: 0, lastAttemptAt: null, lastError: null, createdAt: at, updatedAt: at,
  };
}

/** One owner enrollment entry from settings, applied once: its key is its content. */
export type Enrollment = { agentId: string; model: string; thinkingOptionId: string | null; serviceTier: string | null };
export const enrollmentKey = (entry: Enrollment) => `enroll:${createHash("sha256").update(JSON.stringify([entry.agentId, entry.model, entry.thinkingOptionId, tier(entry.serviceTier)])).digest("hex").slice(0, 24)}`;

type State = { version: 1; obligations: ReturnObligation[]; consumed: string[] };
const MAX_CONSUMED = 500;

const isTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isNullableString = (value: unknown) => value === null || typeof value === "string";
const isProfile = (value: unknown) => typeof value === "object" && value !== null &&
  typeof (value as Profile).model === "string" && (value as Profile).model !== "" &&
  isNullableString((value as Profile).thinkingOptionId) && isNullableString((value as Profile).serviceTier);

function isObligation(value: unknown): value is ReturnObligation {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return o.version === 1 && typeof o.obligationId === "string" && o.obligationId !== "" && typeof o.agentId === "string" && o.agentId !== "" &&
    (o.source === "auto" || o.source === "enrolled") && (o.phase === "switching" || o.phase === "fallback") &&
    isProfile(o.original) && isProfile(o.fallback) && (o.restoreDueAt === null || isTime(o.restoreDueAt)) &&
    Number.isSafeInteger(o.attempts) && (o.lastAttemptAt === null || isTime(o.lastAttemptAt)) && isNullableString(o.lastError) &&
    isTime(o.createdAt) && isTime(o.updatedAt);
}

/** The obligation file. Missing reads as none; anything unreadable throws and nothing is changed or acted on. */
export class ReturnStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath = path.join(paseoHome(), "plugin-state", "usage-limit-auto-resume", "pm-return.json")) {
    this.filePath = filePath;
  }

  private async load(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8")) as State;
      if (state.version !== 1 || !Array.isArray(state.obligations) || !Array.isArray(state.consumed)) throw new Error("invalid state");
      if (!state.obligations.every(isObligation)) throw new Error("invalid obligation");
      if (!state.consumed.every((key) => typeof key === "string")) throw new Error("invalid consumed keys");
      if (new Set(state.obligations.map((o) => o.agentId)).size !== state.obligations.length) throw new Error("two obligations for one agent");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, obligations: [], consumed: [] };
      throw new StateUnreadableError(`cannot read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async read(): Promise<State> {
    return this.load();
  }

  async get(agentId: string): Promise<ReturnObligation | null> {
    return (await this.load()).obligations.find((o) => o.agentId === agentId) ?? null;
  }

  /** Read-modify-write inside one queue. The callback returns the next state, or null to write nothing. */
  change<T>(apply: (state: State) => { state: State; result: T } | null): Promise<T | null> {
    const run = this.queue.then(async () => {
      const next = apply(await this.load());
      if (!next) return null;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeJsonAtomically(this.filePath, { ...next.state, consumed: next.state.consumed.slice(-MAX_CONSUMED) }, { mode: 0o600 });
      return next.result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Adds an obligation unless the agent already has one; returns the one that stands. */
  add(obligation: ReturnObligation, consumedKey?: string): Promise<ReturnObligation | null> {
    return this.change((state) => {
      const existing = state.obligations.find((o) => o.agentId === obligation.agentId);
      if (existing) return null;
      return { state: { ...state, obligations: [...state.obligations, obligation], consumed: consumedKey ? [...state.consumed, consumedKey] : state.consumed }, result: obligation };
    });
  }

  /** Updates the obligation with this id; a removed or replaced obligation is left alone. */
  update(obligationId: string, apply: (o: ReturnObligation) => ReturnObligation): Promise<ReturnObligation | null> {
    return this.change((state) => {
      const index = state.obligations.findIndex((o) => o.obligationId === obligationId);
      if (index < 0) return null;
      const next = apply(state.obligations[index]!);
      const obligations = [...state.obligations];
      obligations[index] = next;
      return { state: { ...state, obligations }, result: next };
    });
  }

  remove(obligationId: string): Promise<ReturnObligation | null> {
    return this.change((state) => {
      const found = state.obligations.find((o) => o.obligationId === obligationId);
      if (!found) return null;
      return { state: { ...state, obligations: state.obligations.filter((o) => o !== found) }, result: found };
    });
  }

  consume(key: string): Promise<true | null> {
    return this.change((state) => state.consumed.includes(key) ? null : { state: { ...state, consumed: [...state.consumed, key] }, result: true as const });
  }
}

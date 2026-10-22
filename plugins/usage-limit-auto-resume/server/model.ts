import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { agentPool, quotaHold, usageResumeAt, type PoolQuota, type QuotaHold, type QuotaPool, type QuotaSettings } from "./quota.ts";

export type ResumeState = "detected" | "parked" | "resuming" | "verifying" | "done" | "exhausted" | "opted-out" | "superseded" | "uncertain";

/** Transient uncertainty is recoverable, not terminal; usage uncertainty still fails closed. */
export function isActive(record: { state: ResumeState; kind?: ResumeRecord["kind"] }): boolean {
  return record.state === "detected" || record.state === "parked" || record.state === "resuming" || record.state === "verifying" ||
    (record.kind === "transient" && record.state === "uncertain");
}

export type ResumeAttempt = {
  at: string;
  messageId: string;
  result: "sent" | "send-failed" | "unknown" | "recovered";
};

export type ResumeRecord = {
  version: 2;
  kind?: "usage" | "transient";
  failedOutcome?: boolean;
  // Usage failures also leave Pi in error, but retain the usage delay.
  usageFailedOutcome?: boolean;
  retryPrompt?: string;
  expectedUserText?: string;
  expectedUserMessageId?: string | null;
  failedAssistantText?: string;
  recordId: string;
  sourceTurnId: string;
  agentId: string;
  workspaceId: string | null;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  cwd: string;
  persistenceSessionId: string;
  nativeHandle: string | null;
  configFingerprint: string;
  detectedAt: string;
  lastUserMessageAt: string | null;
  // The user message the work began with: the failed turn's own when the work's first record was created, then carried
  // unchanged by every successor and re-park, never read again from a later agent snapshot. Only it can show that the
  // work is newer than an agent close (closeDecision). Absent on records from before 0.3.0.
  originUserMessageAt?: string | null;
  failureSignature: string;
  notBefore: string;
  resetAt: string | null;
  attempts: ResumeAttempt[];
  // Older attempts trimmed from `attempts`; they still count toward the next attempt's message ID.
  attemptsDropped?: number;
  state: ResumeState;
  sentAt: string | null;
  resumeTurnId: string | null;
  resumeStartedAt: string | null;
  resumeFinishedAt: string | null;
  verificationDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  terminalReason: string | null;
  // Set while the whole pq pool is out: no send before `until`, re-checked against pq on every due sweep.
  quotaHold?: QuotaHold | null;
  // A Pi prompt RPC timeout: wait for the agent to settle, then resend the original message once (see rpcTimeoutDecision).
  rpcTimeout?: RpcTimeoutWait | null;
  // The pq pool whose provider refused the failed turn for quota (see quotaRefused); absent for any other failure.
  refusedPool?: QuotaPool | null;
};

export type RpcTimeoutWait = { giveUpAt: string; waiting: string | null };

/** Paseo closed this agent (`agent.closed`): when, and which daemon run saw it (the plugin's parent process). */
export type AgentClose = { agentId: string; at: string; daemon: string };

// Paseo 0.11.1 closes every agent when the daemon shuts down, with the same `agent.closed` event an explicit close or
// kill sends, and stops plugins a few seconds later. A close this daemon run still outlives by this long was an
// explicit one.
export const AGENT_CLOSE_GRACE_MS = 60_000;

/**
 * What the agent's close means for one of its records now. The close belongs to the agent, not to a record, so it
 * holds every record of the agent, including one a handler created after the close.
 * - "go": no close, or the record's work is newer than it: the user message the work began with (originUserMessageAt)
 *   came after the close, so someone opened the agent again with that message.
 * - "stale": an earlier daemon run saw the close, which was that run's shutdown. It no longer applies.
 * - "hold": this daemon run saw the close less than AGENT_CLOSE_GRACE_MS ago. Nothing is sent or read for the record.
 * - "end": this daemon run has outlived the close, so it was a kill or close by a user or an agent. The record ends.
 */
export function closeDecision(close: AgentClose | null, record: Pick<ResumeRecord, "originUserMessageAt">, daemon: string, now = Date.now()): "go" | "stale" | "hold" | "end" {
  if (!close) return "go";
  if (close.daemon !== daemon) return "stale";
  if (record.originUserMessageAt && Date.parse(record.originUserMessageAt) > Date.parse(close.at)) return "go";
  return Date.parse(close.at) + AGENT_CLOSE_GRACE_MS <= now ? "end" : "hold";
}

/**
 * The agent still has no user message newer than the turn that ended at `endedAt` (when its turn_ended event arrived),
 * so its latest user message is the one that turn ran on. A turn-end handler reads the agent after awaiting; if a user
 * message reached the agent meanwhile, the failure is stale and creates no record. Otherwise the record would take
 * that newer message's time for the old failed turn and pass the newer-message and close checks as new work.
 */
export function isBoundToTurn(agent: Pick<AgentSnapshot, "lastUserMessageAt">, endedAt: number): boolean {
  return !agent.lastUserMessageAt || Date.parse(agent.lastUserMessageAt) <= endedAt;
}

// Retry immediately, then after 2, 5 and 15 minutes, then every 30 minutes: the last step repeats for as long as the
// record lives. No attempt count ends a record.
export const DEFAULT_BACKOFF_SECONDS: readonly number[] = [0, 120, 300, 900, 1800];

export type ResumeConfig = {
  transientBackoffSeconds?: readonly number[];
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  resetBufferSeconds: number;
  verificationTimeoutSeconds: number;
  excludedProviders: readonly string[];
  excludedLabels: readonly string[];
};

export type AgentSnapshot = {
  id: string;
  workspaceId?: string | null;
  provider: string;
  model?: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  cwd: string;
  title?: string | null;
  status: string;
  lastError?: string;
  activeTurn?: { turnId: string; startedAt?: string | null } | null;
  pendingPermissions?: readonly unknown[];
  requiresAttention?: boolean;
  attentionReason?: string | null;
  archivedAt?: string | null;
  lastUserMessageAt?: string | null;
  updatedAt?: string | null;
  persistence?: { provider: string; sessionId: string; nativeHandle?: string; metadata?: Record<string, unknown> } | null;
  labels?: Record<string, string>;
  runtimeInfo?: { model?: string | null } | null;
};

const FAILURE_PATTERNS: readonly RegExp[] = [
  /\busage[_ -]?limit[_ -]?(?:exceeded|reached)\b/i,
  /\b(?:you(?:'|’)?ve|you have) hit your usage limit\b/i,
  /\binsufficient[_ -]?quota\b/i,
  /\bout of credits\b/i,
  /\bweekly limit reached\b/i,
  /\bfive[- ]hour limit reached\b/i,
  /\b5[- ]hour limit reached\b/i,
  /\bquota (?:exhausted|reached)\b/i,
];

// Bounded by any non-alphanumeric character, so a provider code with an underscore suffix (overloaded_error,
// context_length_exceeded, model_cooldown_active) is blocked too and keeps its precedence over usage and quota matches.
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /(?<![a-z0-9])context (?:window|length) (?:exceeded|limit)(?![a-z0-9])/i,
  /(?<![a-z0-9])context[_ -]?length(?![a-z0-9])/i,
  /(?<![a-z0-9])too many tokens(?![a-z0-9])/i,
  /(?<![a-z0-9])model[_ -]?cooldown(?![a-z0-9])/i,
  /(?<![a-z0-9])overloaded(?![a-z0-9])/i,
  /(?<![a-z0-9])temporarily limiting requests(?![a-z0-9])/i,
];

// Claude synthetic assistant messages use API Error prefixes; Codex reports model capacity.
const TRANSIENT_API_PATTERN = /^API Error:\s*[\s\S]*\b(?:rate[_ -]?limit|temporarily limiting requests|overloaded|529|429)\b/i;
// Codex capacity arrives as "[System Error] Selected model is at capacity. Please try a different model."
const CAPACITY_PATTERN = /^(?:\[System Error\]\s*)?(?:API Error:\s*)?Selected model is at capacity\s*[.!]?(?:\s*Please try a different model\s*[.!]?)?$/i;
// Failed-outcome error messages come from the provider, never from model prose, so a broader match is safe.
// Provider errors include "Selected model is at capacity. Please try a different model."
// and "We’re currently experiencing high demand, which may cause temporary errors."
const TRANSIENT_ERROR_PATTERN = /\b(?:selected model is at capacity|experiencing high demand|temporary errors?|temporarily (?:unavailable|limiting requests)|overloaded(?:_error)?|rate[_ -]?limit(?:ed|_error)?|429|529|503)\b/i;

// Provider quota refusals the strict usage-limit classifier does not accept: a 429 rate limit (Anthropic's
// rate_limit_error) and the 402 "credit balance is too low" of an API-key route. Alone they stay transient; on a failed
// turn they are quota evidence, which counts only while pq shows the pool out (see quotaRefused and poolOut).
// Evidence, all read on the raw error text (blocked patterns still take precedence):
// - a structured error code: 429, 402, rate_limit*, insufficient_credit(s) (QUOTA_CODE_PATTERN);
// - a phrase: a rate-limit word ("rate limit", "rate_limit_error", "rate limited", ..., not inside a path or an ID),
//   "credit balance is too low", "insufficient credit(s)", or "Too Many Requests";
// - a numeric status only at the start of the error, after an optional "[System Error]" or "API Error:": 429 or 402
//   followed by a JSON body, its reason phrase ("Too Many Requests", "Payment Required"), "status code", ":" and the
//   error text, or nothing ("429 {...}", "402 Payment Required", "API Error: 429");
// - a quoted JSON status or code key with 429 ("status":429, "status_code":429, "code":429), or "rejected (429)".
// A status number anywhere else in the text (an "HTTP 429" mid-message with no phrase and no code) is no evidence: such
// an error stays transient.
const STATUS_REST = String.raw`(?:\s*\{|\s*:\s*\S|\s+status code\b|\s*$)`;
// Every rule-B phrase stands on its own, never inside a path, a URL or an ID: not preceded by a word character, "/",
// "\", ".", "-" or a drive-letter colon ("C:"), and not followed by a word character, "/", "\", "-", or a "." that
// starts a word ("too low.log"). A sentence-ending "." before a space, a quote or the end still counts.
const phrase = (body: string) => String.raw`(?<![\w\/\\.-])(?<!(?:^|[^\w])[A-Za-z]:)(?:${body})(?![\w\/\\-]|\.\w)`;
const QUOTA_ERROR_PATTERN = new RegExp([
  String.raw`^\s*(?:\[System Error\]\s*)?(?:API Error:\s*)?(?:429${STATUS_REST}|402(?:\s*[-(]?\s*Payment Required\b|${STATUS_REST}))`,
  String.raw`"(?:status|status_?code|code)"\s*:\s*"?429(?![\w\/\\-]|\.\w)`,
  String.raw`\b(?:error|rejected)\s*\(429\)`,
  phrase(String.raw`rate[_ -]?limit(?:ed|s|_error|_exceeded)?`),
  phrase(String.raw`insufficient[_ -]credits?`),
  phrase(String.raw`credit balance is too low`),
  phrase(String.raw`Too Many Requests`),
].join("|"), "i");
// A structured error code that is itself the status or the provider's quota code.
const QUOTA_CODE_PATTERN = /^\s*(?:429|402|rate[_ -]?limit(?:ed|_error|_exceeded)?|insufficient_credits?)\s*$/i;

export function isQuotaError(message: string, code?: string): boolean {
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(`${code ?? ""} ${message}`))) return false;
  return QUOTA_CODE_PATTERN.test(code ?? "") || QUOTA_ERROR_PATTERN.test(message);
}

/** The model a failed turn's error names: Pi ends its failed-turn errors with "(stopReason=error, model=<id>)". */
export function namedModel(message: string): string | null {
  return message.match(/\bmodel=([^\s,)]+)/)?.[1] ?? null;
}

/** The pool of the model that refused: the one the error names, else the model the turn ran on. */
export function refusingPool(provider: string, model: string, message: string): QuotaPool | null {
  return agentPool(provider, namedModel(message) ?? model);
}

/**
 * The record's failed turn was refused for quota by the pool its agent still draws on. The evidence keeps the pool of
 * the model that refused; a record that moved to another profile drops it (rebindRecord), so it never applies there.
 */
export function quotaRefused(record: Pick<ResumeRecord, "refusedPool" | "provider" | "model">): boolean {
  return !!record.refusedPool && record.refusedPool === agentPool(record.provider, record.model);
}

export function isTransientAssistantText(message: string): boolean {
  const text = message.trim();
  if (!text || failureSignature(text)) return false;
  return TRANSIENT_API_PATTERN.test(text) || CAPACITY_PATTERN.test(text);
}

export function isTransientErrorMessage(message: string, code?: string): boolean {
  const text = `${code ?? ""} ${message}`.trim();
  if (!text || failureSignature(message, code)) return false;
  return TRANSIENT_ERROR_PATTERN.test(text);
}

export function lastUserMessage(timeline: readonly AgentTimelineItem[]): Extract<AgentTimelineItem, { type: "user_message" }> | null {
  const user = timeline.findLast((item) => item.type === "user_message");
  return user?.type === "user_message" ? user : null;
}

export function isUsageLimitAssistantText(message: string): boolean {
  const text = message.trim();
  return (/^API Error:/i.test(text) || /^(?:Your weekly limit reached|You are out of credits|(?:5|five)[- ]hour limit reached)/i.test(text)) && failureSignature(text) !== null;
}

export function turnText(timeline: readonly AgentTimelineItem[]): { assistant: string | null; user: Extract<AgentTimelineItem, { type: "user_message" }> | null } {
  const last = timeline.at(-1);
  if (!last || last.type !== "assistant_message") return { assistant: null, user: null };
  let firstAssistant = timeline.length - 1;
  while (firstAssistant > 0 && timeline[firstAssistant - 1]?.type === "assistant_message") firstAssistant--;
  const assistant = timeline.slice(firstAssistant).map((item) => item.type === "assistant_message" ? item.text : "").join("");
  const user = timeline.slice(0, firstAssistant).findLast((item) => item.type === "user_message");
  return { assistant, user: user?.type === "user_message" ? user : null };
}

export function transientDelaySeconds(config: ResumeConfig, attempts: number): number {
  const delays = config.transientBackoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
  return delays[Math.min(attempts, delays.length - 1)]!;
}

export function failureSignature(message: string, code?: string): string | null {
  const text = `${code ?? ""} ${message}`;
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(text))) return null;
  if (!FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 24);
}

function parseResetAt(message: string, now: number, maxDelayMs: number): string | null {
  const epoch = message.match(/\b(?:reset(?:_?at)?|resets(?:_?at)?)[^0-9]*(\d{10})\b/i);
  if (epoch) {
    const ms = Number(epoch[1]) * 1000;
    if (Number.isFinite(ms) && ms > now) return new Date(Math.min(ms, now + maxDelayMs)).toISOString();
  }
  const relative = message.match(/\b(?:try again|reset|resets|available) in (\d+)\s*(seconds?|minutes?|hours?|days?)\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const multiplier = unit.startsWith("second") ? 1000 : unit.startsWith("minute") ? 60000 : unit.startsWith("hour") ? 3600000 : 86400000;
    const ms = amount * multiplier;
    if (Number.isFinite(ms) && ms > 0) return new Date(Math.min(now + ms, now + maxDelayMs)).toISOString();
  }
  return null;
}

export function configFingerprint(agent: AgentSnapshot): string {
  return createHash("sha256").update([
    agent.provider,
    agent.model ?? "",
    agent.currentModeId ?? "",
    agent.thinkingOptionId ?? "",
    agent.cwd,
    agent.persistence?.provider ?? "",
    agent.persistence?.sessionId ?? "",
    agent.persistence?.nativeHandle ?? "",
  ].join("\u0000")).digest("hex").slice(0, 32);
}

export function isOptedOut(agent: AgentSnapshot, config: ResumeConfig): boolean {
  const labels = agent.labels ?? {};
  return config.excludedLabels.some((label) => labels[label] === "true") || config.excludedProviders.includes(agent.provider);
}

export function isSameAgentAndSession(record: ResumeRecord, agent: AgentSnapshot): boolean {
  return agent.id === record.agentId &&
    agent.provider === record.provider &&
    (agent.model ?? null) === record.model &&
    (agent.currentModeId ?? null) === record.modeId &&
    (agent.thinkingOptionId ?? null) === record.thinkingOptionId &&
    agent.cwd === record.cwd &&
    agent.persistence?.provider === record.provider &&
    agent.persistence?.sessionId === record.persistenceSessionId &&
    (agent.persistence?.nativeHandle ?? null) === record.nativeHandle &&
    configFingerprint(agent) === record.configFingerprint &&
    agent.archivedAt == null;
}

export function buildRecord(eventAgent: AgentSnapshot, failureMessage: string, code: string | undefined, config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null, usageFailedOutcome = false): ResumeRecord | null {
  if (!sourceTurnId) return null;
  const signature = failureSignature(failureMessage, code);
  if (!signature || isOptedOut(eventAgent, config) || eventAgent.archivedAt) return null;
  if (!eventAgent.persistence?.sessionId) return null;
  const model = eventAgent.model ?? eventAgent.persistence?.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const resetAt = parseResetAt(failureMessage, now, config.maxDelaySeconds * 1000);
  const delayMs = Math.min(config.baseDelaySeconds * 1000, config.maxDelaySeconds * 1000);
  const identity = configFingerprint(eventAgent);
  const recordId = `resume:${createHash("sha256").update([eventAgent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  return {
    version: 2,
    recordId,
    sourceTurnId,
    usageFailedOutcome,
    ...(usageFailedOutcome ? { refusedPool: refusingPool(eventAgent.provider, model, failureMessage) } : {}),
    agentId: eventAgent.id,
    workspaceId: eventAgent.workspaceId ?? null,
    provider: eventAgent.provider,
    model,
    modeId: eventAgent.currentModeId ?? null,
    thinkingOptionId: eventAgent.thinkingOptionId ?? null,
    cwd: eventAgent.cwd,
    persistenceSessionId: eventAgent.persistence.sessionId,
    nativeHandle: eventAgent.persistence.nativeHandle ?? null,
    configFingerprint: identity,
    detectedAt,
    lastUserMessageAt: eventAgent.lastUserMessageAt ?? null,
    originUserMessageAt: eventAgent.lastUserMessageAt ?? null,
    failureSignature: signature,
    notBefore: new Date(Math.max(now + delayMs, resetAt ? Date.parse(resetAt) + config.resetBufferSeconds * 1000 : 0)).toISOString(),
    resetAt,
    attempts: [],
    state: "detected",
    sentAt: null,
    resumeTurnId: null,
    resumeStartedAt: null,
    resumeFinishedAt: null,
    verificationDeadlineAt: null,
    createdAt: detectedAt,
    updatedAt: detectedAt,
    terminalReason: null,
  };
}

/**
 * A new usage record's schedule from the pool's quota: about a buffer after the earliest real reset instead of the
 * flat delay (only when that is sooner, while another account still has quota), and a visible hold when the whole
 * pool is out. An unknown quota, or a pool pq shows no out account in,
 * keeps the record as built.
 */
export function scheduleUsage(record: ResumeRecord, quota: PoolQuota, settings: QuotaSettings & { messageBufferSeconds: number }, now = Date.now()): ResumeRecord {
  const reset = usageResumeAt(quota, record.resetAt, settings.messageBufferSeconds, settings, now);
  if (reset === null) return record;
  // While some account still has quota, a reset can bring the resume earlier but never later than the flat delay.
  const at = quota.status === "known" && !quota.exhausted ? Math.min(reset, Date.parse(record.notBefore)) : reset;
  const hold = quotaHold(quota, settings, now, quotaRefused(record));
  return { ...record, notBefore: new Date(at).toISOString(), ...(hold ? { quotaHold: hold } : {}) };
}

/**
 * The pre-send quota decision: hold while the whole pool is out, otherwise send as before. After a quota refusal from
 * this pool, an account pq cannot show with quota left counts as out (poolOut).
 */
export function quotaDecision(record: ResumeRecord, quota: PoolQuota, settings: QuotaSettings, now = Date.now()): { hold: QuotaHold | null; changed: boolean } {
  const hold = quotaHold(quota, settings, now, quotaRefused(record));
  return { hold, changed: (hold?.reason ?? null) !== (record.quotaHold?.reason ?? null) };
}

export function buildTransientRecord(agent: AgentSnapshot, timeline: readonly AgentTimelineItem[], config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null): ResumeRecord | null {
  if (!sourceTurnId || isOptedOut(agent, config) || agent.archivedAt || !agent.persistence?.sessionId || !agent.lastUserMessageAt) return null;
  const { assistant, user } = turnText(timeline);
  if (!assistant || !isTransientAssistantText(assistant) || !user) return null;
  const model = agent.model ?? agent.persistence.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const identity = configFingerprint(agent);
  const recordId = `transient:${createHash("sha256").update([agent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  return {
    version: 2, kind: "transient", recordId, sourceTurnId, agentId: agent.id,
    workspaceId: agent.workspaceId ?? null, provider: agent.provider, model,
    modeId: agent.currentModeId ?? null, thinkingOptionId: agent.thinkingOptionId ?? null,
    cwd: agent.cwd, persistenceSessionId: agent.persistence.sessionId,
    nativeHandle: agent.persistence.nativeHandle ?? null, configFingerprint: identity,
    detectedAt, lastUserMessageAt: agent.lastUserMessageAt, originUserMessageAt: agent.lastUserMessageAt,
    failureSignature: createHash("sha256").update(assistant).digest("hex").slice(0, 24),
    failedAssistantText: assistant, expectedUserText: user.text,
    expectedUserMessageId: user.messageId ?? user.clientMessageId ?? null,
    retryPrompt: user.text || `Continue the last user request from this conversation. Inspect current state first and avoid repeating completed side effects. [auto-retry:${recordId}]`,
    notBefore: new Date(now + transientDelaySeconds(config, 0) * 1000).toISOString(),
    resetAt: null, attempts: [], state: "detected", sentAt: null,
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    verificationDeadlineAt: null, createdAt: detectedAt, updatedAt: detectedAt, terminalReason: null,
  };
}

// Paseo's Pi provider fails a turn when Pi does not acknowledge the prompt RPC within rpcTimeoutMs. Pi acknowledges only
// after its prompt preflight, which runs Pi's own threshold compaction first, so the prompt is still pending in Pi and
// usually runs on its own once compaction ends. Only Pi's own diagnostic counts; other providers (OMP emits a similar
// one) keep the ordinary failed-turn path.
export const RPC_PROMPT_TIMEOUT_PATTERN = /^(?:\[System Error\]\s*)?Pi RPC request timed out phase=prompt\b/;
// The longest a prompt-timeout record waits for the agent to settle before it gives up without sending.
export const RPC_TIMEOUT_MAX_WAIT_MS = 30 * 60_000;
// The quiet time after the failure and after compaction completes, so a prompt Pi runs on its own shows up first.
export const RPC_TIMEOUT_QUIET_MS = 60_000;

export function isRpcPromptTimeout(message: string, provider = "pi"): boolean {
  return provider === "pi" && RPC_PROMPT_TIMEOUT_PATTERN.test(message);
}

export function buildFailedTransientRecord(agent: AgentSnapshot, timeline: readonly AgentTimelineItem[], error: { message: string; code?: string }, config: ResumeConfig, now = Date.now(), sourceTurnId?: string | null): ResumeRecord | null {
  if (!sourceTurnId || isOptedOut(agent, config) || agent.archivedAt || !agent.persistence?.sessionId || !agent.lastUserMessageAt) return null;
  if (failureSignature(error.message, error.code)) return null;
  const user = lastUserMessage(timeline);
  if (!user) return null;
  const rpcTimeout = isRpcPromptTimeout(error.message, agent.provider);
  // Nothing to resend: the timeline keeps only a user message's text, so an attachment-only message is not replayed.
  if (rpcTimeout && !user.text.trim()) return null;
  const model = agent.model ?? agent.persistence.metadata?.model;
  if (typeof model !== "string" || !model) return null;
  const detectedAt = new Date(now).toISOString();
  const identity = configFingerprint(agent);
  const recordId = `transient:${createHash("sha256").update([agent.id, sourceTurnId, identity].join("\u0000")).digest("hex").slice(0, 32)}`;
  const failure = `failed: ${error.message}`;
  return {
    version: 2, kind: "transient", failedOutcome: true, recordId, sourceTurnId, agentId: agent.id,
    workspaceId: agent.workspaceId ?? null, provider: agent.provider, model,
    modeId: agent.currentModeId ?? null, thinkingOptionId: agent.thinkingOptionId ?? null,
    cwd: agent.cwd, persistenceSessionId: agent.persistence.sessionId,
    nativeHandle: agent.persistence.nativeHandle ?? null, configFingerprint: identity,
    detectedAt, lastUserMessageAt: agent.lastUserMessageAt, originUserMessageAt: agent.lastUserMessageAt,
    failureSignature: createHash("sha256").update(failure).digest("hex").slice(0, 24),
    failedAssistantText: failure, expectedUserText: user.text,
    expectedUserMessageId: user.messageId ?? user.clientMessageId ?? null,
    // Pure resume: the failed turn may have done partial work, so never replay the original prompt. A prompt timeout
    // never started its turn, so it resends the original message, once, after rpcTimeoutDecision allows it.
    retryPrompt: rpcTimeout ? user.text : "continue",
    ...(rpcTimeout ? { rpcTimeout: { giveUpAt: new Date(now + RPC_TIMEOUT_MAX_WAIT_MS).toISOString(), waiting: null } } : {}),
    ...(isQuotaError(error.message, error.code) ? { refusedPool: refusingPool(agent.provider, model, error.message) } : {}),
    notBefore: new Date(now + transientDelaySeconds(config, 0) * 1000).toISOString(),
    resetAt: null, attempts: [], state: "detected", sentAt: null,
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    verificationDeadlineAt: null, createdAt: detectedAt, updatedAt: detectedAt, terminalReason: null,
  };
}

/**
 * The timeline's newest user row is the one the record checked: the original human message before the first send, or
 * the record's own last send after a failed retry. `lastUserMessageAt` is the agent's, read with or before the timeline.
 */
export function verifyTransientTimeline(record: ResumeRecord, timeline: readonly AgentTimelineItem[], lastUserMessageAt: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const { assistant, user } = record.failedOutcome ? { assistant: record.failedAssistantText ?? null, user: lastUserMessage(timeline) } : turnText(timeline);
  if (!assistant || assistant !== record.failedAssistantText) return { ok: false, reason: "failure-text-changed" };
  if (!user) return { ok: false, reason: "user-prompt-missing" };
  if (!isExpectedUser(record, user, lastUserMessageAt)) return { ok: false, reason: "newer-user-message" };
  return { ok: true };
}

/**
 * The user row is the one the record expects: the same text, and the same message ID or, on a timeline Paseo rebuilt
 * after a daemon restart, the same message by its time. A rebuild gives every user row a new ID and no clientMessageId,
 * so the ID of the original human message and of the plugin's own sends no longer match. Any newer user message moves
 * the agent's lastUserMessageAt, so an unchanged lastUserMessageAt, not the ID, proves it is the same message. A row that
 * still carries a clientMessageId is a live row, whose ID must match.
 */
export function isExpectedUser(record: Pick<ResumeRecord, "expectedUserText" | "expectedUserMessageId" | "lastUserMessageAt">, user: Extract<AgentTimelineItem, { type: "user_message" }>, lastUserMessageAt: string | null | undefined): boolean {
  if (user.text !== record.expectedUserText) return false;
  const id = user.messageId ?? user.clientMessageId ?? null;
  if (!record.expectedUserMessageId || id === record.expectedUserMessageId) return true;
  return !user.clientMessageId && !!lastUserMessageAt && lastUserMessageAt === record.lastUserMessageAt;
}

/** A prompt-timeout record that has not sent its one resend and has not ended. */
export function isRpcTimeoutWaiting(record: ResumeRecord): boolean {
  return !!record.rpcTimeout && attemptCount(record) === 0 && ["detected", "parked", "uncertain"].includes(record.state);
}

type TimelineEntry = { item: AgentTimelineItem; timestamp: string };

const isRpcTimeoutRow = (item: AgentTimelineItem) =>
  (item.type === "assistant_message" && /^\[System Error\]/.test(item.text) && isRpcPromptTimeout(item.text)) ||
  (item.type === "error" && isRpcPromptTimeout(item.message));

// Positive proof the model ran: its reasoning, a tool call, or a real answer (not a System Error row).
const isExecutionRow = (item: AgentTimelineItem) => item.type === "reasoning" || item.type === "tool_call" ||
  (item.type === "assistant_message" && !/^\[System Error\]/.test(item.text));

/**
 * What a prompt-timeout record does now. The signal is the agent's own timeline since the original message: Pi's
 * compaction rows (a `loading` row with no later `completed` row means compaction is still running) and execution rows
 * (reasoning, a tool call, an answer), which mean Pi ran the prompt or another turn on its own. Any other row (a
 * notification, an error, a todo) proves nothing either way: the record waits, and expires if nothing else decides it.
 * Paseo's agent status cannot show this compaction: the timed-out turn is already failed while Pi is still compacting.
 * The send needs an idle agent, no compaction, and RPC_TIMEOUT_QUIET_MS without new rows. Callers run this again on
 * the final timeline read right before the send.
 */
export function rpcTimeoutDecision(record: ResumeRecord, agent: AgentSnapshot, timeline: readonly TimelineEntry[] | null, now = Date.now()):
  { act: "send" } | { act: "wait"; reason: string } | { act: "stop"; state: ResumeState; reason: string } {
  if (!record.rpcTimeout || Date.parse(record.rpcTimeout.giveUpAt) <= now) return { act: "stop", state: "exhausted", reason: "rpc-timeout-wait-expired" };
  if (agent.activeTurn || agent.status === "running") return { act: "stop", state: "superseded", reason: "agent-resumed-itself" };
  if (agent.status !== "idle" && agent.status !== "error") return { act: "wait", reason: `agent-status=${agent.status}` };
  if (!timeline) return { act: "wait", reason: "timeline-unavailable" };
  const start = timeline.findLastIndex((entry) => entry.item.type === "user_message");
  const user = timeline[start]?.item;
  if (user?.type !== "user_message" || !isExpectedUser(record, user, agent.lastUserMessageAt)) {
    return { act: "stop", state: "superseded", reason: "newer-user-message" };
  }
  const after = timeline.slice(start + 1).filter((entry) => entry.item.type !== "plugin");
  if (after.some((entry) => isExecutionRow(entry.item))) return { act: "stop", state: "superseded", reason: "agent-resumed-itself" };
  if (after.some((entry) => entry.item.type !== "compaction" && !isRpcTimeoutRow(entry.item))) return { act: "wait", reason: "unproven-activity" };
  const compaction = after.findLast((entry) => entry.item.type === "compaction");
  if (compaction?.item.type === "compaction" && compaction.item.status === "loading") return { act: "wait", reason: "compaction-in-progress" };
  const lastActivity = Math.max(Date.parse(record.detectedAt), ...after.map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite));
  if (lastActivity + RPC_TIMEOUT_QUIET_MS > now) return { act: "wait", reason: "settling" };
  return { act: "send" };
}

export function transientRejectionState(reason: string): ResumeState {
  return reason === "newer-user-message" ? "superseded" : reason === "rpc-timeout-resent" ? "exhausted" : "uncertain";
}

// Records retry without a cap, so only their newest attempts are kept in full.
export const MAX_KEPT_ATTEMPTS = 20;

export function attemptCount(record: ResumeRecord): number {
  return (record.attemptsDropped ?? 0) + record.attempts.length;
}

/**
 * Re-parks a transient record after its retry failed again, on the next backoff step. No attempt count and no repeat of
 * the same error ends it. `failure` is the failed outcome's own error, with its code when the caller has it: it, not the
 * `failed: ...` text, decides whether this was a quota refusal (which can hold the next send while pq shows the pool
 * out), and the refusal belongs to the pool of the model that refused (refusingPool). `textOnly` marks a re-read of the
 * live error (re-verification), which has no code and no turn: it recognizes no new evidence. A re-read of the same
 * failure without its code keeps the record's evidence as it is, on the pool it came from; carried evidence never moves
 * to another pool.
 */
export function afterTransientFailure(record: ResumeRecord, assistant: string, userText: string, userMessageId: string, lastUserMessageAt: string, config: ResumeConfig, now = Date.now(), failure: { message: string; code?: string; textOnly?: boolean } | null = null): ResumeRecord {
  const signature = createHash("sha256").update(assistant).digest("hex").slice(0, 24);
  const same = signature === record.failureSignature;
  const recognized = !!record.failedOutcome && !!failure && !failure.textOnly && isQuotaError(failure.message, failure.code);
  const carried = !!record.failedOutcome && !!failure && !failure.code && same ? record.refusedPool ?? null : null;
  const refusedPool = recognized ? refusingPool(record.provider, record.model, failure!.message) : carried;
  const updatedAt = new Date(now).toISOString();
  const attempts = record.attempts.slice(-MAX_KEPT_ATTEMPTS);
  const dropped = record.attempts.length - attempts.length;
  return {
    ...record,
    ...(dropped > 0 ? { attempts, attemptsDropped: (record.attemptsDropped ?? 0) + dropped } : {}),
    state: "parked",
    terminalReason: null,
    failedAssistantText: assistant,
    failureSignature: signature,
    refusedPool,
    expectedUserText: userText,
    expectedUserMessageId: userMessageId,
    lastUserMessageAt,
    notBefore: new Date(now + transientDelaySeconds(config, attemptCount(record)) * 1000).toISOString(),
    resumeTurnId: null, resumeStartedAt: null, resumeFinishedAt: null,
    sentAt: null, verificationDeadlineAt: null, updatedAt,
  };
}

/** A turn start seen while a send was in flight, noted before the store records it. */
export type TurnObservation = { turnId: string | null; startedAt: string | null };

/** The decision of an event (a permission request, an archive, another turn) that stops a send not yet started. */
// A hold keeps the record's state from before the claim: nothing was sent, and the record sends later on its schedule.
export type ClaimCancel = { state: ResumeState; reason: string; hold?: boolean };

// The send gates that end a usage record. Every other one, such as a pending permission or an attention request, holds
// it until a later sweep.
export const USAGE_ENDING_GATES = ["newer-user-message", "identity-changed", "opted-out", "archived"];

/**
 * One send in flight: what its claim writes, whether its rollback has replaced the claim, and any turn seen meanwhile.
 * The claim is unsent until send() is invoked (sendStarted). Until then a permission request, an archive, or any turn
 * start or end for the agent cancels it, and no turn is attached to its attempt. settled resolves once the send or its
 * cancellation is stored.
 */
export type InFlightClaim = TurnObservation & {
  recordId: string;
  attempt: ResumeAttempt;
  sentAt: string;
  verificationDeadlineAt: string;
  released: boolean;
  cancelled: ClaimCancel | null;
  sendStarted: boolean;
  settled: Promise<void>;
};

/** What the send checks saw of the agent's turns: its latest user message, its running turn, and its last change. */
export type TurnMark = { lastUserMessageAt: string | null; activeTurnId: string | null; updatedAt: string | null };

export function turnMark(agent: AgentSnapshot): TurnMark {
  return { lastUserMessageAt: agent.lastUserMessageAt ?? null, activeTurnId: agent.activeTurn?.turnId ?? null, updatedAt: agent.updatedAt ?? null };
}

// The agent re-read right before send(): the send checks still pass, and its latest user message and turn are the ones
// the claim was taken on. Returns the decision that cancels the send, or null to send.
export function presendCancel(record: ResumeRecord, taken: TurnMark, agent: AgentSnapshot | null, config: ResumeConfig, now = Date.now()): ClaimCancel | null {
  if (!agent) return { state: record.kind === "transient" ? "uncertain" : "superseded", reason: "agent-missing" };
  const mark = turnMark(agent);
  if (mark.lastUserMessageAt !== taken.lastUserMessageAt) return { state: "superseded", reason: "newer-user-message" };
  if (mark.activeTurnId !== taken.activeTurnId || mark.updatedAt !== taken.updatedAt) return { state: "superseded", reason: "turn-changed-before-send" };
  const gate = shouldResume(record, agent, config, now);
  if (gate.ok) return null;
  if (record.kind !== "transient" && !USAGE_ENDING_GATES.includes(gate.reason)) return { state: record.state, reason: gate.reason, hold: true };
  return { state: "uncertain", reason: gate.reason };
}

const isClaimAttempt = (attempt: ResumeAttempt, claim: InFlightClaim) => attempt.messageId === claim.attempt.messageId && attempt.at === claim.attempt.at;

/** The record still carries this claim: resuming, with the claim's own attempt. */
export function holdsClaim(current: ResumeRecord, claim: InFlightClaim): boolean {
  return current.state === "resuming" && current.attempts.some((attempt) => isClaimAttempt(attempt, claim));
}

// Undoes a claim whose send never started because an event or the re-read agent cancelled it: the claim's attempt, send
// time and deadline go. A record still resuming takes that event's decision; a state the event's handler or another writer
// already stored is kept.
export function cancelClaim(current: ResumeRecord, before: ResumeRecord, claim: InFlightClaim, cancel: ClaimCancel, now = Date.now()): ResumeRecord {
  if (!current.attempts.some((attempt) => isClaimAttempt(attempt, claim))) return current;
  return {
    ...current,
    ...(current.state === "resuming" ? cancel.hold ? { state: before.state } : { state: cancel.state, terminalReason: cancel.reason } : {}),
    sentAt: current.sentAt === claim.sentAt ? before.sentAt : current.sentAt,
    verificationDeadlineAt: current.verificationDeadlineAt === claim.verificationDeadlineAt ? before.verificationDeadlineAt : current.verificationDeadlineAt,
    attempts: current.attempts.filter((attempt) => !isClaimAttempt(attempt, claim)),
    updatedAt: new Date(now).toISOString(),
  };
}

// Applies a turn start seen for an in-flight claim to the claim's record. While the record still carries the claim,
// the turn is attached. Once the claim's rollback is stored (released, record parked again), the message may have
// reached the daemon after all: the claim's attempt, send time and deadline come back with the turn, and the record
// turns uncertain. Every other state, including a terminal one another handler wrote, is kept.
export function applyClaimTurn(current: ResumeRecord, claim: InFlightClaim, now = Date.now()): ResumeRecord {
  if (!claim.turnId) return current;
  const updatedAt = new Date(now).toISOString();
  if ((current.state === "resuming" || current.state === "verifying") && !current.resumeTurnId) {
    return { ...current, resumeTurnId: claim.turnId, resumeStartedAt: claim.startedAt, updatedAt };
  }
  if (current.state !== "parked" || !claim.released) return current;
  const kept = current.attempts.some((attempt) => attempt.messageId === claim.attempt.messageId && attempt.at === claim.attempt.at);
  return {
    ...current,
    state: "uncertain",
    sentAt: claim.sentAt,
    verificationDeadlineAt: claim.verificationDeadlineAt,
    attempts: kept ? current.attempts : [...current.attempts, claim.attempt],
    resumeTurnId: claim.turnId,
    resumeStartedAt: claim.startedAt,
    terminalReason: "turn-started-during-failed-send",
    updatedAt,
  };
}

// Undoes a send claim after the transport refused the message. It starts from the current stored value and resets only
// the fields the claim set, so a concurrent writer's changes survive. A turn that started after the claim, whether the
// store already holds it or only the in-flight observation does, means the message may have reached the daemon after
// all, so the record turns uncertain with that turn kept instead of being re-armed for a second send.
export function releaseClaim(current: ResumeRecord, before: ResumeRecord, claimed: ResumeRecord, observed: TurnObservation | null = null, now = Date.now()): ResumeRecord {
  if (current.state !== "resuming") return current;
  const updatedAt = new Date(now).toISOString();
  const storedTurn = current.resumeTurnId && current.resumeTurnId !== before.resumeTurnId ? current.resumeTurnId : null;
  const turnId = storedTurn ?? observed?.turnId ?? null;
  if (turnId) {
    const resumeStartedAt = storedTurn ? current.resumeStartedAt : observed?.startedAt ?? null;
    return { ...current, state: "uncertain", resumeTurnId: turnId, resumeStartedAt, terminalReason: "turn-started-during-failed-send", updatedAt };
  }
  const claimAttempt = claimed.attempts.at(-1);
  return {
    ...current,
    state: before.state,
    sentAt: current.sentAt === claimed.sentAt ? before.sentAt : current.sentAt,
    verificationDeadlineAt: current.verificationDeadlineAt === claimed.verificationDeadlineAt ? before.verificationDeadlineAt : current.verificationDeadlineAt,
    attempts: current.attempts.filter((attempt) => !(attempt.messageId === claimAttempt?.messageId && attempt.at === claimAttempt.at)),
    updatedAt,
  };
}

/** A distinct turn on a newer external message replaces the old work, not its failure signature or retry attempt. */
export function supersedeForNewUserTurn(record: ResumeRecord, agent: AgentSnapshot, turnId: string | null | undefined, timeline: readonly AgentTimelineItem[], now = Date.now()): ResumeRecord {
  if (!isActive(record) || !turnId || turnId === record.sourceTurnId || turnId === record.resumeTurnId) return record;
  if (!isSameAgentAndSession(record, agent) || !agent.lastUserMessageAt || agent.lastUserMessageAt === record.lastUserMessageAt) return record;
  const user = lastUserMessage(timeline);
  // The plugin's own send also advances lastUserMessageAt. A missing start observation must not turn its failure
  // into an unrelated record or reset its backoff/attempt count. Incomplete evidence keeps the old recovery path.
  if (!user || isOwnLatestMessage(record, user)) return record;
  return { ...record, state: "superseded", terminalReason: "newer-user-message", updatedAt: new Date(now).toISOString() };
}

/**
 * After a verified PM fallback swap or restore, the agent's active record follows it to the new profile in the same
 * session, so the existing resume engine continues the work there instead of reading the change as a new identity.
 * The quota hold belonged to the old pool and a usage resume is due now; transient backoff is kept.
 */
export function rebindRecord(record: ResumeRecord, agent: AgentSnapshot, now = Date.now()): ResumeRecord {
  if (!isActive(record) || record.agentId !== agent.id || agent.persistence?.sessionId !== record.persistenceSessionId || agent.provider !== record.provider) return record;
  const model = agent.model ?? agent.persistence?.metadata?.model;
  if (typeof model !== "string" || !model) return record;
  return {
    ...record,
    model,
    modeId: agent.currentModeId ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? null,
    nativeHandle: agent.persistence.nativeHandle ?? null,
    configFingerprint: configFingerprint(agent),
    quotaHold: null,
    // Quota evidence belongs to the model that refused: it never follows the record to another one, nor back after a
    // round trip without a new refusal there.
    ...(model !== record.model ? { refusedPool: null } : {}),
    notBefore: record.kind === "transient" ? record.notBefore : new Date(Math.min(Date.parse(record.notBefore), now)).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export function shouldResume(record: ResumeRecord, agent: AgentSnapshot, config: ResumeConfig, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (record.state !== "parked" && record.state !== "detected") return { ok: false, reason: `state=${record.state}` };
  // No attempt count ends a record; only the backoff (repeating its last step) spaces the sends. The one exception is
  // a prompt-timeout resend, which goes out at most once.
  if (record.rpcTimeout && attemptCount(record) > 0) return { ok: false, reason: "rpc-timeout-resent" };
  if (Date.parse(record.notBefore) > now) return { ok: false, reason: "not-due" };
  // A failed turn leaves the agent in "error"; a send starts a fresh turn in the same session. "closed" is an agent whose
  // runtime is not loaded, which is every agent after a daemon restart; the send loads it again. Only an archive or a
  // delete ends the work.
  if (agent.status !== "idle" && agent.status !== "closed" && !((record.failedOutcome || record.usageFailedOutcome) && agent.status === "error")) return { ok: false, reason: `agent-status=${agent.status}` };
  if (agent.activeTurn) return { ok: false, reason: "active-turn" };
  if ((agent.pendingPermissions?.length ?? 0) > 0) return { ok: false, reason: "pending-permission" };
  // "finished" and "error" are Paseo's unread markers after a turn ends (an errored agent always carries "error"); only input requests block a resume.
  if (agent.requiresAttention && agent.attentionReason !== "finished" && !((record.failedOutcome || record.usageFailedOutcome) && agent.attentionReason === "error")) return { ok: false, reason: "requires-attention" };
  if (agent.archivedAt) return { ok: false, reason: "archived" };
  if (isOptedOut(agent, config)) return { ok: false, reason: "opted-out" };
  if (!isSameAgentAndSession(record, agent)) return { ok: false, reason: "identity-changed" };
  if ((agent.lastUserMessageAt ?? null) !== record.lastUserMessageAt) return { ok: false, reason: "newer-user-message" };
  return { ok: true };
}

export function verificationDecision(record: ResumeRecord, agent: AgentSnapshot, now = Date.now()): { state: "pending" | "done" | "uncertain" | "superseded"; reason: string } {
  if (!isSameAgentAndSession(record, agent)) return { state: "superseded", reason: "identity-changed" };
  if ((agent.lastUserMessageAt ?? null) !== record.lastUserMessageAt) return { state: "superseded", reason: "newer-user-message" };
  if (agent.pendingPermissions?.length) return { state: "uncertain", reason: "pending-permission" };
  if (record.state === "resuming") return { state: "uncertain", reason: "send-state-unreconciled" };
  if (record.resumeTurnId && agent.activeTurn?.turnId === record.resumeTurnId) return { state: "pending", reason: "resumed-turn-active" };
  if (agent.activeTurn) return { state: "uncertain", reason: "different-active-turn" };
  if (!record.resumeTurnId) return { state: "uncertain", reason: "resume-turn-not-observed" };
  if (!record.resumeFinishedAt) return { state: "uncertain", reason: "resume-turn-end-not-observed" };
  if (record.verificationDeadlineAt && Date.parse(record.verificationDeadlineAt) < now) return { state: "uncertain", reason: "verification-timeout" };
  if (agent.status !== "idle") return { state: "uncertain", reason: `agent-status=${agent.status}` };
  return { state: "done", reason: "resumed-turn-completed" };
}

export function continuationPrompt(record: ResumeRecord): string {
  return `The previous turn ended because the provider reported a usage limit. Continue the existing task from the current workspace and conversation state. Do not repeat completed side effects. Inspect current state first, then continue with the next unfinished step. If the limit is still active, stop and report it. [auto-resume:${record.recordId}]`;
}

export function messageId(record: ResumeRecord): string {
  return `${record.recordId}:attempt:${attemptCount(record) + 1}`;
}

/** The exact text a send for this record carries. */
export function resumePrompt(record: ResumeRecord): string {
  return record.kind === "transient" ? record.retryPrompt! : continuationPrompt(record);
}

// True when the newest user row is the record's latest automatic message: its stable ID and the exact text it sent.
export function isOwnLatestMessage(record: ResumeRecord, user: Extract<AgentTimelineItem, { type: "user_message" }> | null): boolean {
  const sent = record.attempts.at(-1);
  return !!sent && !!user && (user.messageId ?? user.clientMessageId) === sent.messageId && user.text === resumePrompt(record);
}
